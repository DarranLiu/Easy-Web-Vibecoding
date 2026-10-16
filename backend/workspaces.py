"""Private, revisioned workspace metadata; never owns native terminal processes."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid

DB = Path(os.environ.get("CC_WEB_WORKSPACE_DB", str(Path.home() / ".cache/cc-web-workspaces/state.sqlite3")))
KEY = re.compile(r"[a-zA-Z0-9_-]{1,64}\Z")


class WorkspaceError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


@contextmanager
def connection():
    DB.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if DB.parent.is_symlink() or DB.is_symlink():
        raise WorkspaceError("Workspace storage must not be a symbolic link", 503)
    if DB.parent.stat().st_uid != os.getuid():
        raise WorkspaceError("Workspace storage has a different owner", 503)
    fd = os.open(DB, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if os.fstat(fd).st_uid != os.getuid():
            raise WorkspaceError("Workspace database has a different owner", 503)
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)
    db = sqlite3.connect(DB, timeout=5)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA foreign_keys=ON")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS workspaces (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL,
                members TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
                revision INTEGER NOT NULL DEFAULT 1, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS layouts (
                workspace TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                device TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL,
                PRIMARY KEY(workspace, device));
            CREATE TABLE IF NOT EXISTS device_layouts (
                device TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY, sid TEXT NOT NULL, phase TEXT NOT NULL,
                source TEXT NOT NULL, time REAL NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
        """)
        db.execute("BEGIN IMMEDIATE")
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def _public(row):
    return {**dict(row), "members": json.loads(row["members"]), "pinned": bool(row["pinned"])}


def _get(db, wid):
    row = db.execute("SELECT * FROM workspaces WHERE id=?", (wid,)).fetchone()
    if not row:
        raise WorkspaceError("Workspace not found", 404)
    return row


def _revision(row, expected):
    if type(expected) is not int or expected != row["revision"]:
        raise WorkspaceError("Workspace changed in another window; reload before saving", 409)


def _name(value):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 80 or any(ord(c) < 32 for c in value):
        raise WorkspaceError("Workspace name must contain 1-80 printable characters")
    return value.strip()


def _members(value):
    if not isinstance(value, list) or len(value) > 128 or any(not isinstance(s, str) or not KEY.fullmatch(s) for s in value):
        raise WorkspaceError("Invalid terminal membership")
    return list(dict.fromkeys(value))


def listing(tabs=()):
    with connection() as db:
        if not db.execute("SELECT 1 FROM metadata WHERE key='imported'").fetchone():
            projects = {}
            for tab in tabs:
                projects.setdefault(tab.get("cwd", ""), []).append(tab["id"])
            existing = db.execute("SELECT COUNT(*) FROM workspaces").fetchone()[0]
            if not existing:
                for cwd, ids in projects.items():
                    db.execute("INSERT INTO workspaces(id,name,cwd,members,created) VALUES(?,?,?,?,?)",
                               (uuid.uuid4().hex[:12], Path(cwd).name or "Workspace", cwd, json.dumps(ids), time.time()))
            if projects or existing:
                db.execute("INSERT INTO metadata VALUES('imported','1')")
        return [_public(row) for row in db.execute("SELECT * FROM workspaces ORDER BY pinned DESC, created, id")]


def create(name, cwd, members=()):
    name, members = _name(name), _members(list(members))
    with connection() as db:
        if db.execute("SELECT COUNT(*) FROM workspaces").fetchone()[0] >= 128:
            raise WorkspaceError("Workspace limit reached")
        wid = uuid.uuid4().hex[:12]
        db.execute("INSERT INTO workspaces(id,name,cwd,members,created) VALUES(?,?,?,?,?)",
                   (wid, name, cwd, json.dumps(members), time.time()))
        db.execute("INSERT OR IGNORE INTO metadata VALUES('imported','1')")
        return _public(_get(db, wid))


def update(wid, body, known):
    with connection() as db:
        row = _get(db, wid)
        _revision(row, body.get("revision"))
        name = _name(body.get("name", row["name"]))
        members = _members(body.get("members", json.loads(row["members"])))
        if not set(members).issubset(known):
            raise WorkspaceError("A selected terminal no longer exists", 409)
        pinned = body.get("pinned", bool(row["pinned"]))
        if type(pinned) is not bool:
            raise WorkspaceError("Invalid pinned setting")
        db.execute("UPDATE workspaces SET name=?,members=?,pinned=?,revision=revision+1 WHERE id=?",
                   (name, json.dumps(members), int(pinned), wid))
        # A removed member cannot reappear from another device's saved layout.
        removed = set(json.loads(row["members"])) - set(members)
        layouts = db.execute("SELECT * FROM layouts WHERE workspace=?", (wid,)).fetchall() if removed else []
        for layout in layouts:
            value = json.loads(layout["body"])
            value["panes"] = [sid if sid in members else None for sid in value["panes"]]
            if value.get("active") not in members:
                value["active"] = None
            db.execute("UPDATE layouts SET body=?,revision=revision+1 WHERE workspace=? AND device=?",
                       (json.dumps(value), wid, layout["device"]))
        return _public(_get(db, wid))


