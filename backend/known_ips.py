"""Known-IP registry — the 熟人/陌生人 ledger behind the online monitor.

Presence answers "who is connected right now"; this answers "have I ever seen
them before". Every IP that ever authenticates is recorded with when it was
first and last seen, how often, and which devices came from it. You then name
the ones you recognise, and anything still unnamed shows up as 陌生.

Same flock'd-file pattern as presence.py, and for the same reason: cc-web and
cc-web-tls are separate processes and must share one ledger.
"""
import fcntl
import json
import os
import threading
import time
from pathlib import Path

STORE = Path(os.environ.get("CC_WEB_KNOWN_IPS", str(Path.home() / ".cc-web-known-ips.json")))
_lock = threading.RLock()

TRUST_KNOWN = "known"      # named by you — 熟人
TRUST_UNKNOWN = "unknown"  # seen but never named — 陌生
TRUST_BLOCKED = "blocked"  # explicitly flagged as not yours
MAX_DEVICES = 6
MAX_ENTRIES = 500          # ledger is a monitoring aid, not an audit log


def _mutate(fn):
    with _lock:
        STORE.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(STORE, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            raw = os.read(fd, 8 << 20)
            try:
                data = json.loads(raw) if raw else {}
            except Exception:
                data = {}
            if not isinstance(data, dict):
                data = {}
            result = fn(data)
            if len(data) > MAX_ENTRIES:
                # Drop the least recently seen 陌生 entries first; never evict
                # anything you took the trouble to name.
                spare = sorted(
                    (k for k, v in data.items() if v.get("trust") != TRUST_KNOWN),
                    key=lambda k: data[k].get("last_seen", 0),
                )
                for k in spare[: len(data) - MAX_ENTRIES]:
                    data.pop(k, None)
            out = json.dumps(data, ensure_ascii=False).encode("utf-8")
            os.lseek(fd, 0, os.SEEK_SET)
            os.write(fd, out)
            os.ftruncate(fd, len(out))
            return result
        finally:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)


def seen(ip: str, device: str = "", via: str = "direct"):
    """Record a live sighting. Called on every presence heartbeat."""
    if not ip or ip == "?":
        return

    def op(data):
        now = time.time()
        e = data.get(ip)
        if not e:
            e = {"ip": ip, "name": "", "trust": TRUST_UNKNOWN, "first_seen": now,
                 "devices": [], "hits": 0, "via": via}
            data[ip] = e
        e["last_seen"] = now
        e["hits"] = e.get("hits", 0) + 1
        e["via"] = via
        if device and device not in e.setdefault("devices", []):
            e["devices"] = ([device] + e["devices"])[:MAX_DEVICES]
    _mutate(op)


def get(ip: str) -> dict:
    return _mutate(lambda d: d.get(ip) or {})


def snapshot() -> dict:
    return _mutate(lambda d: json.loads(json.dumps(d)))


def list_all():
    data = snapshot()
    rows = sorted(data.values(), key=lambda e: -e.get("last_seen", 0))
    return rows


def label(ip: str, name: str = None, trust: str = None):
    def op(data):
        e = data.get(ip)
        if not e:
            e = {"ip": ip, "name": "", "trust": TRUST_UNKNOWN, "first_seen": time.time(),
                 "last_seen": time.time(), "devices": [], "hits": 0, "via": "direct"}
            data[ip] = e
        if name is not None:
            e["name"] = name.strip()[:40]
        if trust in (TRUST_KNOWN, TRUST_UNKNOWN, TRUST_BLOCKED):
            e["trust"] = trust
        elif name is not None:
            # Naming something is what makes it 熟人; clearing the name undoes it.
            e["trust"] = TRUST_KNOWN if e["name"] else TRUST_UNKNOWN
        return dict(e)
    return _mutate(op)


def forget(ip: str):
    _mutate(lambda d: d.pop(ip, None))
