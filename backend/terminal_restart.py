"""Restart one foreground agent in its existing tmux pane, by exact UUID."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import time

from backend import agent_sessions as sessions
from backend import config, terminal_launch, terminal_preflight, tmux_mgr


class RestartError(RuntimeError):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


def _pane(sid):
    if not sessions.SID_RE.fullmatch(sid):
        raise RestartError("终端编号无效", 400)
    name = tmux_mgr.session_name(sid)
    result = tmux_mgr._tmux(["list-panes", "-t", "=" + name, "-F",
                           "#{pane_id}|#{pane_pid}|#{pane_tty}|#{pane_current_path}"])
    rows = result.stdout.strip().splitlines() if result.returncode == 0 else []
    if len(rows) != 1:
        raise RestartError("终端已停止或包含多个原生 pane，不能自动重启")
    parts = rows[0].split("|", 3)
    if len(parts) != 4 or not parts[1].isdigit() or not parts[2].startswith("/dev/pts/"):
        raise RestartError("无法确认终端归属")
    return {"id": parts[0], "pid": int(parts[1]), "tty": parts[2], "cwd": parts[3]}


def _existing_pane(sid):
    if not sessions.SID_RE.fullmatch(sid):
        raise RestartError("终端编号无效", 400)
    if not tmux_mgr.session_exists("=" + tmux_mgr.session_name(sid)):
        return None
    return _pane(sid)


def _foreground(pane):
    root = sessions.process(pane["pid"])
    if not root:
        raise RestartError("终端进程已退出")
    agents = []
    for pid in sessions.descendants(root["pid"]):
        info = sessions.process(pid)
        if (info and info["tty"] == root["tty"] and info["pgid"] == info["foreground"]
                and info["comm"] in {"codex", "claude", "opencode"}):
            agents.append(info)
    if len(agents) > 1:
        # Keep the root agent, not its same-group helper children.
        agents = [item for item in agents if not any(
            item["pid"] in sessions.descendants(other["pid"])[1:] for other in agents if item != other)]
    if len(agents) > 1:
        raise RestartError("检测到多个前台程序，不能自动重启")
    if agents:
        return agents[0]
    if root["pgid"] != root["foreground"]:
        raise RestartError("当前前台是其他程序，不能发送重启命令")
    return None


def _arguments(pid):
    try:
        args = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        return [value.decode() for value in args[1:] if value]
    except (OSError, UnicodeError):
        raise RestartError("无法读取原程序的启动参数")


def _record(sid, tab, pane, foreground):
    record = sessions.recover_saved(sid) if not foreground else sessions.load(sid)
    if foreground:
        agent = foreground["comm"]
        if record.get("pid") != foreground["pid"] or record.get("start") != foreground["start"]:
            args = _arguments(foreground["pid"])
            record = sessions.record_process(sid, agent, foreground["pid"], args,
                                             pane["cwd"], sessions.environment(foreground["pid"]))
        if record.get("agent") != agent:
            raise RestartError("前台程序与会话记录不一致")
        if agent == "codex":
            identity = sessions.codex_conversation(record)
            if identity is None:
                raise RestartError("尚未识别到此 Codex 的可恢复会话，请稍后重试")
            record = sessions.refresh_codex(sid, record)
            if "--no-daemon" not in _arguments(foreground["pid"]):
                # Older embedded CLIs can own their rollout directly. A shared
                # daemon client's files are not in this foreground process tree.
                if not identity.get("session_id"):
                    raise RestartError("旧 Codex 没有唯一、直接持有的会话，不能安全迁移")
        elif agent == "opencode":
            from backend import opencode_sessions
            record = opencode_sessions.refresh(sid, record)
    elif not record:
        raise RestartError("此终端没有已记录的原生会话")
    elif sessions.same_process(record):
        raise RestartError("原程序仍在后台运行，不能重复启动同一会话")
    elif record.get("agent") == "opencode":
        from backend import opencode_sessions
        record = opencode_sessions.refresh(sid, record, final=True)
    if record.get("agent") not in terminal_launch.AGENTS:
        raise RestartError("此程序暂不支持原会话恢复", 400)
    if not Path(record.get("cwd", "")).is_dir():
        raise RestartError("原会话目录已不存在")
    return record


_COMMON_VALUES = {"--model", "-m", "--add-dir", "--profile", "--agent", "--settings", "--effort",
                  "--permission-mode", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
                  "--mcp-config", "--system-prompt", "--system-prompt-file", "--append-system-prompt",
                  "--append-system-prompt-file", "--agents", "--tools", "--betas", "--plugin-dir",
                  "--setting-sources", "--name", "-n", "--fallback-model", "--autocompact", "--debug-file",
                  "--system-prompt-snapshot", "--advisor"}
_CODEX_VALUES = {"--config", "-c", "--enable", "--disable", "--local-provider", "-p", "--sandbox", "-s",
                 "--ask-for-approval", "-a", "--image", "-i"}
_BOOLEAN = {"--no-daemon", "--no-alt-screen", "--oss", "--approve-for-me", "--search", "--strict-config",
            "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust",
            "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--strict-mcp-config",
            "--chrome", "--no-chrome", "--ide", "--bare", "--safe-mode", "--restricted", "--verbose",
            "--ax-screen-reader", "--disable-slash-commands", "--brief", "--exclude-dynamic-system-prompt-sections"}


def resume_arguments(record):
    """Keep operational flags; discard prompts, pickers, forks and new worktrees."""
    agent, args = record["agent"], record.get("args", [])
    if agent == "opencode":
        result, index = [], 0
        values = {"--model", "-m", "--agent", "--log-level", "--replay-limit"}
        flags = {"--auto", "--mini", "--no-replay", "--print-logs"}
        while index < len(args):
            arg = args[index]
            name = arg.split("=", 1)[0]
            if name in {"--session", "-s", "--prompt", "--port", "--hostname", "--cors", "--mdns-domain"}:
                index += 1 if "=" in arg else 2
                continue
            if name in {"--continue", "-c", "--fork", "--mdns"} or not arg.startswith("-"):
                index += 1
                continue
            if name in values:
                result.append(arg)
                if "=" not in arg:
                    index += 1
                    if index >= len(args):
                        raise RestartError("原启动参数不完整")
                    result.append(args[index])
            elif name in flags:
                result.append(arg)
            else:
                raise RestartError("原 OpenCode 参数不能可靠恢复：" + name)
            index += 1
        identifier = sessions.native_id(agent, record.get("session_id"))
        if not identifier:
            raise RestartError("尚未记录 OpenCode 当前对话编号")
        return [*result, "--session", identifier, "--port", "0", "--hostname", "127.0.0.1"]
    values = _COMMON_VALUES | (_CODEX_VALUES if agent == "codex" else set())
    result = []
    index = 0
    while index < len(args):
        arg = args[index]
        name = arg.split("=", 1)[0]
        if arg == "--":
            break
        if not arg.startswith("-"):
            # Positional commands/session IDs/prompts must never be re-sent.
            index += 1
            continue
        remove_values = {"-C", "--cd"} if agent == "codex" else {"--resume", "-r", "--session-id", "--from-pr"}
        remove_flags = {"--last", "--all", "--include-non-interactive", "--worktree", "--no-daemon", "--no-alt-screen"} if agent == "codex" else {"--continue", "-c", "--fork-session", "--worktree", "-w", "--tmux"}
        if name in remove_values:
            index += 1 if "=" in arg else 2
            continue
        if name in remove_flags:
            index += 1
            continue
        if name in values:
            result.append(arg)
            if "=" not in arg:
                if index + 1 >= len(args):
                    raise RestartError("原启动参数不完整")
                index += 1
                result.append(args[index])
                if name in {"--add-dir", "--image", "-i", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--tools", "--mcp-config"}:
                    while index + 1 < len(args) and not args[index + 1].startswith("-"):
                        index += 1
                        result.append(args[index])
        elif name in _BOOLEAN:
            result.append(arg)
        else:
            raise RestartError("原程序包含暂不支持自动恢复的启动参数：" + name)
        index += 1
    identifier = sessions.conversation_id(record.get("session_id"))
    if not identifier:
        raise RestartError("原生会话编号无效")
    if agent == "codex":
        # A transcript's original provider may predate the current launch config.
        # Keep actual launch overrides; never force routing from old session metadata.
        return ["resume", identifier, *result, "-C", record["cwd"]]
    return [*result, "--resume", identifier]


def _expected(sid, pane, record):
    fields = [sid, pane["id"] if pane else None, pane["pid"] if pane else None, record.get("run"), record.get("pid"), record.get("start"),
              record.get("session_id"), record.get("cwd"), record.get("args")]
    return hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()


def _ensure_identity(sid, record):
    with sessions.lock(sid):
        latest = sessions.load(sid)
        if any(latest.get(key) != record.get(key) for key in ("run", "pid", "start", "session_id", "cwd", "args")):
            raise RestartError("原会话已改变，已取消继续重启；请重新确认")


def inspect(sid, tab):
    if is_mutating(sid):
        raise RestartError("此终端正在执行其他管理操作")
    return _inspect(sid, tab)


def _inspect(sid, tab):
    pane = _existing_pane(sid)
    foreground = _foreground(pane) if pane else None
    record = _record(sid, tab, pane, foreground)
    if record.get("ambiguous"):
        raise RestartError("此程序同时持有多个会话，不能准确判断当前会话；不会猜测或停止它")
    if record["agent"] == "claude":
        args = record.get("args", [])
        if any(arg in {"--bare", "--safe-mode"} for arg in args):
            raise RestartError("此启动方式关闭了会话钩子，不能可靠验证自动恢复")
        for index, arg in enumerate(args):
            if arg == "--settings" and index + 1 < len(args):
                path = Path(args[index + 1])
                if not record.get("managed") and path.parent == config.AGENT_RUNTIME_DIR and path.name.endswith("-settings.json"):
                    raise RestartError("原始启动记录缺失且程序依赖临时设置，不能安全自动重启")
    if record["agent"] == "claude" and not record.get("hook_seen") and not record.get("bound"):
        return {"ready": False, "canBind": bool(foreground), "reason": "此旧窗口尚未记录会话 ID，需要先绑定原会话", "agent": "claude"}
    if record["agent"] == "opencode" and not record.get("hook_seen") and not record.get("bound"):
        return {"ready": False, "canBind": bool(foreground), "reason": "此旧窗口尚未记录 OpenCode 当前对话，请先绑定会话编号", "agent": "opencode"}
    if record["agent"] == "opencode" and not record.get("session_id"):
        raise RestartError("OpenCode 当前停在主页或未选择对话，不会恢复另一个旧对话")
    if record["agent"] == "opencode" and foreground and record.get("hook_seen"):
        from backend import opencode_sessions
        if not opencode_sessions.active(record, sid):
            raise RestartError("OpenCode 当前会话跟踪已失效，不能确认此刻选中的对话；不会停止程序")
    if not sessions.transcript_exists(record):
        raise RestartError("尚无可恢复的会话记录，或记录已被删除；不会停止此终端")
    arguments = resume_arguments(record)
    # Validate isolation before even interrupting the old process.
    terminal_launch.guarded_arguments(record["agent"], arguments, {})
    return {"ready": True, "running": bool(foreground), "agent": record["agent"],
            "sessionId": record["session_id"], "expected": _expected(sid, pane, record), "stopped": pane is None}


def bind(sid, tab, identifier):
    pane = _pane(sid)
    foreground = _foreground(pane)
    record = _record(sid, tab, pane, foreground)
    identifier = sessions.native_id(record["agent"], identifier)
    if not identifier:
        raise RestartError("请输入完整、有效的原生会话编号", 400)
    if not foreground or record["agent"] not in {"claude", "opencode"} or record.get("hook_seen"):
        raise RestartError("此窗口不需要手动绑定，或前台状态已改变")
    if record["agent"] == "opencode":
        candidate = {**record, "session_id": identifier}
        if not sessions.transcript_exists(candidate):
            raise RestartError("会话编号与此窗口的本地记录、工作目录不匹配", 400)
        with sessions.lock(sid):
            latest = sessions.load(sid)
            if latest.get("run") != record["run"] or not sessions.same_process(record):
                raise RestartError("窗口状态已经改变，请重新确认")
            latest.update(session_id=identifier, bound=True)
            sessions.remember(sid, latest)
        return _inspect(sid, tab)
    matches = list((Path(record["home"]) / "projects").glob("*/" + identifier + ".jsonl"))
    if len(matches) != 1:
        raise RestartError("没有找到唯一的本地会话记录", 400)
    path = matches[0]
    matched = False
    with path.open() as stream:
        for _ in range(500):
            line = stream.readline(65536)
            if not line:
                break
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if item.get("sessionId") == identifier and item.get("cwd") == record["cwd"]:
                matched = True
                break
    if not matched:
        raise RestartError("会话记录与此窗口的工作目录不匹配", 400)
    with sessions.lock(sid):
        latest = sessions.load(sid)
        if latest.get("run") != record["run"] or not sessions.same_process(record):
            raise RestartError("窗口状态已经改变，请重新确认")
        latest.update(session_id=identifier, transcript=str(path), bound=True)
        sessions.remember(sid, latest)
    return _inspect(sid, tab)


def is_mutating(sid):
    fd = None
    try:
        if not sessions.SID_RE.fullmatch(sid):
            return True
        fd = os.open(config.AGENT_RUNTIME_DIR / (sid + ".operation.lock"), os.O_RDONLY | os.O_NOFOLLOW)
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return False
    except FileNotFoundError:
        return False
    except BlockingIOError:
        return True
    except OSError:
        return True
    finally:
        if fd is not None:
            os.close(fd)


def _send(pane, *keys):
    result = tmux_mgr._tmux(["send-keys", "-t", pane["id"], *keys])
    if result.returncode:
        raise RestartError("终端输入失败，未继续重启")


def _wait(predicate, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(.1)
    return predicate()


def _codex_interrupt_state(sid, pane, record):
    """Closed rollout files can mean shutdown, not a different conversation."""
    _ensure_identity(sid, record)
    if not sessions.same_process(record):
        return "exited"
    current = _pane(sid)
    if any(current[key] != pane[key] for key in ("id", "pid", "tty")):
        raise RestartError("终端归属已改变，已取消继续发送退出操作")
    foreground = _foreground(current)
    if foreground and any(foreground[key] != record[key] for key in ("pid", "start")):
        raise RestartError("前台程序已改变，已取消继续发送退出操作")
    identity = sessions.codex_conversation(record)
    if identity is not None and identity.get("session_id") != record["session_id"]:
        raise RestartError("原会话已改变，已取消继续发送退出操作")
    return "ready" if foreground and identity is not None else "closing"


def restart_locked(sid, tab, body):
    request_id = body.get("requestId", "")
    if not sessions.conversation_id(request_id):
        raise RestartError("重启请求编号无效", 400)
    previous = sessions.load(sid, suffix=".operation.json")
    if previous.get("requestId") == request_id:
        if previous.get("result"):
            return previous["result"]
        raise RestartError(previous.get("error") or "此请求已执行，请刷新窗口状态后重试")
    preview = _inspect(sid, tab)
    if not preview.get("ready"):
        raise RestartError(preview["reason"])
    if body.get("expected") != preview["expected"]:
        raise RestartError("窗口会话已改变，请重新确认后再重启")
    if preview["running"] and body.get("confirmed") is not True:
        raise RestartError("重启可能中断任务，需要明确确认", 400)
    pane, record = _existing_pane(sid), sessions.load(sid)
    arguments = resume_arguments(record)
    launch_env = terminal_launch.session_environment()
    agent = record["agent"]
    binary = launch_env.get("CC_WEB_REAL_" + agent.upper(), "")
    if not binary or not os.path.isfile(binary) or not os.access(binary, os.X_OK):
        raise RestartError("当前原生程序不可用，不会停止旧程序")
    try:
        checked_binary = terminal_preflight.check(agent, binary,
            terminal_launch.guarded_arguments(agent, arguments, launch_env))
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        raise RestartError("启动兼容性检查未通过：" + str(exc)) from exc
    # The install path stays dynamic for future runs. Only this operation uses
    # the artifact whose capabilities were checked before the old task exits.
    overrides = dict(launch_env)
    overrides.update(record.get("environment", {}))
    overrides.update(CC_WEB_SESSION_ID=sid)
    overrides["CC_WEB_REAL_" + agent.upper()] = checked_binary["path"]
    if agent in {"codex", "claude"}:
        overrides["CODEX_HOME" if agent == "codex" else "CLAUDE_CONFIG_DIR"] = record["home"]
    bootstrap = terminal_launch.shell_bootstrap(sid, {**overrides,
        "CC_WEB_REAL_" + agent.upper(): binary})
    if preview["expected"] != _expected(sid, pane, record):
        raise RestartError("窗口状态已经改变，请重试")
    tracked_children = [sessions.process(pid) for pid in sessions.descendants(record["pid"])] if preview["running"] else []
    native = sessions.process(record["pid"])
    tracked_children = [item for item in tracked_children if item and (item["comm"] == agent or
                        native and item["pgid"] == native["pgid"] and item["tty"] == native["tty"])]
    operation = {"requestId": request_id, "started": time.time(), "sessionId": record["session_id"]}
    sessions.save(sid, operation, suffix=".operation.json")
    plan_suffix = "." + sessions.conversation_id(request_id) + ".plan.json"
    plan_path = sessions.runtime_dir() / (sid + plan_suffix)
    try:
        _ensure_identity(sid, record)
        if pane is None:
            tmux_mgr.start_session(sid, record["cwd"], terminal_launch.shell_setup(), {
                "type": agent, "mode": "resume", "web_scrollback": int(agent == "codex" and config.CODEX_SCROLLBACK),
            }, environment_override=overrides)
            pane = _pane(sid)
        if preview["running"]:
            for attempt in range(2):
                if agent == "codex" and attempt:
                    state = ["closing"]
                    def settled():
                        state[0] = _codex_interrupt_state(sid, pane, record)
                        return state[0] != "closing"
                    if not _wait(settled, 12):
                        raise RestartError("Codex 尚未正常退出且无法确认当前会话；未重复发送退出或恢复命令")
                    if state[0] == "exited":
                        break
                foreground = _foreground(_pane(sid))
                if not sessions.same_process(record):
                    break
                if not foreground or foreground["pid"] != record["pid"] or foreground["start"] != record["start"]:
                    raise RestartError("前台程序已改变，已取消继续发送退出操作")
                _ensure_identity(sid, record)
                if agent == "opencode" and record.get("hook_seen"):
                    from backend import opencode_sessions
                    current = opencode_sessions.refresh(sid, record)
                    if not opencode_sessions.active(current, sid) or current.get("session_id") != record["session_id"]:
                        raise RestartError("OpenCode 当前对话或跟踪状态已改变，已取消退出操作")
                if agent == "codex":
                    identity = sessions.codex_conversation(record)
                    if not identity or identity.get("session_id") != record["session_id"]:
                        raise RestartError("原会话已改变，已取消继续发送退出操作")
                tmux_mgr.exit_copy_mode(tmux_mgr.session_name(sid))
                _send(pane, "C-c")
                if _wait(lambda: not sessions.same_process(record), .35):
                    break
            if not _wait(lambda: not sessions.same_process(record), 12):
                raise RestartError("原程序未正常退出；没有强制结束，也没有启动第二个会话")
        if not _wait(lambda: all(not sessions.same_process(item) for item in tracked_children), 8):
            raise RestartError("旧程序的后台仍未退出；为避免会话占用，没有启动新程序")
        _ensure_identity(sid, record)
        def shell_available():
            try:
                current = _pane(sid)
                return current["id"] == pane["id"] and current["pid"] == pane["pid"] and not _foreground(current)
            except RestartError:
                return False

        if not _wait(shell_available, 2):
            raise RestartError("终端尚未回到原来的 Shell，没有发送恢复命令")
        for key, value in {**overrides, "CC_WEB_REAL_" + agent.upper(): binary}.items():
            result = tmux_mgr._tmux(["set-environment", "-t", "=" + tmux_mgr.session_name(sid), key, value])
            if result.returncode:
                raise RestartError("终端环境保存失败，未继续启动")
        # Keep arguments/config overrides in a private, single-use plan, not scrollback.
        sessions.save(sid, {"agent": agent, "run": record["run"], "args": arguments,
                            "cwd": record["cwd"], "environment": overrides, "binary": checked_binary,
                            "expires": time.time() + 60},
                      suffix=plan_suffix)
        command = ". " + shlex.quote(str(bootstrap)) + " && " + shlex.join(["env", "CC_WEB_SESSION_ID=" + sid,
                              "CC_WEB_AGENT_RUNTIME_DIR=" + str(config.AGENT_RUNTIME_DIR.absolute()),
                              "CC_WEB_RESTART_PLAN=" + str(plan_path),
                              str(Path(launch_env["CC_WEB_AGENT_BIN"]) / agent)])
        _send(pane, "C-u")
        _send(pane, "-l", "--", command)
        _send(pane, "Enter")

        def restored():
            latest = sessions.load(sid)
            if latest.get("run") == record["run"] or not sessions.same_process(latest):
                return False
            foreground = _foreground(_pane(sid))
            if not foreground or foreground["pid"] != latest.get("pid"):
                return False
            if agent == "codex":
                latest = sessions.refresh_codex(sid, latest)
            elif agent == "opencode":
                from backend import opencode_sessions
                latest = opencode_sessions.refresh(sid, latest)
            return latest.get("session_id") == record["session_id"] and sessions.transcript_exists(latest)

        if not _wait(restored, 20):
            raise RestartError("恢复命令已发送，但尚未确认原会话加载；请查看此终端，不会重复启动")
        result = {**tab, "alive": True, "attached": 0, "resumed": True,
                  "resumeAgent": agent,
                  "codexScrollback": agent == "codex" and config.CODEX_SCROLLBACK}
        operation["result"] = result
        sessions.save(sid, operation, suffix=".operation.json")
        return result
    except (RestartError, OSError, RuntimeError) as exc:
        operation["error"] = str(exc)
        sessions.save(sid, operation, suffix=".operation.json")
        if isinstance(exc, RestartError):
            raise
        raise RestartError("重启未完成；请检查此终端，未强制结束程序") from exc
    finally:
        plan_path.unlink(missing_ok=True)


def restart(sid, tab, body):
    try:
        with sessions.lock(sid, "operation", blocking=False):
            return restart_locked(sid, tab, body)
    except BlockingIOError:
        raise RestartError("此终端正在重启或执行其他管理操作，请稍后重试")


def snapshot_existing():
    """Metadata only: adopt provable identities without keys, signals or account calls."""
    counts = {"live": 0, "identified": 0, "needs_binding": 0, "unavailable": 0}
    for tab in tmux_mgr.list_sessions():
        sid = tab["id"]
        counts["live"] += 1
        try:
            with sessions.lock(sid, "operation", blocking=False):
                pane = _existing_pane(sid)
                foreground = _foreground(pane) if pane else None
                if not foreground:
                    continue
                record = _record(sid, tab, pane, foreground)
                if sessions.transcript_exists(record):
                    with sessions.lock(sid):
                        latest = sessions.load(sid)
                        if (latest.get("run") == record.get("run")
                                and sessions.load(sid, suffix=".saved.json") != latest):
                            sessions.remember(sid, latest)
                    counts["identified"] += 1
                elif record["agent"] in {"claude", "opencode"} and not record.get("hook_seen"):
                    counts["needs_binding"] += 1
                else:
                    counts["unavailable"] += 1
        except (RestartError, OSError, RuntimeError, ValueError, BlockingIOError):
            counts["unavailable"] += 1
    return counts
