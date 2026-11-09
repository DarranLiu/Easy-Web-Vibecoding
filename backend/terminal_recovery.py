"""Explicit local-history binding for stopped legacy terminals; never launches."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import time
import uuid

from backend import agent_sessions as sessions, config, terminal_launch, terminal_restart as restart

SCAN_LIMIT = 10000
PAGE_SIZE = 50


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def _context(sid, tab):
    if restart._existing_pane(sid) is not None:
        raise restart.RestartError("此窗口已运行，请刷新后直接打开，不会修改其绑定")
    record = sessions.load(sid)
    if sessions.same_process(record):
        raise restart.RestartError("原程序仍在运行，不能重复绑定或启动")
    agent = record.get("agent") or tab.get("type")
    if agent not in terminal_launch.AGENTS:
        raise restart.RestartError("此窗口不需要绑定原生会话", 400)
    cwd = Path(record.get("cwd") or tab.get("cwd") or "").resolve()
    if not cwd.is_dir():
        raise restart.RestartError("原目录已不存在，无法恢复")
    base = Path(os.environ.get("HOME") or Path.home())
    environment = {key: os.environ[key] for key in terminal_launch.DIRECTORY_ENV if key in os.environ}
    environment.update(record.get("environment", {}))
    base = Path(environment.get("HOME") or base)
    default = {"codex": base / ".codex", "claude": base / ".claude",
               "opencode": Path(environment.get("XDG_DATA_HOME") or base / ".local/share") / "opencode"}
    key = {"codex": "CODEX_HOME", "claude": "CLAUDE_CONFIG_DIR"}.get(agent)
    home = Path(record.get("home") or (environment.get(key) if key else None) or default[agent]).expanduser().resolve()
    if key:
        environment[key] = str(home)
    expected = _digest([sid, tab, record, str(cwd), str(home), environment])
    return {"agent": agent, "cwd": str(cwd), "home": str(home), "environment": environment,
            "record": record, "expected": expected}


def _regular(path, home):
    try:
        value = path.lstat()
        path.resolve().relative_to(home)
        return value if stat.S_ISREG(value.st_mode) and value.st_uid == os.getuid() else None
    except (OSError, ValueError):
        return None


def _jsonl(path, context):
    value = _regular(path, Path(context["home"]))
    identifier = sessions.conversation_id(path.stem[-36:])
    if not value or not identifier or not value.st_size:
        return None
    matched, title = False, ""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as stream:
            current = os.fstat(stream.fileno())
            if (current.st_dev, current.st_ino) != (value.st_dev, value.st_ino):
                return None
            # Metadata precedes conversation bodies. Never scan an unbounded log.
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
                    meta = item.get("payload", {})
                    matched = (item.get("type") == "session_meta" and isinstance(meta, dict)
                               and meta.get("id") == identifier and not isinstance(meta.get("source"), dict)
                               and isinstance(meta.get("cwd"), str) and Path(meta["cwd"]).resolve() == Path(context["cwd"]))
                elif item.get("sessionId") == identifier:
                    if item.get("isSidechain"):
                        return None
                    if isinstance(item.get("cwd"), str) and Path(item["cwd"]).resolve() == Path(context["cwd"]):
                        matched = True
                    label = item.get("customTitle") or item.get("slug")
                    if isinstance(label, str):
                        title = label[:120]
        if not matched:
            return None
        fingerprint = [str(path), value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns]
        return {"sessionId": identifier, "title": title or identifier, "updatedAt": value.st_mtime,
                "candidateKey": _digest(fingerprint), "transcript": str(path)}
    except (OSError, ValueError, UnicodeError):
        return None


def _scan(context, identifier=None):
    home, agent = Path(context["home"]), context["agent"]
    if agent == "opencode":
        dbpath = home / "opencode.db"
        if not _regular(dbpath, home):
            return [], False
        try:
            with sqlite3.connect(dbpath.as_uri() + "?mode=ro", uri=True, timeout=.5) as db:
                sql = "SELECT id,title,directory,time_updated FROM session WHERE parent_id IS NULL"
                values = []
                if identifier:
                    sql += " AND id=?"
                    values.append(identifier)
                rows = db.execute(sql + " ORDER BY time_updated DESC LIMIT ?", [*values, SCAN_LIMIT + 1]).fetchall()
            candidates = []
            for sid, title, directory, updated in rows[:SCAN_LIMIT]:
                if sessions.native_id(agent, sid) and Path(directory).resolve() == Path(context["cwd"]):
                    candidates.append({"sessionId": sid, "title": str(title or sid)[:120],
                                       "updatedAt": float(updated or 0) / 1000,
                                       "candidateKey": _digest([sid, directory, updated]), "transcript": None})
            return candidates, len(rows) > SCAN_LIMIT
        except (sqlite3.Error, OSError, ValueError, TypeError):
            raise restart.RestartError("无法读取本地 OpenCode 历史，请检查记录格式和文件权限")
    patterns = ([home / "projects"] if agent == "claude" else [home / "sessions", home / "archived_sessions"])
    candidates, count = {}, 0
    for root in patterns:
        pattern = "*/" + (identifier or "*") + ".jsonl" if agent == "claude" else "**/rollout-*" + (identifier or "") + ".jsonl"
        for path in root.glob(pattern):
            count += 1
            if count > SCAN_LIMIT:
                return list(candidates.values()), True
            candidate = _jsonl(path, context)
            if candidate:
                sid = candidate["sessionId"]
                if sid in candidates:
                    # An ID with multiple local files is not an exact binding.
                    candidates[sid]["duplicate"] = True
                else:
                    candidates[sid] = candidate
    return list(candidates.values()), False


def _occupied(context, sid):
    occupied = set()
    for path in config.AGENT_RUNTIME_DIR.glob("*.json"):
        other = path.stem
        if other == sid or not sessions.SID_RE.fullmatch(other):
            continue
        record = sessions.load(other)
        if (record.get("agent") == context["agent"] and record.get("session_id")
                and Path(record.get("home") or "").resolve() == Path(context["home"])
                and sessions.same_process(record)):
            occupied.add(record["session_id"])
    # Also recognize explicit resumes and open transcript files in SSH/native apps.
    for directory in Path("/proc").glob("[0-9]*"):
        info = sessions.process(directory.name)
        if sessions.native_agent(info) != context["agent"]:
            continue
        try:
            args = (directory / "cmdline").read_bytes().split(b"\0")
            for arg in args:
                identifier = sessions.native_id(context["agent"], arg.decode(errors="replace"))
                if identifier:
                    occupied.add(identifier)
            for fd in (directory / "fd").iterdir():
                try:
                    path = Path(os.readlink(fd)).resolve()
                    path.relative_to(context["home"])
                    identifier = sessions.conversation_id(path.stem[-36:]) if path.suffix == ".jsonl" else None
                    if identifier:
                        occupied.add(identifier)
                except (OSError, ValueError):
                    pass
        except OSError:
            continue
    return occupied


def _codex_titles(home):
    path = Path(home) / "session_index.jsonl"
    if not _regular(path, Path(home)):
        return {}
    names = {}
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            offset = max(0, os.fstat(stream.fileno()).st_size - 1024 * 1024)
            stream.seek(offset)
            if offset:
                stream.readline(65536)
            rows = stream.read(1024 * 1024).splitlines()
        for line in rows:
            try:
                item = json.loads(line)
                if not isinstance(item, dict):
                    continue
                sid = sessions.conversation_id(item.get("id"))
                title = item.get("thread_name")
                if sid and isinstance(title, str) and title.strip():
                    names[sid] = title.strip()[:120]
            except (ValueError, UnicodeError):
                continue
    except OSError:
        pass
    return names


def inspect(sid, tab, query="", offset=0):
    if restart.is_mutating(sid):
        raise restart.RestartError("此终端正在执行其他管理操作")
    if not isinstance(query, str) or len(query) > 160 or type(offset) is not int or not 0 <= offset <= SCAN_LIMIT:
        raise restart.RestartError("历史查询无效", 400)
    context = _context(sid, tab)
    candidates, truncated = _scan(context)
    if context["agent"] == "codex":
        names = _codex_titles(context["home"])
        for item in candidates:
            item["title"] = names.get(item["sessionId"], item["title"])
    candidates = [item for item in candidates if query.lower() in (item["sessionId"] + " " + item["title"]).lower()]
    candidates.sort(key=lambda item: (-item["updatedAt"], item["sessionId"]))
    page = candidates[offset:offset + PAGE_SIZE]
    occupied = _occupied(context, sid)
    for item in page:
        item["inUse"] = item["sessionId"] in occupied
        item.pop("transcript", None)
    return {"agent": context["agent"], "cwd": context["cwd"], "expected": context["expected"],
            "candidates": page, "total": len(candidates), "hasMore": len(candidates) > offset + PAGE_SIZE,
            "truncated": truncated, "defaultsUsed": "args" not in context["record"]}


def bind(sid, tab, body):
    if body.get("confirmed") is not True:
        raise restart.RestartError("绑定原对话需要明确确认", 400)
    context = _context(sid, tab)
    if body.get("expected") != context["expected"]:
        raise restart.RestartError("窗口状态已改变，请重新读取本地历史")
    identifier = sessions.native_id(context["agent"], body.get("sessionId"))
    if not identifier:
        raise restart.RestartError("会话编号无效", 400)
    candidates, _ = _scan(context, identifier)
    matches = [item for item in candidates if item["sessionId"] == identifier and not item.get("duplicate")]
    if len(matches) != 1 or matches[0]["candidateKey"] != body.get("candidateKey"):
        raise restart.RestartError("历史记录已改变或无法唯一确认，请重新选择")
    candidate = matches[0]
    if identifier in _occupied(context, sid):
        raise restart.RestartError("此对话正在其他窗口运行，不能重复启动")
    original = context["record"]
    args = original.get("args", {"codex": ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
                                 "claude": ["--permission-mode", "default"], "opencode": []}[context["agent"]])
    if not isinstance(args, list) or any(not isinstance(arg, str) for arg in args):
        raise restart.RestartError("原启动参数格式无效，不能安全恢复")
    record = {**original, "agent": context["agent"], "cwd": context["cwd"], "home": context["home"],
              "environment": context["environment"], "args": args, "run": uuid.uuid4().hex,
              "pid": 0, "start": "", "session_id": identifier, "transcript": candidate["transcript"],
              "bound": True, "ambiguous": False, "history_bound": True, "bound_at": time.time()}
    record.pop("launch_failed", None)
    if "args" not in original:
        record.pop("permission_mode", None)
    restart._validate_claude(record)
    terminal_launch.guarded_arguments(record["agent"], restart.resume_arguments(record), {})
    with sessions.lock(sid):
        if _context(sid, tab)["expected"] != context["expected"]:
            raise restart.RestartError("窗口状态已改变，请重新读取")
        sessions.remember(sid, record)
    return restart._inspect(sid, tab)
