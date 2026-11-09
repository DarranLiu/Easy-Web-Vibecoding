"""Reboot recovery intent and a cross-backend, serial, exact-session queue."""
import hashlib
import json
import time
import uuid

from backend import agent_sessions as sessions
from backend import store, terminal_artifacts, tmux_mgr

SUFFIX = ".continuity.json"


def signature(record):
    return hashlib.sha256(json.dumps({key: record.get(key) for key in (
        "run", "agent", "session_id", "cwd", "home", "args", "environment", "permission_mode"
    )}, sort_keys=True).encode()).hexdigest()


def observe(sid, record):
    """Called only under the operation lock, after foreground/ID verification."""
    if not record.get("session_id") or not sessions.same_process(record) or record.get("ambiguous"):
        disarm(sid)
        return
    previous = sessions.load(sid, suffix=SUFFIX)
    key = signature(record)
    executable = terminal_artifacts.identity(f"/proc/{record['pid']}/exe")
    if (previous.get("signature") == key and previous.get("boot") == sessions.boot_id()
            and previous.get("armed") and previous.get("executable") == executable):
        return
    artifact = terminal_artifacts.capture(record)
    if not record.get("boot"):
        with sessions.lock(sid):
            latest = sessions.load(sid)
            if signature(latest) != key or not sessions.same_process(latest):
                return
            latest["boot"] = sessions.boot_id()
            sessions.remember(sid, latest)
    value = {"armed": True, "boot": sessions.boot_id(), "signature": key,
             "artifact": artifact, "executable": executable, "observed": time.time(), "state": "watching"}
    sessions.save(sid, value, suffix=SUFFIX)


def disarm(sid):
    value = sessions.load(sid, suffix=SUFFIX)
    if value and value.get("armed"):
        value.update(armed=False, state="stopped")
        sessions.save(sid, value, suffix=SUFFIX)


def discard_exited(sid):
    value = sessions.load(sid, suffix=SUFFIX)
    if value.get("boot") == sessions.boot_id() and not sessions.same_process(sessions.load(sid)):
        disarm(sid)


def missing(live_ids):
    """Only a successful inventory may disarm same-boot exits."""
    for tab in store.list_tabs():
        sid = tab["id"]
        if sid in live_ids:
            continue
        try:
            with sessions.lock(sid, "operation", blocking=False):
                value = sessions.load(sid, suffix=SUFFIX)
                if value.get("boot") == sessions.boot_id():
                    disarm(sid)
        except BlockingIOError:
            pass


def status(sid, alive, record=None):
    value = sessions.load(sid, suffix=SUFFIX)
    record = record if record is not None else sessions.load(sid)
    matching = value.get("signature") == signature(record)
    old_boot = bool(value.get("boot") and value["boot"] != sessions.boot_id())
    eligible = bool(not alive and old_boot and matching and value.get("armed") and value.get("artifact"))
    current_job = value.get("jobBoot") == sessions.boot_id()
    phase = value.get("state") if current_job else "available" if eligible else "idle"
    return {"eligible": eligible and phase == "available", "state": phase,
            "expected": value["signature"] if eligible else None,
            "message": value.get("message", "") if current_job else ""}


def saved_binary(sid, record):
    value = sessions.load(sid, suffix=SUFFIX)
    if value.get("signature") != signature(record) or not value.get("artifact"):
        return None
    return terminal_artifacts.validate(value["artifact"], record["agent"])


def enqueue(sid, expected):
    from backend.terminal_restart import RestartError
    with sessions.lock(sid, "operation", blocking=False):
        if not store.get_tab(sid):
            raise RestartError("窗口已移除", 404)
        live = {tab["id"] for tab in tmux_mgr.list_sessions()}
        if sid in live:
            return {"state": "attached", "alive": True}
        value = sessions.load(sid, suffix=SUFFIX)
        if value.get("signature") != expected or not expected:
            raise RestartError("恢复记录已改变，请刷新窗口状态")
        # Repeated requests, lost responses and another browser share one job.
        if value.get("jobBoot") == sessions.boot_id():
            return status(sid, False)
        if not status(sid, False)["eligible"]:
            raise RestartError("此窗口未记录服务器重启前的运行状态，需要手动确认恢复")
        value.update(state="queued", jobBoot=sessions.boot_id(), queued=time.time(),
                     requestId=str(uuid.uuid4()), message="等待恢复")
        sessions.save(sid, value, suffix=SUFFIX)
        return status(sid, False)


def run_next():
    """One bounded operation per tick; HTTP and TLS share the flock."""
    from backend import terminal_restart as restart
    try:
        with sessions.lock("continuity_worker", "queue", blocking=False):
            jobs = []
            for tab in store.list_tabs():
                value = sessions.load(tab["id"], suffix=SUFFIX)
                if value.get("jobBoot") == sessions.boot_id() and value.get("state") in {"queued", "restoring"}:
                    jobs.append((value.get("queued", 0), tab, value))
            for _, tab, _ in sorted(jobs, key=lambda item: item[0]):
                sid = tab["id"]
                try:
                    with sessions.lock(sid, "operation", blocking=False):
                        value = sessions.load(sid, suffix=SUFFIX)
                        if not value.get("armed") or value.get("state") not in {"queued", "restoring"}:
                            continue
                        try:
                            live = {item["id"] for item in tmux_mgr.list_sessions()}
                            if sid in live:
                                value.update(state="attached", message="窗口已运行，已连接；请查看终端状态")
                            elif value["state"] == "restoring":
                                value.update(armed=False, state="attention", message="上次恢复被中断，请手动检查；不会重复启动")
                            else:
                                record = sessions.load(sid)
                                if value.get("signature") != signature(record):
                                    raise restart.RestartError("原会话已改变，不会启动其他对话")
                                from backend.main import safe_resolve
                                from fastapi import HTTPException
                                try:
                                    safe_resolve(record["cwd"])
                                except HTTPException as exc:
                                    raise restart.RestartError("原目录已不可访问或不在允许范围内") from exc
                                if not saved_binary(sid, record):
                                    raise restart.RestartError("原运行版本未保存，请手动检查")
                                # Both normal recovery and boot recovery check occupancy.
                                from backend import terminal_recovery
                                if record["session_id"] in terminal_recovery._occupied(record, sid):
                                    raise restart.RestartError("原会话已在其他窗口运行，不会重复启动")
                                preview = restart._inspect(sid, tab)
                                if not preview.get("ready") or preview.get("running") or not preview.get("stopped"):
                                    raise restart.RestartError("窗口状态已改变，不会自动中断任务")
                                value.update(state="restoring", message="正在恢复原会话")
                                sessions.save(sid, value, suffix=SUFFIX)
                                result = restart.restart_locked(sid, tab, {
                                    "requestId": value["requestId"], "expected": preview["expected"],
                                    "savedVersion": True, "backgroundRestore": True,
                                })
                                if result.get("resumed"):
                                    value.update(state="ready", message="原会话已恢复")
                                else:
                                    value.update(armed=False, state="attention", message="窗口已打开，原会话待确认；请查看终端提示")
                        except (OSError, RuntimeError, ValueError) as exc:
                            value.update(armed=False, state="attention", message=str(exc) if isinstance(exc, restart.RestartError)
                                         else "自动恢复未完成，请检查此窗口；不会重复启动")
                        sessions.save(sid, value, suffix=SUFFIX)
                        return
                except BlockingIOError:
                    continue
    except BlockingIOError:
        pass
