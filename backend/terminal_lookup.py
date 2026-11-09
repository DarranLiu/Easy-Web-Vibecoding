"""Exact-ID lookup and explicit resume. Never use recency or interrupt an agent."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid

from backend import agent_sessions as sessions, store, terminal_launch, tmux_mgr
from backend import terminal_recovery as recovery, terminal_restart as restart

MAX_CONTEXTS = 64
MAX_MATCHES = 50
PENDING_MESSAGE = "窗口已启动，原会话尚未确认加载。请在终端完成目录信任等启动确认；不会重复启动或自动确认。"


def identifier(value):
    if not isinstance(value, str) or not (sessions.SID_RE.fullmatch(value.strip()) or sessions.native_id("opencode", value.strip())):
        raise restart.RestartError("请输入完整的窗口 ID 或原生会话 ID", 400)
    value = value.strip()
    return sessions.conversation_id(value) or value


def _allowed(path, resolve):
    try:
        return str(resolve(path)) if isinstance(path, str) and Path(path).is_absolute() else None
    except (OSError, ValueError, RuntimeError):
        return None
    except Exception as exc:
        if getattr(exc, "status_code", None) == 403:
            return None
        raise


def _contexts(records):
    base = Path(os.environ.get("HOME") or Path.home())
    env = {key: os.environ[key] for key in terminal_launch.DIRECTORY_ENV if key in os.environ}
    defaults = {"codex": Path(env.get("CODEX_HOME") or base / ".codex"),
                "claude": Path(env.get("CLAUDE_CONFIG_DIR") or base / ".claude"),
                "opencode": Path(env.get("XDG_DATA_HOME") or base / ".local/share") / "opencode"}
    found = {}
    sources = [(agent, home, env) for agent, home in defaults.items()]
    sources.extend((r.get("agent"), r.get("home"), r.get("environment", {})) for r in records)
    for agent, home, environment in sources:
        if agent not in defaults or not home or not isinstance(environment, dict):
            continue
        try:
            home = str(Path(home).expanduser().resolve())
        except (OSError, ValueError, TypeError, RuntimeError):
            continue
        found.setdefault((agent, home), {"agent": agent, "home": home,
            "environment": {k: v for k, v in environment.items() if k in terminal_launch.DIRECTORY_ENV and isinstance(v, str)}})
        if len(found) > MAX_CONTEXTS:
            raise restart.RestartError("本地配置目录过多，请使用网页窗口 ID 定位")
    return list(found.values())


def _file_cwd(path, context, native):
    if not recovery._regular(path, Path(context["home"])):
        return None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as stream:
            remaining = 512 * 1024
            for _ in range(200 if context["agent"] == "claude" else 1):
                line = stream.readline(min(65536, remaining))
                remaining -= len(line)
                if not line or remaining <= 0:
                    break
                try:
                    item = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(item, dict):
                    continue
                if context["agent"] == "codex":
                    meta = item.get("payload")
                    if item.get("type") == "session_meta" and isinstance(meta, dict) and meta.get("id") == native:
                        return meta.get("cwd")
                elif item.get("sessionId") == native and not item.get("isSidechain") and item.get("cwd"):
                    return item["cwd"]
    except (OSError, ValueError, UnicodeError):
        pass
    return None


def _history(context, native, resolve):
    home, agent = Path(context["home"]), context["agent"]
    if agent == "opencode":
        dbpath = home / "opencode.db"
        if not recovery._regular(dbpath, home):
            return []
        try:
            with sqlite3.connect(dbpath.as_uri() + "?mode=ro", uri=True, timeout=.5) as db:
                row = db.execute("SELECT directory FROM session WHERE id=? AND parent_id IS NULL", (native,)).fetchone()
            cwd = _allowed(row[0], resolve) if row else None
            if not cwd:
                return []
            candidates, _ = recovery._scan({**context, "cwd": cwd}, native)
            return [{**item, "cwd": cwd} for item in candidates]
        except sqlite3.Error:
            raise restart.RestartError("无法读取本地 OpenCode 历史，请检查记录格式和权限")
    roots = [home / "projects"] if agent == "claude" else [home / "sessions", home / "archived_sessions"]
    pattern = "*/" + native + ".jsonl" if agent == "claude" else "**/rollout-*" + native + ".jsonl"
    result = []
    for root in roots:
        for path in root.glob(pattern):
            cwd = _allowed(_file_cwd(path, context, native), resolve)
            item = recovery._jsonl(path, {**context, "cwd": cwd}) if cwd else None
            if item:
                result.append({**item, "cwd": cwd})
                if len(result) > MAX_MATCHES:
                    raise restart.RestartError("同一 ID 对应过多本地记录，不能唯一确认")
    return result


def _pending_claude(sid, record):
    """Recognize launch intent, never claim the transcript is loaded before a hook."""
    if (record.get("agent") != "claude" or not record.get("managed") or record.get("session_id")
            or record.get("hook_seen") or record.get("ambiguous") or record.get("launch_failed")):
        return None
    saved = sessions.load(sid, suffix=".saved.json")
    operation = sessions.load(sid, suffix=".operation.json")
    if (not sessions.conversation_id(operation.get("requestId")) or operation.get("result")
            or not saved.get("session_id") or operation.get("sessionId") != saved["session_id"]
            or record.get("run") == saved.get("run")
            or any(record.get(k) != saved.get(k) for k in ("agent", "home", "cwd"))
            or not operation.get("started") or record.get("launched_at", 0) < operation["started"]
            or not sessions.transcript_exists(saved) or not sessions.same_process(record)):
        return None
    try:
        # The managed launcher records arguments before injecting its hook settings.
        # Only an exact restart of the saved dialog qualifies, not a later CLI run.
        if record.get("args") != restart.resume_arguments(saved):
            return None
        pane = restart._existing_pane(sid)
        foreground = restart._foreground(pane) if pane else None
        if not foreground or any(foreground.get(k) != record.get(k) for k in ("pid", "start")) or foreground.get("comm") != "claude":
            return None
    except (restart.RestartError, OSError, ValueError):
        return None
    return saved


def _pending_result(tab):
    return {**tab, "alive": True, "resumed": False, "resumePending": True, "resumeMessage": PENDING_MESSAGE}


def _window(tab, record, live, native_query, pending=None):
    sid = tab["id"]
    action, reason, preview = "attach", "", None
    agent = record.get("agent") or tab.get("type")
    if pending:
        reason = PENDING_MESSAGE
    elif not live or native_query:
        action = "resume"
        if agent in terminal_launch.AGENTS:
            try:
                preview = restart.inspect(sid, tab)
                if native_query and preview.get("sessionId") != native_query:
                    raise restart.RestartError("当前绑定已变化，请重新查找")
                if not preview.get("ready"):
                    raise restart.RestartError(preview.get("reason") or "此窗口没有可验证的原对话")
                if preview.get("running"):
                    action = "attach"
                record = sessions.load(sid) or record
                if action == "resume" and record.get("session_id") in recovery._occupied(record, sid):
                    raise restart.RestartError("此对话正在其他窗口运行，不能重复启动")
            except (restart.RestartError, terminal_launch.AttachmentBlocked) as exc:
                action, reason = "blocked", str(exc)
        elif agent != "shell":
            action, reason = "blocked", "旧窗口缺少可验证的程序类型，不能自动启动；请先确认原会话"
        elif live:
            action, reason = "blocked", "当前前台不是原对话，不能自动恢复"
    fingerprint = [tab, record.get("run"), record.get("session_id"), record.get("pid"), record.get("start"),
                   live, action, pending.get("session_id") if pending else None, preview.get("expected") if preview else None]
    return {"key": "window_" + sid, "expected": recovery._digest(fingerprint), "id": sid,
            "nativeId": pending["session_id"] if pending else record.get("session_id"), "agent": agent, "cwd": record.get("cwd") or tab["cwd"],
            "name": tab.get("name") or tab.get("title") or sid, "action": action, "reason": reason,
            "resumePending": bool(pending),
            "_tab": tab, "_record": record, "_preview_expected": preview.get("expected") if preview else None}


def _lookup(value, resolve):
    query = identifier(value)
    tabs = store.list_tabs()
    records = {tab["id"]: sessions.load(tab["id"]) for tab in tabs}
    live = {item["id"]: item for item in tmux_mgr.list_sessions()}
    direct = next((t for t in tabs if t["id"] == query), None)
    if not direct and query.startswith(tmux_mgr.SESSION_PREFIX):
        direct = next((t for t in tabs if tmux_mgr.SESSION_PREFIX + t["id"] == query), None)
    matches = []
    for tab in tabs:
        record = records[tab["id"]]
        pending = None
        if tab["id"] in live and (tab == direct or sessions.load(tab["id"], suffix=".saved.json").get("session_id") == query):
            pending = _pending_claude(tab["id"], record)
        if not record or (record.get("launch_failed") and not record.get("session_id") and not record.get("ambiguous")):
            saved = sessions.load(tab["id"], suffix=".saved.json")
            if not live.get(tab["id"]) and sessions.transcript_exists(saved):
                record = saved
        native = sessions.native_id(record.get("agent"), query)
        if tab != direct and (direct or not native or (pending or record).get("session_id") != native or record.get("ambiguous")):
            continue
        if not _allowed(tab.get("cwd"), resolve) or not _allowed(record.get("cwd") or tab.get("cwd"), resolve):
            continue
        match = _window(tab, record, tab["id"] in live, None if direct else native, pending)
        if _allowed(match["cwd"], resolve):
            matches.append(match)
    if matches or direct:
        return query, matches
    for context in _contexts(records.values()):
        native = sessions.native_id(context["agent"], query)
        if not native:
            continue
        candidates = _history(context, native, resolve)
        if not candidates:
            continue
        item = candidates[0]
        occupied = native in recovery._occupied(context, "")
        defaults = "原启动参数未知，将使用当前配置的权限设置" if context["agent"] == "opencode" else "原启动参数未知，将使用当前配置和常规权限"
        reason = "同一 ID 存在多份历史记录，不能唯一确认" if len(candidates) != 1 else "此对话正在其他原生终端运行，请先在那里退出" if occupied else defaults
        key = restart._conversation_key({**context, "session_id": native})
        title = recovery._codex_titles(context["home"]).get(native) if context["agent"] == "codex" else None
        matches.append({"key": key, "expected": recovery._digest([key, [c["candidateKey"] for c in candidates], occupied]),
            "id": None, "nativeId": native, "agent": context["agent"], "cwd": item["cwd"],
            "name": title or item["title"], "action": "blocked" if len(candidates) != 1 or occupied else "import",
            "reason": reason, "_context": context, "_candidate": item})
    return query, matches


def inspect(value, resolve):
    query, matches = _lookup(value, resolve)
    return {"query": query, "matches": [{k: v for k, v in m.items() if not k.startswith("_")} for m in matches]}


def copy_identity(sid, tab, resolve):
    """Resolve one explicit clipboard request without launching or sending input."""
    if not _allowed(tab.get("cwd"), resolve):
        raise restart.RestartError("此窗口目录不在允许范围内", 403)
    try:
        with sessions.lock(sid, "operation", blocking=False):
            record = sessions.load(sid)
            pending = _pending_claude(sid, record)
            if pending:
                native, agent, state = pending["session_id"], pending["agent"], "pending"
            else:
                pane = restart._existing_pane(sid)
                foreground = restart._foreground(pane) if pane else None
                if tab.get("type") == "shell" and record.get("agent") not in terminal_launch.AGENTS and not foreground:
                    return {"id": sid, "value": tmux_mgr.session_name(sid), "kind": "window", "state": "running" if pane else "stopped"}
                preview = restart._inspect(sid, tab)
                if not preview.get("ready"):
                    raise restart.RestartError(preview.get("reason") or "尚未识别到此窗口的原生会话 ID")
                record = sessions.load(sid)
                native, agent = preview.get("sessionId"), preview.get("agent")
                if native != record.get("session_id"):
                    raise restart.RestartError("会话已切换，请重新点击复制")
                state = "running" if preview.get("running") else "stopped"
            if not _allowed(record.get("cwd"), resolve):
                raise restart.RestartError("此会话目录不在允许范围内", 403)
            native = sessions.native_id(agent, native)
            if not native or agent not in terminal_launch.AGENTS:
                raise restart.RestartError("尚未识别到有效的原生会话 ID")
            return {"id": sid, "value": native, "kind": "native", "agent": agent, "state": state}
    except BlockingIOError:
        raise restart.RestartError("此窗口正在处理其他操作，请稍后再复制")


def open_session(body, resolve, start_shell):
    query = identifier(body.get("query"))
    if body.get("confirmed") is not True or not sessions.conversation_id(body.get("requestId")):
        raise restart.RestartError("恢复并分屏需要明确确认和有效请求编号", 400)
    # Shared by HTTP/TLS workers; concurrent clicks cannot import the same ID twice.
    lock_id = "lookup_" + hashlib.sha256(query.encode()).hexdigest()[:48]
    try:
        with sessions.lock(lock_id, "operation", blocking=False):
            _, matches = _lookup(query, resolve)
            selected = next((m for m in matches if m["key"] == body.get("key")), None)
            if not selected or selected["expected"] != body.get("expected"):
                raise restart.RestartError("会话状态或历史已变化，请重新查找后确认")
            if selected["action"] == "blocked":
                raise restart.RestartError(selected["reason"])
            if selected["action"] == "attach":
                tab = selected["_tab"]
                live = next((s for s in tmux_mgr.list_sessions() if s["id"] == tab["id"]), None)
                if not live:
                    raise restart.RestartError("窗口已停止，请重新查找后确认")
                if selected.get("resumePending"):
                    if not _pending_claude(tab["id"], sessions.load(tab["id"])):
                        raise restart.RestartError("窗口状态已变化，请重新查找；不会重复启动")
                    return _pending_result(tab)
                return {**live, **tab, "alive": True}
            if not Path(selected["cwd"]).is_dir():
                raise restart.RestartError("原目录已不存在，无法恢复")
            tab = selected.get("_tab")
            if tab is None:
                sid = "id_" + selected["key"].removeprefix("dialog_")[:24]
                if store.get_tab(sid) or tmux_mgr.session_exists("=" + tmux_mgr.session_name(sid)) or sessions.load(sid):
                    raise restart.RestartError("此对话已有恢复窗口，请刷新列表后重新查找")
                tab = {"id": sid, "cwd": selected["cwd"], "type": selected["agent"], "mode": "resume",
                       "created": time.strftime("%Y-%m-%dT%H:%M:%S"), "title": Path(selected["cwd"]).name,
                       "name": selected["name"] if selected["name"] != selected["nativeId"] else ""}
                context, candidate = selected["_context"], selected["_candidate"]
                record = {**context, "cwd": selected["cwd"], "run": uuid.uuid4().hex, "pid": 0, "start": "",
                    "session_id": selected["nativeId"], "transcript": candidate["transcript"],
                    "args": {"codex": ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
                             "claude": ["--permission-mode", "default"], "opencode": []}[selected["agent"]],
                    "bound": True, "history_bound": True, "ambiguous": False, "bound_at": time.time()}
                terminal_launch.guarded_arguments(record["agent"], restart.resume_arguments(record), {})
                sessions.remember(sid, record)
                store.add_tab(tab)
            sid = tab["id"]
            with sessions.lock(sid, "operation", blocking=False):
                if selected["agent"] == "shell":
                    return start_shell(sid)
                if selected["agent"] not in terminal_launch.AGENTS:
                    raise restart.RestartError("程序类型无法确认，不能自动启动")
                preview = restart._inspect(sid, tab)
                if not preview.get("ready") or preview.get("running") or preview.get("sessionId") != selected["nativeId"]:
                    raise restart.RestartError("窗口状态已变化，请重新查找；不会中断正在运行的程序")
                if selected.get("_preview_expected") and selected["_preview_expected"] != preview.get("expected"):
                    raise restart.RestartError("会话配置或绑定已变化，请重新查找后确认")
                record = sessions.load(sid)
                with sessions.lock(restart._conversation_key(record), "conversation", blocking=False):
                    if record.get("session_id") in recovery._occupied(record, sid):
                        raise restart.RestartError("此对话正在其他窗口运行，不能重复启动")
                    # Unlike restart, opening an ID never authorizes an interruption.
                    try:
                        return restart._restart_locked(sid, tab, {"expected": preview["expected"],
                            "requestId": body["requestId"], "confirmed": False})
                    except restart.RestartError:
                        operation = sessions.load(sid, suffix=".operation.json")
                        pending = _pending_claude(sid, sessions.load(sid))
                        if (operation.get("requestId") == body["requestId"] and pending
                                and pending["session_id"] == selected["nativeId"]):
                            return _pending_result(tab)
                        raise
    except BlockingIOError:
        raise restart.RestartError("此会话正在处理其他操作，请稍后重新查找")
