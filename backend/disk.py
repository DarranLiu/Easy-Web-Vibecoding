"""Storage monitoring — filesystem capacity plus a drill-down of what is eating it.

Two very different costs, so two very different mechanisms:

* `df` is instant, so mount capacity is read live on every request.
* `du` is not. Scanning a large workspace can take tens of seconds even at
  depth 1. So directory breakdowns are computed by a **background
  thread** and served from a cache; the API answers immediately with either the
  last snapshot or "scanning". A scan is claimed in the shared cache file with
  the owning pid so the two uvicorn processes never duplicate the same walk.

The drill-down (click a directory, get its children) is the point of the
feature: it is what turns "the disk is 85% full" into "these three directories
are why".
"""
import fcntl
import json
import os
import re
import shlex
import subprocess
import threading
import time
from pathlib import Path

from backend.private_files import open_private

CACHE = Path(os.environ.get("CC_WEB_DISK_CACHE", str(Path.home() / ".cc-web-disk.json")))
SCAN_TIMEOUT = 900          # seconds; a 2 TB depth-1 walk is ~35s, leave headroom
FRESH_FOR = 30 * 60         # a snapshot older than this is offered with a "stale" hint
TOP_N = 40
_lock = threading.RLock()
_inflight = set()

# Roots offered per host; anything that does not exist there is skipped. Keep
# this list explicit because `du` can be expensive on very large filesystems.
DEFAULT_ROOTS = [
    str(Path(p).expanduser())
    for p in os.environ.get("CC_WEB_DISK_ROOTS", str(Path.home())).split(",")
    if p.strip()
]

# Pseudo/loop filesystems carry no useful capacity signal.
_SKIP_FS = {"tmpfs", "devtmpfs", "squashfs", "overlay", "efivarfs", "ramfs", "autofs", "fuse.gvfsd-fuse"}
_SKIP_MOUNT = re.compile(r"^/(snap|proc|sys|dev|run)(/|$)")


def _run(addr: str, argv_local, script_remote, timeout):
    """Local runs take an argv (no shell); remote runs go through ssh."""
    if addr == "local":
        cmd = argv_local
    else:
        cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
               "-o", "StrictHostKeyChecking=accept-new", "-o", "LogLevel=ERROR",
               addr, script_remote]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, "扫描超时(%ds)" % timeout
    except Exception as e:
        return None, str(e)
    if r.returncode != 0 and not r.stdout.strip():
        err = (r.stderr or "").strip().splitlines()
        return None, (err[-1] if err else "命令失败 (exit %d)" % r.returncode)
    return r.stdout, None


# --- df ---------------------------------------------------------------------
def mounts(addr: str):
    out, err = _run(
        addr,
        ["df", "-B1", "--output=source,fstype,size,used,avail,pcent,target"],
        "df -B1 --output=source,fstype,size,used,avail,pcent,target",
        20,
    )
    if err:
        return None, err
    rows = []
    for line in (out or "").splitlines()[1:]:
        f = line.split(None, 6)
        if len(f) < 7:
            continue
        source, fstype, size, used, avail, pcent, target = f
        if fstype in _SKIP_FS or _SKIP_MOUNT.match(target):
            continue
        try:
            size, used, avail = int(size), int(used), int(avail)
        except ValueError:
            continue
        # Sub-2 GiB mounts (/boot/efi and friends) are noise on a storage panel.
        if size < 2 * 1024 ** 3:
            continue
        rows.append({
            "source": source, "fstype": fstype, "target": target,
            "size": size, "used": used, "avail": avail,
            "pct": round(used * 100.0 / size, 1),
        })
    rows.sort(key=lambda m: -m["size"])
    return rows, None


# --- cache ------------------------------------------------------------------
def _mutate(fn):
    with _lock:
        fd = open_private(CACHE, os.O_RDWR | os.O_CREAT)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            raw = os.read(fd, 32 << 20)
            try:
                data = json.loads(raw) if raw else {}
            except Exception:
                data = {}
            if not isinstance(data, dict):
                data = {}
            result = fn(data)
            blob = json.dumps(data, ensure_ascii=False).encode("utf-8")
            os.lseek(fd, 0, os.SEEK_SET)
            os.write(fd, blob)
            os.ftruncate(fd, len(blob))
            return result
        finally:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)


def _pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def _key(addr, path):
    return addr + "|" + path


