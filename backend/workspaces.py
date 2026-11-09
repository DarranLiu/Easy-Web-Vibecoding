"""Private, revisioned workspace metadata; never owns native terminal processes."""
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
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
            CREATE TABLE IF NOT EXISTS token_layout_bindings (
                principal TEXT NOT NULL, kind TEXT NOT NULL, device TEXT NOT NULL,
                revision INTEGER NOT NULL, PRIMARY KEY(principal,kind));
            CREATE TABLE IF NOT EXISTS device_layout_writes (
                device TEXT PRIMARY KEY REFERENCES device_layouts(device) ON DELETE CASCADE,
                writer TEXT NOT NULL, sequence INTEGER NOT NULL, base_revision INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY, sid TEXT NOT NULL, phase TEXT NOT NULL,
                source TEXT NOT NULL, time REAL NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS workspace_usage (
                workspace TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
                last_used REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS completion_state (
                sid TEXT PRIMARY KEY, event TEXT NOT NULL, time REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS completion_cursors (
                sid TEXT PRIMARY KEY, identity TEXT NOT NULL, offset INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS completion_readers (
                principal TEXT PRIMARY KEY, since REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS completion_reads (
                principal TEXT NOT NULL REFERENCES completion_readers(principal) ON DELETE CASCADE,
                sid TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(principal,sid));
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
    row = db.execute("SELECT w.*,COALESCE(u.last_used,0) AS lastUsed FROM workspaces w "
                     "LEFT JOIN workspace_usage u ON u.workspace=w.id WHERE w.id=?", (wid,)).fetchone()
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
        return [_public(row) for row in db.execute(
            "SELECT w.*,COALESCE(u.last_used,0) AS lastUsed FROM workspaces w "
            "LEFT JOIN workspace_usage u ON u.workspace=w.id ORDER BY pinned DESC,lastUsed DESC,created,id")]


def activate(wid):
    """Usage is independent of edit revisions and screen layouts."""
    with connection() as db:
        _get(db, wid)
        db.execute("INSERT INTO workspace_usage VALUES(?,?) ON CONFLICT(workspace) "
                   "DO UPDATE SET last_used=MAX(last_used,excluded.last_used)", (wid, time.time()))
        return {"id": wid, "lastUsed": _get(db, wid)["lastUsed"]}


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


def move_session(source, body, known):
    sid, target = body.get("sid"), body.get("target")
    if not isinstance(sid, str) or sid not in known:
        raise WorkspaceError("Terminal no longer exists", 409)
    if not isinstance(target, str) or not KEY.fullmatch(target) or source == target:
        raise WorkspaceError("Choose another workspace")
    with connection() as db:
        destination = _get(db, target)
        _revision(destination, body.get("targetRevision"))
        origin = None if source == "_unassigned" else _get(db, source)
        if origin is not None:
            _revision(origin, body.get("revision"))
            if sid not in json.loads(origin["members"]):
                raise WorkspaceError("Terminal membership changed; reopen the menu", 409)
        elif any(sid in json.loads(row["members"]) for row in db.execute("SELECT members FROM workspaces")):
            raise WorkspaceError("Terminal is no longer unassigned", 409)
        members = json.loads(destination["members"])
        if sid not in members:
            members = _members([*members, sid])
        # Both revisions are checked inside the same transaction; no half-move.
        if origin is not None:
            remaining = [item for item in json.loads(origin["members"]) if item != sid]
            db.execute("UPDATE workspaces SET members=?,revision=revision+1 WHERE id=?", (json.dumps(remaining), source))
        db.execute("UPDATE workspaces SET members=?,revision=revision+1 WHERE id=?", (json.dumps(members), target))
        return {"source": _public(_get(db, source)) if origin is not None else None,
                "target": _public(_get(db, target))}


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
    value = {"panes": ids, "active": active, "direction": direction, "ratios": ratios}
    if "maximized" in body:
        maximized = body["maximized"]
        if maximized is not None and (type(maximized) is not int or not 0 <= maximized < len(ids)):
            raise WorkspaceError("Invalid maximized pane")
        value["maximized"] = maximized
    return value


def _screen_layout(body, permitted):
    screens = body.get("screens")
    if type(body.get("screenSchema")) is not int or body["screenSchema"] != 1:
        raise WorkspaceError("Unsupported screen layout version")
    if not isinstance(screens, list) or not 1 <= len(screens) <= 16:
        raise WorkspaceError("A layout needs between 1 and 16 screens")
    result, ids = [], set()
    for screen in screens:
        if not isinstance(screen, dict) or not isinstance(screen.get("id"), str) or not KEY.fullmatch(screen["id"]) or screen["id"] in ids:
            raise WorkspaceError("Invalid or duplicate screen identity")
        ids.add(screen["id"])
        result.append({**_layout_body(screen, permitted), "id": screen["id"], "name": _name(screen.get("name"))})
    selected = next((screen for screen in result if screen["id"] == body.get("activeScreen")), None)
    if selected is None:
        raise WorkspaceError("Selected screen must exist")
    # One owner per device/profile, including writes from older browser clients.
    seen = set()
    for screen in [selected] + [item for item in result if item is not selected]:
        indexes = []
        for index, sid in enumerate(screen["panes"]):
            if sid is None or sid not in seen:
                indexes.append(index)
                if sid is not None:
                    seen.add(sid)
        if len(indexes) == len(screen["panes"]):
            continue
        screen["panes"] = [screen["panes"][index] for index in indexes]
        if screen["active"] not in screen["panes"]:
            screen["active"] = next((sid for sid in screen["panes"] if sid is not None), None)
        maximized = screen.get("maximized")
        screen["maximized"] = indexes.index(maximized) if maximized in indexes else None
        screen["ratios"] = {}
    return {**{key: selected[key] for key in ("panes", "active", "direction", "ratios")},
            "maximized": selected.get("maximized"), "screens": result,
            "activeScreen": selected["id"], "screenSchema": 1}


def _stored_screen_layout(value):
    if "screens" not in value:
        return value
    permitted = {sid for screen in value["screens"] for sid in screen.get("panes", []) if sid is not None}
    return _screen_layout(value, permitted)


def saved_layouts(kind="desktop"):
    if kind not in {"desktop", "mobile"}:
        raise WorkspaceError("Invalid layout device kind")
    result = []
    with connection() as db:
        for row in db.execute("SELECT device,body FROM device_layouts ORDER BY device"):
            if not row["device"].startswith(kind + "_"):
                continue
            try:
                value = _stored_screen_layout(json.loads(row["body"]))
                screens = value.get("screens", [value])
                result.append({"device": row["device"], "screenNames": [s.get("name", "屏幕1") for s in screens],
                               "screenCount": len(screens), "paneCount": sum(len(s.get("panes", [])) for s in screens)})
            except (ValueError, TypeError, AttributeError, WorkspaceError):
                continue
    return result


def token_layout_binding(token, kind, body=None):
    """Remember a layout per access credential without storing the credential itself."""
    if kind not in {"desktop", "mobile"}:
        raise WorkspaceError("Invalid layout device kind")
    with connection() as db:
        secret = db.execute("SELECT value FROM metadata WHERE key='layout_binding_secret'").fetchone()
        if not secret:
            secret = (secrets.token_hex(32),)
            db.execute("INSERT INTO metadata VALUES('layout_binding_secret',?)", secret)
        principal = hmac.new(secret[0].encode(), token.encode(), hashlib.sha256).hexdigest()
        row = db.execute("SELECT device,revision FROM token_layout_bindings WHERE principal=? AND kind=?", (principal, kind)).fetchone()
        revision = row["revision"] if row else 0
        if body is not None:
            target = body.get("device")
            if not isinstance(target, str) or not KEY.fullmatch(target) or not target.startswith(kind + "_"):
                raise WorkspaceError("Invalid layout binding")
            suffix = target[len(kind) + 1:]
            if (not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}", suffix[5:]) if suffix.startswith("user_")
                    else not re.fullmatch(r"[a-zA-Z0-9_-]{1,48}", suffix)):
                raise WorkspaceError("Invalid layout binding identity")
            if type(body.get("revision")) is not int or body["revision"] != revision:
                raise WorkspaceError("Layout binding changed in another window; reload before switching", 409)
            if row and not db.execute("SELECT 1 FROM device_layouts WHERE device=?", (target,)).fetchone():
                raise WorkspaceError("Saved layout not found", 404)
            db.execute("INSERT OR REPLACE INTO token_layout_bindings VALUES(?,?,?,?)", (principal, kind, target, revision + 1))
            return {"enabled": True, "device": target, "revision": revision + 1}
        return {"enabled": True, "device": row["device"] if row else None, "revision": revision}


def device_layout(device, body=None, known=()):
    """Screen sets are device/profile scoped, never native process operations."""
    if not KEY.fullmatch(device):
        raise WorkspaceError("Invalid device identity")
    with connection() as db:
        row = db.execute("SELECT * FROM device_layouts WHERE device=?", (device,)).fetchone()
        revision = row["revision"] if row else 0
        previous = _stored_screen_layout(json.loads(row["body"])) if row else {}
        last = db.execute("SELECT writer,sequence,base_revision FROM device_layout_writes WHERE device=?", (device,)).fetchone()
        stamp = {"write": {"writer": last["writer"], "sequence": last["sequence"], "baseRevision": last["base_revision"]}} if last else {}
        if body is not None:
            expected, writer, sequence = body.get("revision"), body.get("writer"), body.get("sequence")
            if "writer" in body or "sequence" in body:
                if not isinstance(writer, str) or not KEY.fullmatch(writer) or type(sequence) is not int or not 0 <= sequence <= 9007199254740991:
                    raise WorkspaceError("Invalid layout write identity")
            if type(expected) is not int or expected < 0 or expected > revision:
                raise WorkspaceError("Invalid layout revision", 409)
            # A closing page may send its final edit before its previous PUT returns.
            # Only that same writer can supersede its own unacknowledged write.
            same_writer = last and writer == last["writer"]
            if same_writer and sequence <= last["sequence"]:
                return {**previous, "screenSchema": 1, "revision": revision, **stamp}
            if expected != revision and not (same_writer and expected == last["base_revision"]):
                raise WorkspaceError("Layout changed in another window; reload before saving", 409)
            # Keep deleted terminals as placeholders, but never accept new unknown IDs.
            permitted = set(known) | set(sid for screen in previous.get("screens", [previous]) for sid in screen.get("panes", []) if sid)
            if "screenSchema" in body and (type(body["screenSchema"]) is not int or body["screenSchema"] != 1):
                raise WorkspaceError("Unsupported screen layout version")
            if "screens" in body:
                value = _screen_layout(body, permitted)
            elif previous.get("screens"):
                selected = previous["activeScreen"]
                screens = [{**screen, **_layout_body({**body, "maximized": body.get("maximized")}, permitted)} if screen["id"] == selected else screen for screen in previous["screens"]]
                value = _screen_layout({**previous, "screens": screens}, permitted)
            else:
                value = _layout_body(body, permitted)
            if not row and db.execute("SELECT COUNT(*) FROM device_layouts").fetchone()[0] >= 256:
                raise WorkspaceError("Device layout limit reached", 409)
            db.execute("INSERT OR REPLACE INTO device_layouts VALUES(?,?,?)", (device, json.dumps(value), revision + 1))
            stamp = {}
            if writer is not None:
                db.execute("INSERT INTO device_layout_writes VALUES(?,?,?,?)", (device, writer, sequence, expected))
                stamp = {"write": {"writer": writer, "sequence": sequence, "baseRevision": expected}}
            return {**value, "screenSchema": 1, "revision": revision + 1, **stamp}
        return {**(previous if row else {"panes": [], "active": None, "direction": "auto", "ratios": {}}), "screenSchema": 1, "revision": revision, **stamp}


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
