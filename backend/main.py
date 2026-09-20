"""Web CC Terminal — FastAPI backend.

Stateless transport in front of tmux:
  * REST for directory browsing + tab management
  * WebSocket bridges xterm.js <-> `tmux attach` over a PTY

Tabs (store.py) are chat-like entries that outlive the tmux session. The
PTY/WebSocket are disposable: closing them detaches the tmux client but never
kills the session. Stopping a tab kills the session yet keeps the tab (grey,
restartable); deleting a tab removes it for good.
"""
import asyncio
import fcntl
import json
import mimetypes
import os
import pty
import secrets
import shlex
import shutil
import signal
import struct
import termios
import time
from datetime import datetime
from pathlib import Path

from fastapi import (
    Depends, FastAPI, File, Form, HTTPException, Request, UploadFile,
    Response, WebSocket, WebSocketDisconnect,
)
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend import codex_usage, config, disk, gpu, store, tmux_mgr
from backend import known_ips
from backend import presence as presence_store

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"

app = FastAPI(title="Web CC Terminal")
AUTH_COOKIE = "cc_web_token"


# --- Auth -------------------------------------------------------------------
def _extract_token(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:]
    return getattr(request, "cookies", {}).get(AUTH_COOKIE, "")


def _token_matches(token: str) -> bool:
    # Compare as bytes so a non-ASCII token (e.g. a phone autocorrecting "..."
    # into the "…" ellipsis char) just fails to match instead of crashing.
    try:
        return secrets.compare_digest((token or "").encode("utf-8"), config.TOKEN.encode("utf-8"))
    except Exception:
        return False


def require_auth(request: Request):
    if not config.AUTH_ENABLED:
        return True
    if not _token_matches(_extract_token(request)):
        raise HTTPException(status_code=401, detail="bad or missing token")
    return True


def check_ws_token(cookie_token: str = "") -> bool:
    if not config.AUTH_ENABLED:
        return True
    return _token_matches(cookie_token)


@app.post("/api/login")
async def login(request: Request, response: Response):
    if not config.AUTH_ENABLED:
        return {"ok": True, "auth": False}
    try:
        body = await request.json()
    except Exception:
        body = {}
    token = (body.get("token") or "").strip()
    if not _token_matches(token):
        raise HTTPException(status_code=401, detail="bad token")
    response.set_cookie(
        AUTH_COOKIE,
        token,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="strict",
        max_age=60 * 60 * 24 * 30,
        path="/",
    )
    return {"ok": True, "auth": True}


# --- Directory browsing -----------------------------------------------------
def safe_resolve(path: str) -> Path:
    p = Path(path).resolve()
    for root in config.ROOTS:
        if p == Path(root) or root in (str(a) for a in p.parents):
            return p
    raise HTTPException(status_code=403, detail="目录不在允许浏览的范围内")


def _is_dir(p: Path) -> bool:
    try:
        return p.is_dir()
    except OSError:
        return False


def _entry(e: Path) -> dict:
    """One listing row. stat() can fail on broken symlinks — never let that
    take down the whole directory."""
    d = _is_dir(e)
    row = {"name": e.name, "path": str(e), "type": "dir" if d else "file"}
    try:
        st = e.stat()
        row["size"] = 0 if d else st.st_size
        row["mtime"] = int(st.st_mtime)
    except OSError:
        row["size"] = None
        row["mtime"] = None
    return row


@app.get("/api/fs")
def fs(path: str = "", _=Depends(require_auth)):
    if not path:
        return {
            "path": "",
            "parent": None,
            "roots": config.ROOTS,
            "entries": [{"name": r, "path": r, "type": "dir"} for r in config.ROOTS],
        }

    p = safe_resolve(path)
    if not p.is_dir():
        raise HTTPException(status_code=400, detail="不是一个目录")

    try:
        children = sorted(p.iterdir(), key=lambda x: (not _is_dir(x), x.name.lower()))
    except PermissionError:
        raise HTTPException(status_code=403, detail="没有权限读取该目录")

    entries = [_entry(e) for e in children]
    parent = None if str(p) in config.ROOTS else str(p.parent)
    return {"path": str(p), "parent": parent, "roots": config.ROOTS, "entries": entries}


