"""Durable completion receipts; no model requests or terminal input."""
from datetime import datetime
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import secrets
import time

from backend import agent_activity, agent_sessions, store, workspaces

CHUNK = 512 * 1024


def _record(db, sid, key, stamp):
    if not isinstance(stamp, (float, int)) or not math.isfinite(stamp):
        return
    event = hashlib.sha256((sid + ":" + key).encode()).hexdigest()
    db.execute("INSERT INTO completion_state VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE "
               "SET event=excluded.event,time=excluded.time WHERE excluded.time>completion_state.time",
               (sid, event, stamp))


def _codex(db, sid, record):
    if not agent_sessions.transcript_exists(record):
        return
    path = Path(record["transcript"])
    with path.open("rb") as stream:
        stat = os.fstat(stream.fileno())
        identity = json.dumps([record.get("run"), str(path), stat.st_dev, stat.st_ino])
        cursor = db.execute("SELECT identity,offset FROM completion_cursors WHERE sid=?", (sid,)).fetchone()
        if cursor and cursor["identity"] == identity and cursor["offset"] <= stat.st_size:
            offset = cursor["offset"]
            if offset == stat.st_size:
                return
            stream.seek(offset)
        else:
            # A newly adopted transcript needs only its tail, not years of history.
            stream.seek(max(0, stat.st_size - CHUNK))
            if stream.tell():
                stream.readline(CHUNK)
            offset = stream.tell()
        data = stream.read(CHUNK)
        end = data.rfind(b"\n") + 1
        for row in data[:end].splitlines():
            try:
                value = json.loads(row)
                if value.get("type") != "event_msg" or value.get("payload", {}).get("type") != "task_complete":
                    continue
                stamp = datetime.fromisoformat(value["timestamp"].replace("Z", "+00:00")).timestamp()
                if stamp >= agent_activity._started(record):
                    _record(db, sid, f'{record.get("run")}:task_complete:{stamp}', stamp)
            except (ValueError, KeyError, TypeError, AttributeError):
                continue
        # Leave incomplete JSON for the next pass; skip oversized non-event lines.
        if not end and len(data) == CHUNK:
            stream.readline(CHUNK)
            end = stream.tell() - offset
        db.execute("INSERT OR REPLACE INTO completion_cursors VALUES(?,?,?)", (sid, identity, offset + end))


def collect():
    for tab in store.list_tabs():
        sid = tab["id"]
        record = agent_sessions.load(sid)
        if not record.get("run") or record.get("agent") not in {"codex", "claude"}:
            continue
        try:
            with workspaces.connection() as db:
                if record.get("agent") == "codex":
                    _codex(db, sid, record)
                elif record.get("agent") == "claude":
                    value = record.get("last_completion") or record.get("activity", {})
                    if value.get("event") == "Stop" and value.get("run") == record["run"]:
                        _record(db, sid, f'{record["run"]}:Stop:{value["at"]}', value["at"])
        except (OSError, ValueError, KeyError, TypeError):
            # A missing/rotating transcript must not block other terminal receipts.
            continue


def _reader(db, token):
    secret = db.execute("SELECT value FROM metadata WHERE key='completion_secret'").fetchone()
    if not secret:
        secret = (secrets.token_hex(32),)
        db.execute("INSERT INTO metadata VALUES('completion_secret',?)", secret)
    principal = hmac.new(secret[0].encode(), token.encode(), hashlib.sha256).hexdigest()
    db.execute("INSERT OR IGNORE INTO completion_readers VALUES(?,?)", (principal, time.time()))
    return principal


def unread(token):
    known = {tab["id"] for tab in store.list_tabs()}
    with workspaces.connection() as db:
        principal = _reader(db, token)
        rows = db.execute("SELECT c.sid,c.event AS id,c.time FROM completion_state c "
                          "JOIN completion_readers p ON p.principal=? "
                          "LEFT JOIN completion_reads r ON r.principal=p.principal AND r.sid=c.sid "
                          "WHERE c.time>p.since AND (r.event IS NULL OR r.event!=c.event)", (principal,))
        return {"unread": [dict(row) for row in rows if row["sid"] in known]}


def acknowledge(token, ids):
    if not isinstance(ids, list) or len(ids) > 100 or any(not isinstance(i, str) or not workspaces.KEY.fullmatch(i) for i in ids):
        raise workspaces.WorkspaceError("Invalid completion receipts")
    with workspaces.connection() as db:
        principal = _reader(db, token)
        for event in ids:
            # An acknowledgement of an older reply never clears a newer reply.
            db.execute("INSERT INTO completion_reads SELECT ?,sid,event FROM completion_state WHERE event=? "
                       "ON CONFLICT(principal,sid) DO UPDATE SET event=excluded.event", (principal, event))
