"""Observe the selected OpenCode TUI route, not the most recently edited session."""
import json
import os
from pathlib import Path
import sqlite3
import time

if __package__:
    from backend import agent_sessions as sessions
else:
    import agent_sessions as sessions


def database(record):
    return Path(record["home"]) / "opencode.db"


def exists(record):
    identifier = sessions.native_id("opencode", record.get("session_id"))
    if not identifier or not database(record).is_file():
        return False
    try:
        with sqlite3.connect(database(record).as_uri() + "?mode=ro", uri=True, timeout=.5) as db:
            row = db.execute("SELECT directory, parent_id FROM session WHERE id = ?", (identifier,)).fetchone()
        return bool(row and not row[1] and Path(row[0]).resolve() == Path(record["cwd"]).resolve())
    except (sqlite3.Error, OSError, ValueError):
        return False


def prepare(sid, record, root):
    # Keep global/project settings and plugins intact. This extra file is local
    # to the launch and uses no SDK imports or package installation.
    settings = {}
    original = os.environ.get("OPENCODE_TUI_CONFIG", "")
    if original:
        settings = json.loads(Path(original).read_text())
    if not isinstance(settings, dict):
        raise ValueError("OpenCode TUI settings must be an object")
    plugin = Path(__file__).with_name("opencode_observer.mjs").resolve().as_uri()
    settings.setdefault("plugin", []).append(plugin)
    suffix = "-" + record["run"] + "-tui.json"
    sessions.save(sid, settings, root, suffix=suffix)
    os.environ["OPENCODE_TUI_CONFIG"] = str(sessions.runtime_dir(root) / (sid + suffix))
    os.environ["CC_WEB_OPENCODE_OBSERVATION"] = str(sessions.runtime_dir(root) / (sid + ".route.json"))


def refresh(sid, record, root=None, final=False):
    observation = sessions.load(sid, root, suffix=".route.json")
    if observation.get("run") != record.get("run"):
        return record
    if final:
        if sessions.same_process(record) or observation.get("pid") not in record.get("observer_pids", []):
            return record
    elif not sessions.same_process(record) or observation.get("pid") not in sessions.descendants(record["pid"]):
        return record
    identifier = sessions.native_id("opencode", observation.get("session_id"))
    with sessions.lock(sid, root=root):
        latest = sessions.load(sid, root)
        if latest.get("run") != record.get("run"):
            return latest
        if latest.get("route_order", -1) >= observation.get("order", 0):
            return latest
        if (latest.get("hook_seen") and latest.get("session_id") == identifier
                and (not identifier or latest.get("cwd") == observation.get("cwd"))
                and observation.get("pid") in latest.get("observer_pids", [])):
            return latest
        # Home/new/subagent routes must not masquerade as the old conversation.
        latest.update(session_id=identifier, hook_seen=True, route_order=observation.get("order", 0))
        latest["observer_pids"] = list({*latest.get("observer_pids", []), observation["pid"]})
        if identifier and observation.get("cwd"):
            latest["cwd"] = observation["cwd"]
        sessions.remember(sid, latest, root)
        return latest


def active(record, sid, root=None):
    observation = sessions.load(sid, root, suffix=".route.json")
    return (observation.get("run") == record.get("run")
            and 0 <= time.time() - observation.get("at", 0) < 3
            and observation.get("session_id") == record.get("session_id"))