@app.get("/api/config")
def get_config(_=Depends(require_auth)):
    return {
        "defaultDir": config.DEFAULT_DIR,
        "roots": config.ROOTS,
        "types": {
            "claude": config.CLAUDE_OK,
            "codex": config.CODEX_OK,
            "opencode": config.OPENCODE_OK,
            "shell": True,
        },
    }


@app.get("/api/codex/usage")
async def get_codex_usage(_=Depends(require_auth)):
    if not config.CODEX_OK:
        raise HTTPException(status_code=503, detail="Codex 命令当前不可用")
    try:
        return await asyncio.to_thread(codex_usage.get_usage, config.CODEX_BIN)
    except codex_usage.CodexUsageError:
        raise HTTPException(status_code=503, detail="Codex 用量暂时不可用")


def _safe_name(name: str) -> str:
    name = (name or "").strip()
    if not name or "/" in name or name in (".", ".."):
        raise HTTPException(status_code=400, detail="名称非法")
    return name


@app.post("/api/fs/mkdir")
async def fs_mkdir(request: Request, _=Depends(require_auth)):
    body = await request.json()
    parent = safe_resolve(body.get("parent", ""))
    name = _safe_name(body.get("name", ""))
    target = parent / name
    if target.exists():
        raise HTTPException(status_code=400, detail="已存在同名项")
    try:
        target.mkdir(parents=False)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "path": str(target)}


@app.post("/api/fs/rename")
async def fs_rename(request: Request, _=Depends(require_auth)):
    body = await request.json()
    raw = body.get("path", "")
    safe_resolve(raw)  # whitelist check
    p = Path(raw)
    if str(p) in config.ROOTS:
        raise HTTPException(status_code=400, detail="不能重命名根目录")
    name = _safe_name(body.get("name", ""))
    target = p.parent / name
    if target.exists():
        raise HTTPException(status_code=400, detail="已存在同名项")
    try:
        p.rename(target)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "path": str(target)}


@app.post("/api/fs/delete")
async def fs_delete(request: Request, _=Depends(require_auth)):
    body = await request.json()
    raw = body.get("path", "")
    safe_resolve(raw)  # whitelist check
    p = Path(raw)
    if str(p) in config.ROOTS:
        raise HTTPException(status_code=400, detail="不能删除根目录")
    try:
        if p.is_symlink():
            p.unlink()  # remove the link itself, never recurse through it
        elif p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()
    except FileNotFoundError:
        pass
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True}


@app.post("/api/fs/touch")
async def fs_touch(request: Request, _=Depends(require_auth)):
    body = await request.json()
    parent = safe_resolve(body.get("parent", ""))
    name = _safe_name(body.get("name", ""))
    target = parent / name
    if target.exists():
        raise HTTPException(status_code=400, detail="已存在同名项")
    try:
        target.touch()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "path": str(target)}


@app.post("/api/fs/upload")
async def fs_upload(parent: str = Form(...), file: UploadFile = File(...), _=Depends(require_auth)):
    p = safe_resolve(parent)
    if not p.is_dir():
        raise HTTPException(status_code=400, detail="目标不是目录")
    name = _safe_name(os.path.basename(file.filename or ""))
    target = p / name
    try:
        with open(target, "wb") as out:
            shutil.copyfileobj(file.file, out)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "path": str(target), "name": name}


_IMG_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic", ".heif"}
_CT_EXT = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
    "image/webp": ".webp", "image/bmp": ".bmp", "image/svg+xml": ".svg",
    "image/heic": ".heic", "image/heif": ".heif",
}


