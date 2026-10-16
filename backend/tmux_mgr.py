"""Thin wrapper over tmux — tmux is the live-process layer.

Each CC terminal is a tmux session named ``cc_<id>``. The session runs the
user's shell, into which we launch the selected agent. Because the process lives in
tmux (not in this backend), it survives the browser/WebSocket disconnecting and
this backend restarting. Killing the session stops the process; the *tab* that
remembers it lives in store.py so it can be restarted later.
"""
import secrets
import subprocess
import time
from datetime import datetime

from backend import terminal_launch

SESSION_PREFIX = "cc_"


def _tmux(args, **kw):
    return subprocess.run(["tmux", *args], capture_output=True, text=True, **kw)


def gen_id() -> str:
    return secrets.token_hex(3)  # 6 hex chars


def session_name(sid: str) -> str:
    return f"{SESSION_PREFIX}{sid}"


def session_exists(name: str) -> bool:
    return _tmux(["has-session", "-t", name]).returncode == 0


def start_session(sid: str, cwd: str, launch_cmd: str = "", opts: dict = None, environment_override=None) -> str:
    """Create the tmux session for a tab. launch_cmd is sent into the shell
    (empty = plain shell); opts sets @-options (e.g. type, mode)."""
    name = session_name(sid)
    if session_exists(name):
        return name  # already running

    try:
        environment = terminal_launch.session_environment()
    except (OSError, RuntimeError) as exc:
        raise RuntimeError("Unable to prepare isolated web terminal launchers") from exc
    environment["CC_WEB_SESSION_ID"] = sid
    environment.update(environment_override or {})
    args = ["new-session", "-d", "-s", name, "-c", cwd]
    for key, value in environment.items():
        args.extend(["-e", f"{key}={value}"])
    r = _tmux(args)
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
    fmt = "\t".join(["#{session_name}", "#{@cwd}", "#{@mode}", "#{@created}", "#{@type}", "#{session_attached}", "#{@web_scrollback}"])
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
            "codexScrollback": len(parts) > 6 and parts[6] == "1",
        })
    return out


def kill_session(name: str) -> bool:
    return _tmux(["kill-session", "-t", name]).returncode == 0


def exit_copy_mode(name: str) -> bool:
    """Leave tmux copy-mode (scrollback view) so keystrokes reach the app again.
    No-op / harmless if the pane isn't currently in a mode."""
    return _tmux(["send-keys", "-t", name, "-X", "cancel"]).returncode == 0


class ScrollState:
    """Per-connection remainder for Codex's native three-row wheel steps."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.target = None
        self.remainder = 0
        self.last_at = 0.0

    def wheel_steps(self, target, lines):
        now = time.monotonic()
        if (target != self.target or now - self.last_at > 0.25
                or lines * self.remainder < 0):
            self.remainder = 0
        self.target = target
        self.last_at = now
        self.remainder += lines
        steps = abs(self.remainder) // 3
        self.remainder -= steps * (3 if self.remainder >= 0 else -3)
        return steps


def _foreground_is_codex(tty: str) -> bool:
    """Detect a native Codex child behind a shell/node wrapper, not a background job."""
    if not tty.startswith("/dev/pts/") or not tty[len("/dev/pts/"):].isdigit():
        return False
    try:
        # The web service has no controlling terminal, so tcgetpgrp cannot query
        # this tty. ps exposes its foreground group without opening it or args.
        result = subprocess.run(["ps", "-t", tty, "-o", "tpgid=,pgid=,comm="],
                                capture_output=True, text=True, timeout=1)
        if result.returncode:
            return False
        for line in result.stdout.splitlines():
            fields = line.split()
            if (len(fields) == 3 and fields[0].isdigit() and int(fields[0]) > 0
                    and fields[0] == fields[1] and fields[2] == "codex"):
                return True
    except (OSError, subprocess.TimeoutExpired):
        pass
    return False


def scroll_session(name: str, lines: int, state: ScrollState = None, row: int = 2) -> bool:
    """Scroll the history owned by the pane's current foreground program.

    Negative lines scroll up into history, positive lines scroll back down.
    Inline programs use tmux history. Fullscreen Codex owns its transcript and
    needs native wheel events instead; tmux copy-mode only sees a screen snapshot.
    Keep state for the lifetime of a connection to accumulate sub-step movement.
    """
    try:
        n = int(lines)
    except (TypeError, ValueError):
        return False
    if n == 0:
        return False
    count = min(200, max(1, abs(n)))
    metadata = _tmux([
        "display-message", "-p", "-t", name,
        "#{alternate_on}\t#{pane_mode}\t#{pane_current_command}\t#{pane_height}\t#{pane_tty}",
    ])
    if metadata.returncode != 0:
        return False
    fields = metadata.stdout.strip("\r\n").split("\t")
    if len(fields) not in (4, 5):
        return False
    alternate, mode, command, height = fields[:4]
    tty = fields[4] if len(fields) == 5 else ""
    if alternate == "1" and (command == "codex" or _foreground_is_codex(tty)):
        if mode and mode != "copy-mode":
            return False
        if mode == "copy-mode" and not exit_copy_mode(name):
            return False
        try:
            rows = int(height)
        except ValueError:
            return False
        if rows < 1:
            return False
        if state is None:
            state = ScrollState()
        steps = state.wheel_steps((name, rows), -count if n < 0 else count)
        if not steps:
            return True
        # Codex handles SGR wheel reports even when outer mouse tracking is off.
        # Preserve the browser's pointer row. A midpoint can hit the composer;
        # row one can hit Codex's sticky prompt header instead of its transcript.
        button = 64 if n < 0 else 65
        try:
            pointer_row = max(1, min(rows, int(row)))
        except (TypeError, ValueError):
            pointer_row = min(rows, 2)
        report = f"\x1b[<{button};1;{pointer_row}M"
        result = _tmux(["send-keys", "-t", name, "-l", "--", report * steps])
        if result.returncode != 0:
            state.reset()
        return result.returncode == 0

    if state is not None:
        state.reset()
    direction = "scroll-up" if n < 0 else "scroll-down"
    if _tmux(["copy-mode", "-e", "-t", name]).returncode != 0:
        return False
    return _tmux(["send-keys", "-t", name, "-X", "-N", str(count), direction]).returncode == 0