def delete(wid, expected):
    with connection() as db:
        _revision(_get(db, wid), expected)
        db.execute("DELETE FROM workspaces WHERE id=?", (wid,))


def _layout_body(body, permitted):
    ids = body.get("panes")
    if (not isinstance(ids, list) or len(ids) > 4 or
            any(sid is not None and (not isinstance(sid, str) or sid not in permitted) for sid in ids)):
        raise WorkspaceError("Layout contains an unavailable terminal")
    nonempty = [sid for sid in ids if sid is not None]
    if len(set(nonempty)) != len(nonempty):
        raise WorkspaceError("A terminal may only appear once in a layout")
    direction = body.get("direction", "auto")
    if direction not in {"auto", "row", "col"}:
        raise WorkspaceError("Invalid split direction")
    ratios = body.get("ratios", {})
    if not isinstance(ratios, dict) or set(ratios) - {"cols", "rows"}:
        raise WorkspaceError("Invalid split ratios")
    for values in ratios.values():
        if not isinstance(values, list) or len(values) > 4 or any(type(v) not in (int, float) or not 0.05 <= v <= 20 for v in values):
            raise WorkspaceError("Invalid split ratios")
    active = body.get("active")
    if active is not None and active not in nonempty:
        raise WorkspaceError("Focused terminal must be visible")
    return {"panes": ids, "active": active, "direction": direction, "ratios": ratios}


def device_layout(device, body=None, known=()):
    """A device's screen is independent of workspace membership and deletion."""
    if not KEY.fullmatch(device):
        raise WorkspaceError("Invalid device identity")
    with connection() as db:
        row = db.execute("SELECT * FROM device_layouts WHERE device=?", (device,)).fetchone()
        revision = row["revision"] if row else 0
        if body is not None:
            if type(body.get("revision")) is not int or body["revision"] != revision:
                raise WorkspaceError("Layout changed in another window; reload before saving", 409)
            value = _layout_body(body, set(known))
            if not row and db.execute("SELECT COUNT(*) FROM device_layouts").fetchone()[0] >= 256:
                raise WorkspaceError("Device layout limit reached", 409)
            db.execute("INSERT OR REPLACE INTO device_layouts VALUES(?,?,?)", (device, json.dumps(value), revision + 1))
            return {**value, "revision": revision + 1}
        return {**(json.loads(row["body"]) if row else {"panes": [], "active": None, "direction": "auto", "ratios": {}}), "revision": revision}


def layout(wid, device, body=None):
    """v89 compatibility endpoint; v90 screens use device_layout instead."""
    if not KEY.fullmatch(device):
        raise WorkspaceError("Invalid device identity")
    with connection() as db:
        workspace = _get(db, wid)
        row = db.execute("SELECT * FROM layouts WHERE workspace=? AND device=?", (wid, device)).fetchone()
        revision = row["revision"] if row else 0
        if body is not None:
            if type(body.get("revision")) is not int or body["revision"] != revision:
                raise WorkspaceError("Layout changed in another window; reload before saving", 409)
            value = _layout_body(body, set(json.loads(workspace["members"])))
            db.execute("INSERT OR REPLACE INTO layouts VALUES(?,?,?,?)", (wid, device, json.dumps(value), revision + 1))
            return {**value, "revision": revision + 1}
        return {**(json.loads(row["body"]) if row else {"panes": [], "active": None, "direction": "auto", "ratios": {}}), "revision": revision}


def record_events(statuses):
    with connection() as db:
        for sid, status in statuses.items():
            if status["phase"] not in {"needs_attention", "complete", "error"} or not status.get("eventKey"):
                continue
            key = hashlib.sha256((sid + ":" + status["eventKey"]).encode()).hexdigest()[:32]
            db.execute("INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,0)",
                       (key, sid, status["phase"], status["source"], status["updatedAt"]))
        db.execute("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY time DESC LIMIT 300)")
        return [dict(row) for row in db.execute("SELECT * FROM events ORDER BY time DESC LIMIT 100")]


def acknowledge(ids):
    if not isinstance(ids, list) or len(ids) > 100 or any(not isinstance(i, str) or not KEY.fullmatch(i) for i in ids):
        raise WorkspaceError("Invalid notification selection")
    with connection() as db:
        db.executemany("UPDATE events SET seen=1 WHERE id=?", [(i,) for i in ids])