@app.post("/api/term/image")
async def term_image(cwd: str = Form(...), file: UploadFile = File(...), _=Depends(require_auth)):
    """Save an image dropped/pasted/picked in the web UI into <cwd>/.cc-web-images/
    and return its absolute path, so the frontend can type that path into the
    terminal for claude/codex to read."""
    base = safe_resolve(cwd)
    if not base.is_dir():
        raise HTTPException(status_code=400, detail="工作目录无效")
    ext = os.path.splitext(os.path.basename(file.filename or ""))[1].lower()
    if ext not in _IMG_EXTS:
        ext = _CT_EXT.get((file.content_type or "").lower(), "")
    if ext not in _IMG_EXTS:
        raise HTTPException(status_code=400, detail="仅支持图片文件")
    img_dir = base / ".cc-web-images"
    try:
        img_dir.mkdir(exist_ok=True)
        fname = "img-" + datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3) + ext
        target = img_dir / fname
        with open(target, "wb") as out:
            shutil.copyfileobj(file.file, out)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "path": str(target), "name": fname}


@app.get("/api/fs/download")
def fs_download(path: str, inline: int = 0, _=Depends(require_auth)):
    p = safe_resolve(path)
    if not p.is_file():
        raise HTTPException(status_code=400, detail="不是文件")
    # A `filename=` makes Starlette send Content-Disposition: attachment, which
    # downloads instead of rendering — preview needs the inline form. Range is
    # handled by FileResponse either way, which <video> seeking (and iOS
    # playback at all) depends on.
    if inline:
        media = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        return FileResponse(str(p), media_type=media)
    return FileResponse(str(p), filename=p.name)


_TEXT_PREVIEW_MAX = 512 * 1024


@app.get("/api/fs/text")
def fs_text(path: str, _=Depends(require_auth)):
    """Head of a text file, for the preview pane."""
    p = safe_resolve(path)
    if not p.is_file():
        raise HTTPException(status_code=400, detail="不是文件")
    try:
        size = p.stat().st_size
        raw = p.open("rb").read(_TEXT_PREVIEW_MAX + 1)
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e))
    truncated = len(raw) > _TEXT_PREVIEW_MAX
    raw = raw[:_TEXT_PREVIEW_MAX]
    if b"\x00" in raw[:8192]:
        raise HTTPException(status_code=415, detail="这是二进制文件,无法按文本预览")
    for enc in ("utf-8", "gb18030", "latin-1"):
        try:
            return {"text": raw.decode(enc), "encoding": enc, "truncated": truncated, "size": size}
        except UnicodeDecodeError:
            continue
    return {"text": raw.decode("utf-8", "replace"), "encoding": "utf-8?", "truncated": truncated, "size": size}


# --- Tabs / sessions --------------------------------------------------------
def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _title(cwd: str) -> str:
    n = Path(cwd).name
    return n or cwd


def _adopt_orphans(live: dict):
    """Pull in cc_ tmux sessions that exist but aren't in the store yet."""
    known = {t["id"] for t in store.list_tabs()}
    for sid, s in live.items():
        if sid not in known:
            store.add_tab({
                "id": sid,
                "cwd": s["cwd"] or "",
                "type": s.get("type") or "claude",
                "mode": s["mode"] or "new",
                "created": s["created"] or _now(),
                "title": _title(s["cwd"] or sid),
            })


def _serialize(live: dict):
    tabs = store.list_tabs()
    out = []
    for t in tabs:
        alive = t["id"] in live
        out.append({**t, "alive": alive, "attached": live[t["id"]]["attached"] if alive else 0})
    out.sort(key=lambda x: x.get("created", ""), reverse=True)
    return out


@app.get("/api/sessions")
def list_sessions(_=Depends(require_auth)):
    live = {s["id"]: s for s in tmux_mgr.list_sessions()}
    _adopt_orphans(live)
    return {"sessions": _serialize(live), "groups": store.get_groups(), "manualGroups": store.get_manual_groups()}


@app.post("/api/groups")
async def set_group(request: Request, _=Depends(require_auth)):
    body = await request.json()
    store.set_group_label(body.get("cwd", ""), (body.get("label") or "").strip())
    return {"ok": True}


@app.post("/api/manual-groups")
async def manual_group_new(request: Request, _=Depends(require_auth)):
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="分组名不能为空")
    store.add_manual_group(name)
    return {"ok": True}