def _claim(addr, path):
    """Mark a scan as ours. False if another live process already has it."""
    def op(data):
        e = data.get(_key(addr, path)) or {}
        cur = e.get("scanning")
        if cur and _pid_alive(cur.get("pid")) and time.time() - cur.get("at", 0) < SCAN_TIMEOUT:
            return False
        e["scanning"] = {"pid": os.getpid(), "at": time.time()}
        data[_key(addr, path)] = e
        return True
    return _mutate(op)


def _store(addr, path, entry):
    def op(data):
        e = data.get(_key(addr, path)) or {}
        e.pop("scanning", None)
        e.update(entry)
        data[_key(addr, path)] = e
    _mutate(op)


def _read(addr, path):
    return _mutate(lambda d: json.loads(json.dumps(d.get(_key(addr, path)) or {})))


# --- du ---------------------------------------------------------------------
def _valid_path(path: str):
    p = os.path.normpath(path or "")
    if not p.startswith("/") or "\x00" in p:
        return None
    # Confine drill-down to the configured roots; the panel must not become a
    # "du anything on any host" endpoint.
    for root in DEFAULT_ROOTS:
        if p == root or p.startswith(root.rstrip("/") + "/"):
            return p
    return None


def _scan(addr: str, path: str):
    started = time.time()
    q = shlex.quote(path)
    out, err = _run(
        addr,
        ["du", "-x", "--max-depth=1", "-B1", path],
        "du -x --max-depth=1 -B1 %s 2>/dev/null" % q,
        SCAN_TIMEOUT,
    )
    if err:
        _store(addr, path, {"error": err, "at": time.time()})
        return
    total = 0
    children = []
    for line in (out or "").splitlines():
        parts = line.split("\t", 1)
        if len(parts) != 2:
            parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        try:
            size = int(parts[0])
        except ValueError:
            continue
        p = parts[1].strip()
        if os.path.normpath(p) == os.path.normpath(path):
            total = size
        else:
            children.append({"name": os.path.basename(p) or p, "path": p, "size": size})
    children.sort(key=lambda c: -c["size"])
    dropped = max(0, len(children) - TOP_N)
    _store(addr, path, {
        "error": None, "at": time.time(), "duration": round(time.time() - started, 1),
        "total": total, "children": children[:TOP_N], "dropped": dropped,
    })


def _spawn(addr, path):
    k = _key(addr, path)
    with _lock:
        if k in _inflight:
            return False
        if not _claim(addr, path):
            return False
        _inflight.add(k)

    def run():
        try:
            _scan(addr, path)
        finally:
            with _lock:
                _inflight.discard(k)
    threading.Thread(target=run, daemon=True, name="du-scan").start()
    return True


def usage(addr: str, path: str, refresh: bool = False):
    p = _valid_path(path)
    if not p:
        return {"error": "路径不在允许的范围内", "path": path}
    entry = _read(addr, p)
    scanning = bool(entry.get("scanning")) and _pid_alive(entry["scanning"].get("pid"))
    if refresh or (not scanning and not entry.get("at")):
        if _spawn(addr, p):
            scanning = True
        else:
            scanning = True   # somebody else already has it
    return {
        "path": p, "addr": addr, "scanning": scanning,
        "at": entry.get("at"), "duration": entry.get("duration"),
        "total": entry.get("total"), "children": entry.get("children") or [],
        "dropped": entry.get("dropped", 0), "error": entry.get("error"),
        "stale": bool(entry.get("at") and time.time() - entry["at"] > FRESH_FOR),
    }


def roots_for(addr: str):
    """Which of the default roots actually exist on this host."""
    checks = " ".join(shlex.quote(r) for r in DEFAULT_ROOTS)
    out, err = _run(
        addr,
        ["/bin/sh", "-c", "for d in %s; do [ -d \"$d\" ] && echo \"$d\"; done" % checks],
        "for d in %s; do [ -d \"$d\" ] && echo \"$d\"; done" % checks,
        20,
    )
    if err:
        return []
    return [l.strip() for l in (out or "").splitlines() if l.strip()]


def snapshot(hosts):
    """df for every host, plus whatever root breakdowns are already cached."""
    out = []
    for h in hosts:
        addr = h["addr"]
        ms, err = mounts(addr)
        entry = {"name": h["name"], "addr": addr, "ok": err is None, "error": err, "mounts": ms or []}
        if err is None:
            roots = []
            for r in roots_for(addr):
                e = _read(addr, r)
                roots.append({
                    "path": r,
                    "total": e.get("total"),
                    "at": e.get("at"),
                    "duration": e.get("duration"),
                    "scanning": bool(e.get("scanning")) and _pid_alive(e["scanning"].get("pid")),
                    "error": e.get("error"),
                })
            entry["roots"] = roots
        out.append(entry)
    return out
