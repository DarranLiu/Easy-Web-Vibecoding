"""GPU monitoring across one or more hosts.

Each host is probed with a single `nvidia-smi` round trip (over ssh for remote
hosts, so nothing has to be installed on the far side beyond nvidia-smi itself).
Per-process owners come from `ps` on the same round trip: nvidia-smi only knows
PIDs, and a PID is only meaningful on the machine it came from.

Results are cached briefly so a panel polling every few seconds doesn't spawn an
ssh per refresh.
"""
import json
import os
import re
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from backend.private_files import write_private_json

HOSTS_FILE = Path(os.environ.get("CC_WEB_GPU_HOSTS", str(Path.home() / ".cc-web-gpu-hosts.json")))
CACHE_TTL = 3.0          # seconds; a panel refreshing faster than this is served from cache
PROBE_TIMEOUT = 12       # seconds per host

_lock = threading.RLock()
_cache: dict = {}        # addr -> (timestamp, payload)
_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="gpu")

# ssh targets only — never a shell fragment. Anything else is rejected outright
# rather than being quoted, so there is no path from this field to a shell.
_ADDR_RE = re.compile(r"^(?:[A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9._-]{1,255}$")

_DEFAULT_HOSTS = [
    {"name": "本机", "addr": "local"},
]

_GPU_FIELDS = (
    "index,uuid,name,utilization.gpu,utilization.memory,"
    "memory.used,memory.total,temperature.gpu,power.draw,power.limit"
)

# One shell script, one round trip: cards, then compute apps, then the owner of
# each app's PID. `ps` is asked only about the PIDs nvidia-smi reported, so this
# stays small even on a busy box.
_SCRIPT = (
    "command -v nvidia-smi >/dev/null 2>&1 || { echo '@@NOSMI@@'; exit 0; }; "
    "nvidia-smi --query-gpu=" + _GPU_FIELDS + " --format=csv,noheader,nounits; "
    "echo '@@APPS@@'; "
    "nvidia-smi --query-compute-apps=pid,gpu_uuid,used_memory --format=csv,noheader,nounits; "
    "echo '@@PROCS@@'; "
    "nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits | tr -d ' ' | "
    "while read p; do [ -n \"$p\" ] && ps -o pid=,user=,etime=,comm= -p \"$p\" 2>/dev/null | head -1; done"
)


# --- host list --------------------------------------------------------------
def _read_hosts():
    try:
        data = json.loads(HOSTS_FILE.read_text())
        if isinstance(data, list) and data:
            return [h for h in data if isinstance(h, dict) and h.get("addr")]
    except Exception:
        pass
    return list(_DEFAULT_HOSTS)


def _write_hosts(hosts):
    write_private_json(HOSTS_FILE, hosts, indent=2)


def list_hosts():
    with _lock:
        return _read_hosts()


def add_host(name: str, addr: str):
    addr = (addr or "").strip()
    name = (name or "").strip() or addr
    if addr.lower() in ("local", "localhost", "127.0.0.1"):
        addr = "local"
    elif not _ADDR_RE.match(addr):
        raise ValueError("地址只能是主机名/IP,可带 user@ 前缀")
    with _lock:
        hosts = _read_hosts()
        if any(h["addr"] == addr for h in hosts):
            raise ValueError("这台已经在列表里了")
        hosts.append({"name": name[:40], "addr": addr})
        _write_hosts(hosts)
        return hosts


def del_host(addr: str):
    with _lock:
        hosts = [h for h in _read_hosts() if h["addr"] != addr]
        _write_hosts(hosts)
        _cache.pop(addr, None)
        return hosts


# --- probing ----------------------------------------------------------------
def _num(s, cast=float):
    s = (s or "").strip()
    if not s or s.startswith("[") or s in ("N/A", "Not Supported"):
        return None
    try:
        return cast(s)
    except Exception:
        return None


def _run(addr: str):
    if addr == "local":
        if not shutil.which("nvidia-smi"):
            return None, "本机没有 nvidia-smi"
        cmd = ["/bin/sh", "-c", _SCRIPT]
    else:
        if not _ADDR_RE.match(addr):
            return None, "非法地址"
        cmd = [
            "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
            "-o", "StrictHostKeyChecking=accept-new", "-o", "LogLevel=ERROR",
            addr, _SCRIPT,
        ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=PROBE_TIMEOUT)
    except subprocess.TimeoutExpired:
        return None, "连接超时(%ds)" % PROBE_TIMEOUT
    except Exception as e:
        return None, str(e)
    if r.returncode != 0:
        err = (r.stderr or "").strip().splitlines()
        return None, (err[-1] if err else "命令失败 (exit %d)" % r.returncode)
    return r.stdout, None