@app.post("/api/manual-groups/rename")
async def manual_group_rename(request: Request, _=Depends(require_auth)):
    body = await request.json()
    store.rename_manual_group(body.get("old", ""), (body.get("new") or "").strip())
    return {"ok": True}


@app.post("/api/manual-groups/delete")
async def manual_group_delete(request: Request, _=Depends(require_auth)):
    body = await request.json()
    store.remove_manual_group(body.get("name", ""))
    return {"ok": True}


@app.post("/api/sessions/{sid}/group")
async def assign_group(sid: str, request: Request, _=Depends(require_auth)):
    if not store.get_tab(sid):
        raise HTTPException(status_code=404, detail="没有这个标签")
    body = await request.json()
    store.update_tab(sid, group=(body.get("group") or "").strip())
    return {"ok": True}


def _launch_cmd(ttype: str, mode: str) -> str:
    if ttype == "shell":
        return ""  # plain shell — send nothing
    if ttype == "codex":
        args = [config.CODEX_BIN]
        if config.CODEX_MODEL_CATALOG:
            catalog_value = json.dumps(config.CODEX_MODEL_CATALOG)
            args.extend(["-c", f"model_catalog_json={catalog_value}"])
        if config.CODEX_STATUS_LINE:
            status_value = json.dumps(config.CODEX_STATUS_LINE, separators=(",", ":"))
            args.extend(["-c", f"tui.status_line={status_value}"])
        return shlex.join(args)
    if ttype == "opencode":
        return config.OPENCODE_BIN
    if ttype == "claude":
        modes = {
            "new": config.CLAUDE_BIN,
            "continue": config.CLAUDE_BIN + " --continue",
            "resume": config.CLAUDE_BIN + " --resume",
        }
        return modes.get(mode, config.CLAUDE_BIN)
    raise ValueError(f"不支持的终端类型: {ttype}")


@app.post("/api/sessions")
async def create_session(request: Request, _=Depends(require_auth)):
    body = await request.json()
    cwd = body.get("cwd", "")
    ttype = body.get("type", "claude")
    mode = body.get("mode", "new")
    available = {
        "claude": config.CLAUDE_OK,
        "codex": config.CODEX_OK,
        "opencode": config.OPENCODE_OK,
        "shell": True,
    }
    if ttype not in available:
        raise HTTPException(status_code=400, detail=f"不支持的终端类型: {ttype}")
    if not available[ttype]:
        raise HTTPException(status_code=503, detail=f"{ttype} 命令当前不可用")
    p = safe_resolve(cwd)
    if not p.is_dir():
        raise HTTPException(status_code=400, detail="目标不是一个目录")
    sid = tmux_mgr.gen_id()
    try:
        tmux_mgr.start_session(sid, str(p), _launch_cmd(ttype, mode), {"type": ttype, "mode": mode})
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    tab = {"id": sid, "cwd": str(p), "type": ttype, "mode": mode, "created": _now(), "title": _title(str(p))}
    store.add_tab(tab)
    return {**tab, "alive": True, "attached": 0}


@app.post("/api/sessions/{sid}/stop")
def stop_session(sid: str, _=Depends(require_auth)):
    if not store.get_tab(sid):
        raise HTTPException(status_code=404, detail="没有这个标签")
    tmux_mgr.kill_session(tmux_mgr.session_name(sid))  # ok if already gone
    return {"ok": True, "alive": False}


