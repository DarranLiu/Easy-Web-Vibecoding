"""Who is connected right now — shared across backend processes.

This used to be a module-level dict, which silently broke when the same app ran
behind more than one uvicorn process. State therefore lives in one small file
guarded by an flock, so every process reads and writes the same picture.

Some raw TCP tunnels do not preserve the source IP. IP alone can then no longer
separate people, so clients are counted by their own client id and a device
label is derived from the User-Agent to keep the connection monitor useful.
"""
import fcntl
import json
import os
import re
import threading
import time
from pathlib import Path

from backend import known_ips
from backend.private_files import open_private

STORE = Path(os.environ.get("CC_WEB_PRESENCE", str(Path.home() / ".cc-web-presence.json")))
TTL = 30.0               # seconds; the frontend heartbeats every ~10s
_lock = threading.RLock()

TUNNEL_IPS = {"127.0.0.1", "::1", "localhost"}
TUNNEL_LABEL = "公网隧道"


def _blank():
    return {"clients": {}, "ws": {}}


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


def _prune(data):
    now = time.time()
    for cid in [c for c, v in data["clients"].items() if now - v.get("last", 0) > TTL]:
        data["clients"].pop(cid, None)
    # A WebSocket has no heartbeat of its own, so entries are reaped by owner:
    # the process that registered it either removed it or is gone.
    for key in [k for k, v in data["ws"].items() if not _pid_alive(v.get("pid", -1))]:
        data["ws"].pop(key, None)


def _mutate(fn):
    """Read-modify-write the shared file under an exclusive lock."""
    with _lock:
        fd = open_private(STORE, os.O_RDWR | os.O_CREAT)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            raw = os.read(fd, 4 << 20)
            try:
                data = json.loads(raw) if raw else _blank()
            except Exception:
                data = _blank()
            data.setdefault("clients", {})
            data.setdefault("ws", {})
            result = fn(data)
            _prune(data)
            out = json.dumps(data).encode("utf-8")
            os.lseek(fd, 0, os.SEEK_SET)
            os.write(fd, out)
            os.ftruncate(fd, len(out))
            return result
        finally:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)


# --- device labels ----------------------------------------------------------
_OS = [
    (r"iPad|Macintosh.*Mobile", "iPad"),          # iPadOS ≥13 reports as Macintosh
    (r"iPhone", "iPhone"),
    (r"Android", "Android"),
    (r"Macintosh|Mac OS X", "Mac"),
    (r"Windows", "Windows"),
    (r"CrOS", "ChromeOS"),
    (r"Linux", "Linux"),
]
_BROWSER = [
    (r"Edg/", "Edge"), (r"OPR/|Opera", "Opera"), (r"Firefox/", "Firefox"),
    (r"CriOS|Chrome/", "Chrome"), (r"Version/.*Safari", "Safari"), (r"Safari/", "Safari"),
]


def device_label(ua: str) -> str:
    ua = ua or ""
    osn = next((n for pat, n in _OS if re.search(pat, ua)), "")
    br = next((n for pat, n in _BROWSER if re.search(pat, ua)), "")
    if not ua:
        return "未知设备"
    if not osn and not br:
        return "脚本/未知"
    return (osn + " " + br).strip()


def is_tunnel(ip: str, via: str) -> bool:
    # Loopback alone is ambiguous when a local proxy terminates TLS: a proxied
    # visitor and someone browsing on the server can both arrive as 127.0.0.1.
    # The recorded connection route tells them apart.
    return ip in TUNNEL_IPS and via == "tunnel"


def display_ip(ip: str, via: str = "direct") -> str:
    if is_tunnel(ip, via):
        return TUNNEL_LABEL
    if ip in TUNNEL_IPS:
        return "本机 " + ip
    return ip


# --- public API -------------------------------------------------------------
def touch_client(cid: str, ip: str, ua: str, via: str = "direct"):
    def op(data):
        data["clients"][cid] = {"ip": ip, "last": time.time(), "ua": ua, "via": via}
    _mutate(op)
    known_ips.seen(ip, device_label(ua), via)


def add_ws(conn_id: str, ip: str, sid: str, via: str = "direct", ua: str = ""):
    def op(data):
        data["ws"]["%d:%s" % (os.getpid(), conn_id)] = {"ip": ip, "sid": sid, "via": via, "pid": os.getpid()}
    _mutate(op)
    # Ledger the WS too: a backgrounded tab stops heartbeating over HTTP but
    # keeps its terminal open, and that client must still be recorded.
    known_ips.seen(ip, device_label(ua), via)


def drop_ws(conn_id: str):
    def op(data):
        data["ws"].pop("%d:%s" % (os.getpid(), conn_id), None)
    _mutate(op)


def summary(self_ip: str, self_cid: str = "", self_via: str = "direct") -> dict:
    data = _mutate(lambda d: json.loads(json.dumps(d)))   # prune, then snapshot

    def bucket(groups, ip, via):
        key = ip + "|" + ("tunnel" if is_tunnel(ip, via) else "direct")
        return groups.setdefault(key, {"ip": ip, "via": via, "clients": 0, "terminals": 0, "devices": [], "you": False})

    groups: dict = {}
    for cid, v in data["clients"].items():
        g = bucket(groups, v["ip"], v.get("via", "direct"))
        g["clients"] += 1
        lab = device_label(v.get("ua", ""))
        if lab not in g["devices"]:
            g["devices"].append(lab)
        if cid == self_cid:
            g["you"] = True
    for v in data["ws"].values():
        bucket(groups, v["ip"], v.get("via", "direct"))["terminals"] += 1

    # Fall back to IP matching when this caller sent no client id (e.g. a probe).
    if not self_cid:
        for g in groups.values():
            g["you"] = g["ip"] == self_ip

    ledger = known_ips.snapshot()
    ips = []
    for g in groups.values():
        tun = is_tunnel(g["ip"], g["via"])
        e = ledger.get(g["ip"]) or {}
        ips.append({
            **g,
            "label": display_ip(g["ip"], g["via"]),
            "tunnel": tun,
            "name": e.get("name", ""),
            "trust": e.get("trust", known_ips.TRUST_UNKNOWN),
            "first_seen": e.get("first_seen"),
        })
    # Strangers first: an unrecognised IP is the whole point of this panel.
    ips.sort(key=lambda x: (x["trust"] == known_ips.TRUST_KNOWN, not x["you"], x["ip"]))

    # People, not IP buckets: behind the TCP tunnel every client shares one IP,
    # so counting buckets reported "1" no matter how many devices were on.
    # A backgrounded tab has its heartbeat timer throttled by the browser while
    # its terminal WebSocket stays up, so a group with live terminals and no
    # heartbeat still counts as one presence — otherwise the panel would list a
    # row it refused to count.
    count = sum(max(g["clients"], 1 if g["terminals"] else 0) for g in groups.values())

    strangers = sum(1 for x in ips if x["trust"] != known_ips.TRUST_KNOWN and not x["you"])

    return {
        "count": count,
        "strangers": strangers,
        "ip_count": len(ips),
        "self_ip": display_ip(self_ip, self_via),
        "ips": ips,
    }