def _parse(out: str):
    if "@@NOSMI@@" in out:
        raise ValueError("这台机器上没有 nvidia-smi")
    gpu_txt, _, rest = out.partition("@@APPS@@")
    apps_txt, _, procs_txt = rest.partition("@@PROCS@@")

    owners = {}
    for line in procs_txt.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) >= 3:
            owners[parts[0]] = {
                "user": parts[1],
                "etime": parts[2],
                "cmd": (parts[3] if len(parts) > 3 else ""),
            }

    by_uuid = {}
    for line in apps_txt.splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) < 3:
            continue
        pid, uuid, mem = f[0], f[1], _num(f[2], int)
        info = owners.get(pid, {})
        by_uuid.setdefault(uuid, []).append({
            "pid": pid,
            "user": info.get("user") or "?",
            "etime": info.get("etime") or "",
            "cmd": _short_cmd(info.get("cmd") or ""),
            "mem": mem or 0,
        })

    gpus = []
    for line in gpu_txt.splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) < 10:
            continue
        used, total = _num(f[5], int) or 0, _num(f[6], int) or 0
        util = _num(f[3], int)
        procs = sorted(by_uuid.get(f[1], []), key=lambda p: -p["mem"])
        gpus.append({
            "index": _num(f[0], int),
            "name": f[2],
            "util": util,
            "mem_util": _num(f[4], int),
            "mem_used": used,
            "mem_total": total,
            "mem_pct": round(used * 100.0 / total, 1) if total else 0,
            "temp": _num(f[7], int),
            "power": _num(f[8]),
            "power_limit": _num(f[9]),
            "procs": procs,
            "users": sorted({p["user"] for p in procs}),
            "state": _state(util, used, procs),
        })
    if not gpus:
        raise ValueError("没解析到显卡(nvidia-smi 无输出)")
    return gpus


def _short_cmd(cmd: str, limit: int = 90):
    cmd = " ".join(cmd.split())
    # Only `comm` is collected. Full argv often contains tokens or private paths.
    return cmd if len(cmd) <= limit else cmd[: limit - 1] + "…"


def _state(util, mem_used, procs):
    if procs:
        return "busy" if (util or 0) >= 5 else "held"   # held: memory reserved, cores idle
    if mem_used > 500:
        return "held"
    return "idle"


def probe(addr: str, force: bool = False):
    now = time.time()
    if not force:
        with _lock:
            hit = _cache.get(addr)
        if hit and now - hit[0] < CACHE_TTL:
            return hit[1]
    out, err = _run(addr)
    if err is None:
        try:
            payload = {"ok": True, "gpus": _parse(out), "ts": now}
        except Exception as e:
            payload = {"ok": False, "error": str(e), "ts": now}
    else:
        payload = {"ok": False, "error": err, "ts": now}
    with _lock:
        _cache[addr] = (now, payload)
    return payload


def snapshot(force: bool = False):
    """Probe every configured host in parallel and summarise per-user usage."""
    hosts = list_hosts()
    results = list(_pool.map(lambda h: probe(h["addr"], force), hosts))
    out = []
    for h, r in zip(hosts, results):
        entry = {"name": h["name"], "addr": h["addr"], **r}
        if r.get("ok"):
            gpus = r["gpus"]
            per_user = {}
            for g in gpus:
                for p in g["procs"]:
                    u = per_user.setdefault(p["user"], {"user": p["user"], "mem": 0, "gpus": set()})
                    u["mem"] += p["mem"]
                    u["gpus"].add(g["index"])
            entry["summary"] = {
                "total": len(gpus),
                "idle": sum(1 for g in gpus if g["state"] == "idle"),
                "busy": sum(1 for g in gpus if g["state"] == "busy"),
                "held": sum(1 for g in gpus if g["state"] == "held"),
                "mem_used": sum(g["mem_used"] for g in gpus),
                "mem_total": sum(g["mem_total"] for g in gpus),
                "users": sorted(
                    ({"user": u["user"], "mem": u["mem"], "gpus": sorted(u["gpus"])} for u in per_user.values()),
                    key=lambda x: -x["mem"],
                ),
            }
        out.append(entry)
    return out
