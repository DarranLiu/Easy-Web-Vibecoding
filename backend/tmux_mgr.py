"""Thin wrapper over tmux — tmux is the live-process layer.

Each CC terminal is a tmux session named ``cc_<id>``. The session runs the
user's shell, into which we launch the selected agent command. Because the
process lives in tmux (not in this backend), it survives the browser/WebSocket
disconnecting and this backend restarting. Killing the session stops the
process; the *tab* that remembers it lives in store.py so it can be restarted.
"""
import secrets
import subprocess
from datetime import datetime

SESSION_PREFIX = "cc_"


def _tmux(args, **kw):
    return subprocess.run(["tmux", *args], capture_output=True, text=True, **kw)


def gen_id() -> str:
    return secrets.token_hex(3)  # 6 hex chars


def session_name(sid: str) -> str:
    return f"{SESSION_PREFIX}{sid}"


def session_exists(name: str) -> bool:
    return _tmux(["has-session", "-t", name]).returncode == 0


def start_session(sid: str, cwd: str, launch_cmd: str = "", opts: dict = None) -> str:
    """Create the tmux session for a tab. launch_cmd is sent into the shell
    (empty = plain shell); opts sets @-options (e.g. type, mode)."""
    name = session_name(sid)
    if session_exists(name):
        return name  # already running

    r = _tmux(["new-session", "-d", "-s", name, "-c", cwd])
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "tmux new-session failed")

    created = datetime.now().isoformat(timespec="seconds")
    _tmux(["set-option", "-t", name, "@cwd", cwd])
    _tmux(["set-option", "-t", name, "@created", created])
    _tmux(["set-option", "-t", name, "status", "off"])
    _tmux(["set-option", "-t", name, "history-limit", "10000"])
    for k, v in (opts or {}).items():
        _tmux(["set-option", "-t", name, "@" + k, str(v)])

    if launch_cmd:
        _tmux(["send-keys", "-t", name, launch_cmd, "Enter"])
    return name


def list_sessions() -> list:
    """Live tmux sessions with the cc_ prefix and their metadata."""
    fmt = "\t".join(["#{session_name}", "#{@cwd}", "#{@mode}", "#{@created}", "#{@type}", "#{session_attached}"])
    r = _tmux(["list-sessions", "-F", fmt])
    if r.returncode != 0:
        return []

    out = []
    for line in r.stdout.splitlines():
        parts = line.split("\t")
        name = parts[0] if parts else ""
        if not name.startswith(SESSION_PREFIX):
            continue
        out.append({
            "id": name[len(SESSION_PREFIX):],
            "name": name,
            "cwd": parts[1] if len(parts) > 1 else "",
            "mode": parts[2] if len(parts) > 2 else "",
            "created": parts[3] if len(parts) > 3 else "",
            "type": (parts[4] if len(parts) > 4 and parts[4] else "claude"),
            "attached": int(parts[5]) if len(parts) > 5 and parts[5].isdigit() else 0,
        })
    return out


def kill_session(name: str) -> bool:
    return _tmux(["kill-session", "-t", name]).returncode == 0


def exit_copy_mode(name: str) -> bool:
    """Leave tmux copy-mode (scrollback view) so keystrokes reach the app again.
    No-op / harmless if the pane isn't currently in a mode."""
    return _tmux(["send-keys", "-t", name, "-X", "cancel"]).returncode == 0


def scroll_session(name: str, lines: int) -> bool:
    """Scroll tmux pane history for an attached browser terminal.

    Negative lines scroll up into history, positive lines scroll back down.
    This keeps mouse wheel events from being interpreted by full-screen TUIs
    such as Codex as application-local history navigation.
    """
    try:
        n = int(lines)
    except (TypeError, ValueError):
        return False
    if n == 0:
        return False
    count = min(200, max(1, abs(n)))
    direction = "scroll-up" if n < 0 else "scroll-down"
    if _tmux(["copy-mode", "-e", "-t", name]).returncode != 0:
        return False
    return _tmux(["send-keys", "-t", name, "-X", "-N", str(count), direction]).returncode == 0
