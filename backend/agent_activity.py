"""Local, process-bound activity signals. Never scrapes screen text or polls models."""
from datetime import datetime
import json
import os
from pathlib import Path
import time

from backend import agent_sessions

_cache = {}
PHASES = {"working", "idle", "needs_attention", "complete", "error"}


def _started(record):
    if record.get("launched_at"):
        return float(record["launched_at"])
    try:
        return time.time() - time.clock_gettime(time.CLOCK_BOOTTIME) + int(record["start"]) / os.sysconf("SC_CLK_TCK")
    except (ValueError, KeyError, OSError):
        return time.time()


def _codex(record):
    if not agent_sessions.transcript_exists(record):
        return None
    path = Path(record["transcript"])
    try:
        stat = path.stat()
        key = (record.get("run"), str(path), stat.st_ino, stat.st_size, stat.st_mtime_ns)
        if key in _cache:
            return _cache[key]
        with path.open("rb") as stream:
            offset = max(0, stat.st_size - 128 * 1024)
            stream.seek(offset)
            if offset:
                stream.readline()
            rows = stream.read(128 * 1024).splitlines()
        activity = None
        for row in rows:
            try:
                event = json.loads(row)
                if event.get("type") != "event_msg":
                    continue
                payload = event.get("payload", {})
                phase = {"task_started": "working", "task_complete": "complete", "turn_aborted": "idle", "error": "error"}.get(payload.get("type"))
                stamp = datetime.fromisoformat(event.get("timestamp", "").replace("Z", "+00:00")).timestamp()
                if phase and stamp >= _started(record):
                    activity = {"phase": phase, "updatedAt": stamp, "source": "codex-event",
                                "eventKey": f'{record.get("run")}:{payload.get("type")}:{stamp}'}
            except (ValueError, TypeError, AttributeError):
                continue
        if len(_cache) >= 128:
            _cache.clear()
        _cache[key] = activity
        return activity
    except (OSError, KeyError):
        return None


def status(sid, alive, record=None):
    record = record if record is not None else agent_sessions.load(sid)
    if not alive:
        return {"phase": "offline", "source": "tmux", "updatedAt": None}
    if not agent_sessions.same_process(record):
        return {"phase": "online", "source": "tmux", "updatedAt": None}
    if record.get("agent") == "claude":
        activity = record.get("activity", {})
        if activity.get("phase") in PHASES and activity.get("run") == record.get("run"):
            return {"phase": activity["phase"], "source": "claude-hook", "updatedAt": activity["at"],
                    "eventKey": f'{record["run"]}:{activity["event"]}:{activity["at"]}'}
    if record.get("agent") == "codex":
        activity = _codex(record)
        if activity:
            return activity
    return {"phase": "online", "source": "native-process", "updatedAt": None}
