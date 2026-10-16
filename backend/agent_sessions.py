"""Private, process-bound native conversation metadata. No account requests."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time
import uuid

SID_RE = re.compile(r"[a-zA-Z0-9_-]{1,64}\Z")
MAX_JSON = 1024 * 1024


def conversation_id(value):
    try:
        return str(uuid.UUID(value)) if isinstance(value, str) else None
    except ValueError:
        return None


def native_id(agent, value):
    if agent == "opencode":
        return value if isinstance(value, str) and re.fullmatch(r"ses_[a-zA-Z0-9]{8,64}", value) else None
    return conversation_id(value)


def remember(sid, record, root=None):
    save(sid, record, root)
    if transcript_exists(record):
        save(sid, record, root, suffix=".saved.json")


def recover_saved(sid):
    record = load(sid)
    if (not same_process(record) and not record.get("session_id") and not record.get("ambiguous")
            and (not record or record.get("launch_failed"))):
        previous = load(sid, suffix=".saved.json")
        if transcript_exists(previous):
            save(sid, previous)
            return previous
    return record


def runtime_dir(root=None):
    if root is None:
        from backend import config
        root = config.AGENT_RUNTIME_DIR
    path = Path(root).absolute()
    if path.is_symlink():
        raise RuntimeError("Agent runtime directory must not be a symlink")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.stat().st_uid != os.getuid():
        raise RuntimeError("Agent runtime directory has an unexpected owner")
    if path.stat().st_mode & 0o777 != 0o700:
        path.chmod(0o700)
    return path


def _file(sid, suffix, root=None):
    if not SID_RE.fullmatch(sid):
        raise ValueError("Invalid terminal ID")
    return runtime_dir(root) / (sid + suffix)


@contextmanager
def lock(sid, kind="state", root=None, blocking=True):
    fd = os.open(_file(sid, "." + kind + ".lock", root),
                 os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield
    finally:
        os.close(fd)


def load(sid, root=None, suffix=".json"):
    try:
        fd = os.open(_file(sid, suffix, root), os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as stream:
            data = json.loads(stream.read(MAX_JSON))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save(sid, data, root=None, suffix=".json"):
    target = _file(sid, suffix, root)
    fd, temporary = tempfile.mkstemp(prefix=".agent-", dir=target.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def process(pid):
    try:
        directory = Path("/proc") / str(int(pid))
        fields = (directory / "stat").read_text().rsplit(")", 1)[1].split()
        if directory.stat().st_uid != os.getuid() or fields[0] in {"Z", "X"}:
            return None
        return {"pid": int(pid), "ppid": int(fields[1]), "pgid": int(fields[2]),
                "tty": int(fields[4]), "foreground": int(fields[5]),
                "start": fields[19], "comm": (directory / "comm").read_text().strip()}
    except (OSError, ValueError, IndexError):
        return None


def same_process(record):
    current = process(record.get("pid", 0))
    return bool(current and current["start"] == record.get("start"))


def environment(pid):
    try:
        values = Path(f"/proc/{int(pid)}/environ").read_bytes().split(b"\0")
        return dict(value.decode(errors="surrogateescape").split("=", 1)
                    for value in values if b"=" in value)
    except OSError:
        return {}


def descendants(pid):
    found = []
    pending = [int(pid)]
    while pending and len(found) < 128:
        parent = pending.pop()
        if parent in found:
            continue
        found.append(parent)
        try:
            pending.extend(int(value) for value in Path(
                f"/proc/{parent}/task/{parent}/children").read_text().split())
        except OSError:
            pass
    return found


def _under(path, directory):
    try:
        path.resolve().relative_to(Path(directory).resolve())
        return True
    except (OSError, ValueError):
        return False


def codex_conversation(record):
    """Use open files owned by this private process tree, never directory recency."""
    if not same_process(record):
        return None
    candidates = {}
    home = Path(record["home"])
    for pid in descendants(record["pid"]):
        info = process(pid)
        if not info or info["comm"] != "codex":
            continue
        for descriptor in Path(f"/proc/{pid}/fd").glob("*"):
            try:
                path = Path(os.readlink(descriptor))
                if (not path.name.startswith("rollout-") or path.suffix != ".jsonl"
                        or not (_under(path, home / "sessions") or _under(path, home / "archived_sessions"))):
                    continue
                with path.open() as stream:
                    entry = json.loads(stream.readline(65536))
                meta = entry.get("payload", {})
                identifier = conversation_id(meta.get("id"))
                if (entry.get("type") != "session_meta" or not identifier
                        or isinstance(meta.get("source"), dict)
                        or not path.name.endswith(identifier + ".jsonl")):
                    continue
                candidates[identifier] = {"session_id": identifier, "transcript": str(path),
                                          "cwd": meta.get("cwd") or record["cwd"],
                                          "provider": meta.get("model_provider", ""), "ambiguous": False}
            except (OSError, ValueError, AttributeError):
                continue
    if len(candidates) == 1:
        return next(iter(candidates.values()))
    if len(candidates) > 1:
        return {"session_id": None, "transcript": None, "ambiguous": True}
    return None


def refresh_codex(sid, record, root=None):
    identity = codex_conversation(record)
    if identity is not None:
        with lock(sid, root=root):
            latest = load(sid, root)
            if latest.get("run") != record.get("run"):
                return latest
            if all(latest.get(key) == value for key, value in identity.items()):
                return latest
            latest.update(identity)
            latest["identity_seen"] = True
            remember(sid, latest, root)
            return latest
    return record


def transcript_exists(record):
    if record.get("agent") == "opencode":
        if __package__:
            from backend import opencode_sessions
        else:
            import opencode_sessions
        return opencode_sessions.exists(record)
    identifier = conversation_id(record.get("session_id"))
    path = Path(record.get("transcript") or "")
    if not identifier or not path.is_file() or not path.name.endswith(identifier + ".jsonl"):
        return False
    home = Path(record["home"])
    locations = [home / "projects"] if record["agent"] == "claude" else [home / "sessions", home / "archived_sessions"]
    try:
        return any(_under(path, directory) for directory in locations) and path.stat().st_size > 0
    except OSError:
        return False


def take_restart_plan(agent):
    value = os.environ.pop("CC_WEB_RESTART_PLAN", "")
    if not value:
        return None
    root = runtime_dir(os.environ.get("CC_WEB_AGENT_RUNTIME_DIR"))
    sid = os.environ.get("CC_WEB_SESSION_ID", "")
    path = Path(value).absolute()
    if (not SID_RE.fullmatch(sid) or path.parent != root or path.is_symlink()
            or not re.fullmatch(re.escape(sid) + r"\.[a-f0-9-]{36}\.plan\.json", path.name)):
        raise ValueError("Invalid restart plan")
    with lock(sid, root=root):
        plan = load(sid, root, suffix=path.name[len(sid):])
        record = load(sid, root)
        if (plan.get("agent") != agent or plan.get("run") != record.get("run")
                or same_process(record) or plan.get("expires", 0) < time.time()
                or not isinstance(plan.get("args"), list)
                or not all(isinstance(arg, str) for arg in plan["args"])):
            raise ValueError("Expired or mismatched restart plan")
        path.unlink()
    if plan.get("binary"):
        binary = plan["binary"]
        stat = os.stat(binary["path"])
        if [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns] != binary["identity"]:
            raise RuntimeError("Native executable changed after preflight")
    for key, val in plan.get("environment", {}).items():
        if (key.startswith("CC_WEB_") or key in {"PATH", "BASH_ENV", "ENV", "HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
                "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_TUI_CONFIG"}) and isinstance(val, str):
            os.environ[key] = val
    os.chdir(plan["cwd"])
    return plan["args"]


def record_process(sid, agent, pid, args, cwd, env, root=None, managed=False):
    info = process(pid)
    if not info:
        raise RuntimeError("Unable to identify agent process")
    home = env.get("CODEX_HOME") if agent == "codex" else env.get("CLAUDE_CONFIG_DIR")
    if agent == "opencode":
        home = str(Path(env.get("XDG_DATA_HOME") or str(Path(env.get("HOME") or Path.home()) / ".local/share")) / "opencode")
    home = home or str(Path(env.get("HOME") or Path.home()) / (".codex" if agent == "codex" else ".claude"))
    record = {"agent": agent, "pid": int(pid), "start": info["start"], "run": uuid.uuid4().hex,
              "args": list(args), "cwd": str(cwd), "home": str(Path(home).expanduser().absolute()),
              "session_id": None, "transcript": None, "hook_seen": False, "managed": managed,
              "launched_at": time.time()}
    directory_keys = ("HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
                      "XDG_STATE_HOME", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_TUI_CONFIG")
    record["environment"] = {key: env[key] for key in directory_keys if env.get(key)}
    if env.get("CC_WEB_OPENCODE_OBSERVATION"):
        record["environment"].pop("OPENCODE_TUI_CONFIG", None)
    base = Path(env.get("HOME") or Path.home())
    record["environment"].setdefault("HOME", str(base))
    record["environment"].setdefault("CODEX_HOME", str(base / ".codex"))
    record["environment"].setdefault("CLAUDE_CONFIG_DIR", str(base / ".claude"))
    for key, suffix in (("XDG_CONFIG_HOME", ".config"), ("XDG_DATA_HOME", ".local/share"), ("XDG_STATE_HOME", ".local/state")):
        record["environment"].setdefault(key, str(base / suffix))
    with lock(sid, root=root):
        previous = load(sid, root)
        if transcript_exists(previous):
            save(sid, previous, root, suffix=".saved.json")
        save(sid, record, root)
    return record


def interactive(agent, args):
    if any(arg in {"--help", "-h", "--version", "-V", "-v"} for arg in args):
        return False
    if agent == "claude" and any(arg in {"--print", "-p", "--bg", "--background", "--cloud", "--desktop"} for arg in args):
        return False
    # Only foreground interactive invocations can replace the window's identity.
    commands = {"codex": {"exec", "e", "review", "debug", "login", "logout", "mcp", "plugin", "features", "sandbox", "completion", "app-server", "doctor", "update", "upgrade", "apply", "a", "archive", "cloud", "help", "agents", "queue", "remote-control"},
                "claude": {"auth", "mcp", "plugin", "install", "update", "upgrade", "doctor", "agents", "attach", "logs", "stop", "kill", "rm", "respawn", "setup-token"},
                "opencode": {"completion", "acp", "mcp", "attach", "run", "debug", "providers", "auth", "agent", "upgrade", "uninstall", "serve", "web", "models", "stats", "export", "import", "github", "pr", "session", "plugin", "plug", "db"}}
    if __package__:
        from backend.terminal_launch import _positional_commands
    else:
        from terminal_launch import _positional_commands
    positionals = _positional_commands(args)
    return not (positionals and positionals[0] in commands.get(agent, set()))


def prepare_launch(agent, args):
    sid = os.environ.get("CC_WEB_SESSION_ID", "")
    root = os.environ.get("CC_WEB_AGENT_RUNTIME_DIR", "")
    if (agent not in {"codex", "claude", "opencode"} or not SID_RE.fullmatch(sid) or not root
            or not interactive(agent, args) or not os.isatty(0)
            or os.tcgetpgrp(0) != os.getpgrp()):
        return list(args)
    inherited = load(sid, root)
    if (inherited.get("run") == os.environ.get("CC_WEB_AGENT_RUN")
            and str(inherited.get("pid")) == os.environ.get("CC_WEB_AGENT_PID")
            and same_process(inherited)):
        return list(args)
    record = record_process(sid, agent, os.getpid(), args, os.getcwd(), os.environ, root, managed=True)
    os.environ["CC_WEB_AGENT_RUN"] = record["run"]
    os.environ["CC_WEB_AGENT_PID"] = str(record["pid"])
    result = list(args)
    if agent == "opencode":
        if __package__:
            from backend import opencode_sessions
        else:
            import opencode_sessions
        opencode_sessions.prepare(sid, record, root)
    if agent == "claude":
        # Additional settings are launch-local; do not edit user/project hooks.
        settings = {}
        for index, arg in enumerate(result):
            if arg == "--settings" and index + 1 < len(result):
                value = result[index + 1]
                settings = json.loads(value if value.lstrip().startswith("{") else Path(value).read_text())
            elif arg.startswith("--settings="):
                value = arg.partition("=")[2]
                settings = json.loads(value if value.lstrip().startswith("{") else Path(value).read_text())
        if not isinstance(settings, dict):
            raise ValueError("Claude settings must be an object")
        hooks = settings.setdefault("hooks", {})
        command = shlex.join([sys.executable, str(Path(__file__).resolve()), "hook"])
        for event in ("SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "PostToolUse"):
            hooks.setdefault(event, []).append({"hooks": [{"type": "command", "command": command, "timeout": 3}]})
        path = runtime_dir(root) / (sid + "-" + record["run"] + "-settings.json")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(settings, stream)
        cleaned = []
        index = 0
        while index < len(result):
            if result[index] == "--settings":
                index += 2
                continue
            if not result[index].startswith("--settings="):
                cleaned.append(result[index])
            index += 1
        result = [*cleaned, "--settings", str(path)]
    subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "watch", sid, record["run"], root],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     close_fds=True, start_new_session=True)
    return result


def handle_hook(payload, env=None):
    env = env or os.environ
    sid, root, run = env.get("CC_WEB_SESSION_ID", ""), env.get("CC_WEB_AGENT_RUNTIME_DIR", ""), env.get("CC_WEB_AGENT_RUN", "")
    if not SID_RE.fullmatch(sid) or not root or not isinstance(payload, dict) or payload.get("agent_id"):
        return
    identifier = conversation_id(payload.get("session_id"))
    if not identifier:
        return
    with lock(sid, root=root):
        record = load(sid, root)
        if record.get("run") != run or not same_process(record) or record.get("agent") != "claude":
            return
        if str(record["pid"]) != env.get("CC_WEB_AGENT_PID"):
            return
        # Reject child-agent callbacks and order events by the native hook branch,
        # not by when Python happened to finish. Old turn hooks cannot undo /clear.
        caller = process(os.getpid())
        branch = caller
        for _ in range(128):
            if not caller or caller["pid"] == record["pid"]:
                break
            if caller["comm"] in {"claude", "codex"}:
                return
            branch = caller
            caller = process(caller["ppid"])
        if not caller or caller["pid"] != record["pid"]:
            return
        event = payload.get("hook_event_name")
        if event not in {"SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "PostToolUse"}:
            return
        if event != "SessionStart" and identifier != record.get("session_id"):
            return
        order = [int(branch["start"]), branch["pid"]]
        if order < record.get("hook_order", [0, 0]):
            return
        path = Path(payload.get("transcript_path") or "")
        if not _under(path, Path(record["home"]) / "projects") or path.name != identifier + ".jsonl":
            return
        record.update(session_id=identifier, transcript=str(path), hook_seen=True, hook_order=order)
        record["activity"] = {
            "phase": {"SessionStart": "idle", "UserPromptSubmit": "working", "Stop": "complete",
                      "PermissionRequest": "needs_attention", "PostToolUse": "working"}[event],
            "event": event, "at": time.time(), "run": run,
        }
        if payload.get("cwd"):
            record["cwd"] = payload["cwd"]
        if payload.get("permission_mode") in {"default", "acceptEdits", "plan", "dontAsk", "bypassPermissions", "auto", "manual"}:
            record["permission_mode"] = payload["permission_mode"]
        remember(sid, record, root)


def watch(sid, run, root):
    while True:
        record = load(sid, root)
        if record.get("run") != run or not same_process(record):
            if record.get("run") == run and record.get("agent") == "opencode":
                if __package__:
                    from backend import opencode_sessions
                else:
                    import opencode_sessions
                opencode_sessions.refresh(sid, record, root, final=True)
            break
        if record["agent"] == "codex":
            refresh_codex(sid, record, root)
        elif record["agent"] == "opencode":
            if __package__:
                from backend import opencode_sessions
            else:
                import opencode_sessions
            opencode_sessions.refresh(sid, record, root)
        time.sleep(.5)
    path = runtime_dir(root) / (sid + "-" + run + "-settings.json")
    path.unlink(missing_ok=True)
    (runtime_dir(root) / (sid + "-" + run + "-tui.json")).unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        if sys.argv[1] == "hook":
            handle_hook(json.loads(sys.stdin.read(65536)))
        elif sys.argv[1] == "watch":
            watch(*sys.argv[2:5])
    except (OSError, ValueError, RuntimeError, IndexError):
        # Metadata failure must not alter prompts, permissions or model requests.
        sys.exit(0)