@app.post("/api/sessions/{sid}/start")
def start_session(sid: str, _=Depends(require_auth)):
    tab = store.get_tab(sid)
    if not tab:
        raise HTTPException(status_code=404, detail="没有这个标签")
    if not tmux_mgr.session_exists(tmux_mgr.session_name(sid)):
        if not Path(tab["cwd"]).is_dir():
            raise HTTPException(status_code=400, detail="原目录已不存在，无法重启")
        ttype = tab.get("type", "claude")
        if ttype == "claude":
            cmd, mode = config.CLAUDE_BIN + " --continue", "continue"  # resume conversation
        elif ttype == "codex":
            cmd, mode = _launch_cmd("codex", tab.get("mode", "new")), tab.get("mode", "new")
        elif ttype == "opencode":
            cmd, mode = config.OPENCODE_BIN, tab.get("mode", "new")
        else:
            cmd, mode = "", "new"  # plain shell
        try:
            tmux_mgr.start_session(sid, tab["cwd"], cmd, {"type": ttype, "mode": mode})
        except RuntimeError as e:
            raise HTTPException(status_code=500, detail=str(e))
        store.update_tab(sid, mode=mode)
    tab = store.get_tab(sid)
    return {**tab, "alive": True, "attached": 0}


@app.post("/api/sessions/{sid}/rename")
async def rename_tab(sid: str, request: Request, _=Depends(require_auth)):
    if not store.get_tab(sid):
        raise HTTPException(status_code=404, detail="没有这个标签")
    body = await request.json()
    name = (body.get("name") or "").strip()
    store.update_tab(sid, name=name)
    return {"ok": True, "name": name}


@app.delete("/api/sessions/{sid}")
def delete_session(sid: str, _=Depends(require_auth)):
    name = tmux_mgr.session_name(sid)
    if tmux_mgr.session_exists(name):
        tmux_mgr.kill_session(name)
    store.remove_tab(sid)
    return {"ok": True}


# --- Presence (who is connected — leak monitoring) --------------------------
# State lives in presence.py's shared file, not in this process. Deployments may
# expose multiple uvicorn workers or entry points, so an in-memory dictionary
# would give each process a different view of connected clients.
_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def _client_ip(headers, fallback: str) -> str:
    # Trust X-Forwarded-For only from a loopback peer, where a local reverse
    # proxy may be running. A direct remote client must not be able to forge
    # this header and poison the known-IP ledger.
    xff = headers.get("x-forwarded-for")
    if xff and fallback in _LOOPBACK:
        return xff.split(",")[0].strip()
    return fallback or "?"


def _client_scheme(request_or_ws, headers, peer: str) -> str:
    proto = headers.get("x-forwarded-proto") if peer in _LOOPBACK else None
    return (proto or request_or_ws.url.scheme or "").lower()


@app.post("/api/presence")
async def presence(request: Request, _=Depends(require_auth)):
    body = await request.json()
    cid = body.get("clientId") or secrets.token_hex(8)
    ip = _client_ip(request.headers, request.client.host if request.client else "?")
    ua = request.headers.get("user-agent", "")
    # A local HTTPS proxy represents a proxied visitor; plain loopback HTTP is
    # treated as a direct connection.
    via = "tunnel" if _client_scheme(request, request.headers, request.client.host if request.client else "?") in ("https", "wss") else "direct"
    await asyncio.to_thread(presence_store.touch_client, cid, ip, ua, via)
    return await asyncio.to_thread(presence_store.summary, ip, cid, via)


@app.get("/api/ips")
async def ips_list(_=Depends(require_auth)):
    return {"ips": await asyncio.to_thread(known_ips.list_all)}


@app.post("/api/ips")
async def ips_edit(request: Request, _=Depends(require_auth)):
    body = await request.json()
    ip = (body.get("ip") or "").strip()
    if not ip:
        raise HTTPException(status_code=400, detail="缺少 ip")
    if body.get("action") == "forget":
        await asyncio.to_thread(known_ips.forget, ip)
        return {"ok": True}
    entry = await asyncio.to_thread(known_ips.label, ip, body.get("name"), body.get("trust"))
    return {"ok": True, "entry": entry}


# --- Storage monitor ----------------------------------------------------------
@app.get("/api/disk")
async def disk_status(_=Depends(require_auth)):
    hosts = gpu.list_hosts()
    return {"hosts": await asyncio.to_thread(disk.snapshot, hosts)}


@app.get("/api/disk/usage")
async def disk_usage(addr: str = "local", path: str = "", refresh: int = 0, _=Depends(require_auth)):
    if not path:
        raise HTTPException(status_code=400, detail="缺少 path")
    return await asyncio.to_thread(disk.usage, addr, path, bool(refresh))


# --- GPU monitor -------------------------------------------------------------
@app.get("/api/gpu")
async def gpu_status(refresh: int = 0, _=Depends(require_auth)):
    # Probing shells out (ssh for remote hosts), so keep it off the event loop.
    hosts = await asyncio.to_thread(gpu.snapshot, bool(refresh))
    return {"hosts": hosts}


@app.get("/api/gpu/hosts")
async def gpu_hosts(_=Depends(require_auth)):
    return {"hosts": gpu.list_hosts()}


@app.post("/api/gpu/hosts")
async def gpu_hosts_edit(request: Request, _=Depends(require_auth)):
    body = await request.json()
    action = body.get("action", "add")
    try:
        if action == "del":
            hosts = gpu.del_host((body.get("addr") or "").strip())
        else:
            hosts = gpu.add_host(body.get("name", ""), body.get("addr", ""))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"hosts": hosts}


# --- Terminal WebSocket ------------------------------------------------------
def _set_winsize(fd: int, rows: int, cols: int):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


@app.websocket("/ws/term/{sid}")
async def ws_term(websocket: WebSocket, sid: str):
    if not check_ws_token(websocket.cookies.get(AUTH_COOKIE, "")):
        await websocket.close(code=4401)
        return

    name = tmux_mgr.session_name(sid)
    if not tmux_mgr.session_exists(name):
        await websocket.close(code=4404)
        return

    await websocket.accept()

    conn_id = secrets.token_hex(6)
    ws_ip = _client_ip(websocket.headers, websocket.client.host if websocket.client else "?")
    ws_peer = websocket.client.host if websocket.client else "?"
    ws_via = "tunnel" if _client_scheme(websocket, websocket.headers, ws_peer) in ("wss", "https") else "direct"
    presence_store.add_ws(conn_id, ws_ip, sid, ws_via, websocket.headers.get("user-agent", ""))

    pid, master_fd = pty.fork()
    if pid == 0:
        # tmux refuses to attach without a usable terminal definition; service
        # environments may inherit TERM=dumb, so force a capable value here.
        os.environ["TERM"] = "xterm-256color"
        os.execvp("tmux", ["tmux", "attach-session", "-t", name])
        os._exit(1)

    _set_winsize(master_fd, 24, 80)
    os.set_blocking(master_fd, False)

    loop = asyncio.get_running_loop()
    out_queue: asyncio.Queue = asyncio.Queue()

    def on_readable():
        try:
            data = os.read(master_fd, 65536)
        except (BlockingIOError, InterruptedError):
            return
        except OSError:
            data = b""
        out_queue.put_nowait(data if data else None)

    loop.add_reader(master_fd, on_readable)

    async def pump_out():
        try:
            while True:
                data = await out_queue.get()
                if data is None:
                    break
                await websocket.send_bytes(data)
        except Exception:
            pass
        finally:
            try:
                await websocket.close()
            except Exception:
                pass

    sender = asyncio.create_task(pump_out())

    scrolled = False  # tracks whether we've entered tmux copy-mode via wheel
    try:
        while True:
            msg = await websocket.receive_text()
            obj = json.loads(msg)
            t = obj.get("type")
            if t == "input":
                # If the user scrolled into copy-mode, typing should snap back to
                # the live prompt instead of being eaten as copy-mode navigation.
                if scrolled:
                    tmux_mgr.exit_copy_mode(name)
                    scrolled = False
                os.write(master_fd, obj.get("data", "").encode())
            elif t == "resize":
                _set_winsize(master_fd, int(obj.get("rows", 24)), int(obj.get("cols", 80)))
            elif t == "scroll":
                if tmux_mgr.scroll_session(name, int(obj.get("lines", 0))):
                    scrolled = True
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        presence_store.drop_ws(conn_id)
        loop.remove_reader(master_fd)
        sender.cancel()
        try:
            os.close(master_fd)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass


# --- Static frontend (mounted last so /api and /ws win) ---------------------
@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="static")
