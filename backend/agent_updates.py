"""Verified shared CLI updates; never overwrite a running executable."""
from functools import lru_cache
import hashlib
import http.client
import json
import logging
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import ssl
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

if __package__:
    from backend import agent_sessions as sessions
    from backend import shared_install as shared
else:
    import agent_sessions as sessions
    import shared_install as shared

AGENTS = ("codex", "claude", "opencode")
VERSION = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\Z")
MAX_DOWNLOAD = 512 * 1024 * 1024
CACHE_SECONDS = 600
BUSY_PHASES = {"queued", "downloading", "extracting", "checking", "activating", "restarting"}
HOSTS = {"api.github.com", "github.com", "release-assets.githubusercontent.com",
         "objects.githubusercontent.com", "downloads.claude.ai", "releases.openai.com"}
LOG = logging.getLogger(__name__)


class UpdateError(RuntimeError):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


def _agent(value):
    if value not in AGENTS:
        raise UpdateError("不支持的终端程序", 400)
    return value


def _root(root=None):
    if root is None:
        if __package__:
            from backend import config
            root = config.AGENT_UPDATE_DIR
        else:
            root = os.environ.get("CC_WEB_AGENT_UPDATE_DIR") or Path.home() / ".cache/cc-web-terminal/updates"
    return sessions.runtime_dir(root)


def _load(key, suffix, root=None):
    return sessions.load(key, _root(root), suffix=suffix)


def _save(key, value, suffix, root=None):
    sessions.save(key, value, _root(root), suffix=suffix)


def version_key(value):
    match = VERSION.fullmatch(value or "")
    return tuple(map(int, match.groups())) if match else None


def selected_binary(agent, fallback, root=None):
    _agent(agent)
    # Version records are audit/rollback data, no longer a second executable selector.
    if not fallback or not Path(fallback).is_file() or not os.access(fallback, os.X_OK):
        raise UpdateError("共享程序入口不可用，不会静默切换到另一套程序")
    return fallback


def _probe_env(temporary):
    return {"PATH": os.environ.get("PATH", os.defpath), "HOME": temporary,
            "CODEX_HOME": temporary, "CLAUDE_CONFIG_DIR": temporary,
            "XDG_CONFIG_HOME": temporary, "XDG_DATA_HOME": temporary, "XDG_STATE_HOME": temporary,
            "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "OPENCODE_DISABLE_AUTOUPDATE": "true",
            "OPENCODE_DISABLE_MODELS_FETCH": "true", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true"}


def _stat(path):
    info = os.stat(path)
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


@lru_cache(maxsize=128)
def _probe(path, identity, agent):
    with tempfile.TemporaryDirectory(prefix="webcc-version-") as temporary:
        result = subprocess.run([path, "--version"], stdin=subprocess.DEVNULL,
                                cwd=temporary, env=_probe_env(temporary),
                                capture_output=True, text=True, timeout=12)
    if result.returncode or _stat(path) != identity:
        return None
    text = result.stdout.strip()
    patterns = {"codex": r"codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:-[\w.-]+)?)",
                "claude": r"(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\s+\(Claude Code\))?",
                "opencode": r"(?:opencode\s+)?(\d+\.\d+\.\d+(?:-[\w.-]+)?)"}
    match = re.fullmatch(patterns[agent], text)
    return match.group(1) if match else None


def installed_version(agent, path):
    try:
        return _probe(path, _stat(path), agent) if path else None
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        return None


def running_version(sid):
    """Probe the actual foreground ELF, including an unlinked older executable."""
    from backend import terminal_restart
    try:
        pane = terminal_restart._existing_pane(sid)
        foreground = terminal_restart._foreground(pane) if pane else None
        if not foreground:
            return {"agent": None, "version": None, "reason": "当前没有运行原生终端程序"}
        executable = f"/proc/{foreground['pid']}/exe"
        name = Path(os.readlink(executable).removesuffix(" (deleted)")).name
        native_name = name in {foreground["comm"], "claude-code", "codex-cli"} or (
            foreground["comm"] == "claude" and version_key(name) is not None)
        if not native_name:
            return {"agent": foreground["comm"], "version": None, "reason": "无法确认运行中程序的版本"}
        with open(executable, "rb") as stream:
            if stream.read(4) != b"\x7fELF":
                raise ValueError
        value = installed_version(foreground["comm"], executable)
        if not sessions.same_process(foreground):
            raise ValueError
        return {"agent": foreground["comm"], "version": value,
                "reason": "" if value else "运行版本无法读取"}
    except (OSError, ValueError, RuntimeError):
        return {"agent": None, "version": None, "reason": "无法识别此窗口的运行程序"}


def _url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname not in HOSTS or parsed.username or parsed.password
            or parsed.port not in (None, 443)):
        raise UpdateError("官方发布地址校验失败")
    return url


class _Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return super().redirect_request(request, fp, code, msg, headers, _url(newurl))


def _open(url, timeout=20):
    request = urllib.request.Request(_url(url), headers={"User-Agent": "Easy-Web-Vibecoding/version-check",
                                                         "Accept": "application/json"})
    return urllib.request.build_opener(_Redirect()).open(request, timeout=timeout)


def _text(url):
    with _open(url) as response:
        data = response.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise UpdateError("官方版本响应过大")
        return data.decode("utf-8")


def _platform(agent):
    arch = {"x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine())
    if platform.system() != "Linux" or not arch:
        raise UpdateError("当前服务器平台暂不支持自动更新", 400)
    if agent == "codex":
        target = "x86_64" if arch == "x64" else "aarch64"
        return f"codex-package-{target}-unknown-linux-musl.tar.gz", "bin/codex"
    musl = platform.libc_ver()[0] == "musl" or bool(list(Path("/lib").glob("ld-musl-*.so.1")))
    suffix = "-musl" if musl else ""
    if agent == "claude":
        return f"linux-{arch}{suffix}", "claude"
    baseline = "-baseline" if arch == "x64" else ""
    return f"opencode-linux-{arch}{baseline}{suffix}.tar.gz", "opencode"


def official_release(agent):
    """Only official stable release metadata. No credentials or model endpoints."""
    asset_name, executable = _platform(agent)
    if agent == "claude":
        base = "https://downloads.claude.ai/claude-code-releases"
        version = _text(base + "/latest").strip()
        if not version_key(version):
            raise UpdateError("官方稳定版本格式无效")
        manifest = json.loads(_text(f"{base}/{version}/manifest.json"))
        if manifest.get("version") != version:
            raise UpdateError("官方版本清单不一致")
        asset = manifest.get("platforms", {}).get(asset_name, {})
        checksum, size = asset.get("checksum"), asset.get("size")
        url = f"{base}/{version}/{asset_name}/claude"
        archive = False
    else:
        repo = "openai/codex" if agent == "codex" else "anomalyco/opencode"
        release = json.loads(_text(f"https://api.github.com/repos/{repo}/releases/latest"))
        tag = release.get("tag_name", "")
        prefix = "rust-v" if agent == "codex" else "v"
        version = tag.removeprefix(prefix)
        if not tag.startswith(prefix) or not version_key(version) or release.get("prerelease") or release.get("draft"):
            raise UpdateError("官方稳定发布信息无效")
        matches = [item for item in release.get("assets", []) if item.get("name") == asset_name]
        if len(matches) != 1:
            raise UpdateError("官方发布中缺少当前平台的完整安装包")
        asset = matches[0]
        digest = asset.get("digest", "") or ""
        checksum = digest.removeprefix("sha256:") if digest.startswith("sha256:") else None
        size = asset.get("size")
        url = f"https://github.com/{repo}/releases/download/{tag}/{asset_name}"
        if asset.get("browser_download_url") != url:
            raise UpdateError("官方安装包地址不一致")
        archive = True
    if not isinstance(checksum, str) or not re.fullmatch(r"[a-f0-9]{64}", checksum):
        raise UpdateError("官方发布未提供有效 SHA-256，不能自动更新")
    if not isinstance(size, int) or not 0 < size <= MAX_DOWNLOAD:
        raise UpdateError("官方安装包大小无效")
    return {"version": version, "url": url, "sha256": checksum, "size": size,
            "archive": archive, "executable": executable, "checkedAt": time.time(), "checkId": str(uuid.uuid4())}


def check_latest(agent):
    _agent(agent)
    root = _root()
    with sessions.lock(agent, "catalog", root=root):
        cached = _load(agent, ".catalog.json", root)
        # Explicit clicks are coalesced across both backends and all browsers.
        if time.time() - cached.get("attemptedAt", 0) < 60:
            return cached
        try:
            cached = {**official_release(agent), "attemptedAt": time.time()}
        except (OSError, ValueError, RuntimeError, urllib.error.URLError):
            cached = {"attemptedAt": time.time(), "error": "未能读取官方版本，请检查服务器网络后重新检测"}
        _save(agent, cached, ".catalog.json", root)
        return cached


def _comparison(installed, latest):
    left, right = version_key(installed), version_key(latest)
    if not left or not right:
        return "unknown"
    return "outdated" if left < right else "newer" if left > right else "latest"


def public_job(job):
    return {key: job[key] for key in ("requestId", "agent", "mode", "sid", "phase", "version", "message",
                                     "installed", "resumed", "startedAt", "finishedAt", "received", "total", "result") if key in job}


def _save_job(agent, job):
    if sessions.conversation_id(job.get("requestId")):
        _save("request-" + job["requestId"], job, ".request.json")
    _save(agent, job, ".job.json")


def _signature(agent, body):
    values = {key: body.get(key) for key in ("mode", "sid", "expected", "version", "checkId", "allowMajor")}
    return hashlib.sha256(json.dumps([agent, values], sort_keys=True).encode()).hexdigest()


def selection_id(entry):
    return hashlib.sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest()


def _repeat(job, signature):
    if job.get("signature") != signature:
        raise UpdateError("请求编号已用于另一项操作，请重新检测", 400)
    return public_job(job)


def _job(agent):
    job = _load(agent, ".job.json")
    if job.get("phase") in BUSY_PHASES:
        try:
            with sessions.lock(agent, "update", root=_root(), blocking=False):
                active = _load(agent, ".active.json")
                if active.get("requestId") == job.get("requestId") and shared.matches(active):
                    job["installed"] = True
                job.update(phase="interrupted", finishedAt=time.time(),
                           message="更新进程已中断；未自动重试，请重新检测。原生任务不会被强制关闭。")
                _save_job(agent, job)
        except BlockingIOError:
            pass
    return job


def overview(sid=None, check=False):
    from backend import config, terminal_launch, terminal_restart, store
    env = terminal_launch.session_environment(use_updates=False)
    running = running_version(sid) if sid else {"agent": None, "version": None, "reason": "未选择终端"}
    preview = None
    if sid:
        tab = store.get_tab(sid)
        if not tab:
            raise UpdateError("没有这个终端", 404)
        try:
            preview = terminal_restart.inspect(sid, tab)
        except terminal_restart.RestartError as exc:
            hint = running.get("agent") or sessions.load(sid).get("agent") or tab.get("type")
            preview = {"ready": False, "reason": str(exc), "agent": hint if hint in AGENTS else None}
    rows = []
    for agent in AGENTS:
        install_error = ""
        binary = env.get("CC_WEB_REAL_" + agent.upper(), "")
        try:
            binary = selected_binary(agent, binary)
            local = installed_version(agent, binary)
        except UpdateError:
            local = None
            install_error = "共享安装不可用，请检查原生程序入口"
        catalog = check_latest(agent) if check else _load(agent, ".catalog.json")
        fresh = time.time() - catalog.get("checkedAt", 0) < CACHE_SECONDS
        latest = catalog.get("version") if fresh and not catalog.get("error") else None
        current = running.get("version") if running.get("agent") == agent else None
        try:
            _platform(agent)
            supported = True
        except UpdateError:
            supported = False
        active = _load(agent, ".active.json")
        try:
            shared.writable(shared.plan(agent, binary))
            writable = True
        except (OSError, shared.SharedInstallError):
            writable = False
            if not install_error:
                install_error = "共享安装不可安全写入，请使用原安装方式更新"
        same_entry = active.get("commonPath") == binary
        managed = same_entry and shared.matches(active)
        job = public_job(_job(agent))
        superseded = (job.get("phase") in {"failed", "interrupted"} and not job.get("installed")
                      and _comparison(local, job.get("version")) in {"latest", "newer"})
        rows.append({"agent": agent, "installed": local, "latest": latest, "running": current,
                     "runningStatus": _comparison(current, latest), "status": _comparison(local, latest),
                     "checkedAt": catalog.get("checkedAt"), "checkId": catalog.get("checkId"),
                     "error": install_error or catalog.get("error") or ("请检测官方版本" if not fresh else ""),
                     "canUpdate": supported and writable and _comparison(local, latest) == "outdated",
                     "installation": "shared", "managed": managed,
                     "canRollback": same_entry and shared.matches(active, allow_broken=True) and bool(active.get("previous")), "selectionId": selection_id(active),
                     "job": job, "jobSuperseded": superseded})
    return {"agents": rows, "sid": sid, "current": running, "resume": preview}


def _download(release, destination, progress):
    if shutil.disk_usage(destination.parent).free < release["size"] * 5 + 128 * 1024 * 1024:
        raise UpdateError("可用磁盘空间不足，原安装未改变")
    deadline = time.monotonic() + 480
    url = release["url"]
    asset = Path(urllib.parse.urlsplit(url).path).name
    urls = [url]
    if url.startswith("https://github.com/openai/codex/releases/download/") and asset.startswith("codex-package-"):
        urls.insert(0, "https://releases.openai.com/codex/releases/" + release["version"] + "/" + asset)
    for attempt in range(3):
        digest, count = hashlib.sha256(), 0
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise UpdateError("下载安装包超过 8 分钟，原安装未改变")
        try:
            with _open(urls[min(attempt, len(urls) - 1)], timeout=min(60, remaining)) as response, destination.open("wb") as output:
                while True:
                    if time.monotonic() > deadline:
                        raise UpdateError("下载安装包超过 8 分钟，原安装未改变")
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    count += len(chunk)
                    if count > release["size"] or count > MAX_DOWNLOAD:
                        raise UpdateError("下载安装包大小不符，原安装未改变")
                    digest.update(chunk)
                    output.write(chunk)
                    progress(count)
                output.flush()
                os.fsync(output.fileno())
            if count != release["size"] or digest.hexdigest() != release["sha256"]:
                raise UpdateError("安装包 SHA-256 校验失败，原安装未改变")
            return
        except (TimeoutError, ConnectionError, urllib.error.URLError, http.client.IncompleteRead, ssl.SSLError) as exc:
            LOG.warning("CLI download failed attempt=%s kind=%s status=%s received=%s", attempt + 1,
                        type(exc).__name__, getattr(exc, "code", None), count)
            if isinstance(exc, urllib.error.HTTPError) and exc.code not in {408, 429, 500, 502, 503, 504}:
                if attempt + 1 >= len(urls):
                    raise UpdateError("官方安装包下载被拒绝（HTTP " + str(exc.code) + "），原安装未改变") from exc
            if attempt == 2:
                raise UpdateError("官方安装包下载连接失败，已尝试 3 次；原安装未改变") from exc
            progress(0)


def _extract(archive, destination):
    total, count, links = 0, 0, []
    with tarfile.open(archive, "r:gz") as package:
        for member in package:
            path = PurePosixPath(member.name)
            count += 1
            if (path.is_absolute() or ".." in path.parts or "\\" in member.name or count > 4096
                    or not (member.isfile() or member.isdir() or member.issym())):
                raise UpdateError("安装包含有不安全的路径或链接，原安装未改变")
            target = destination.joinpath(*path.parts)
            if member.issym():
                link = PurePosixPath(member.linkname)
                resolved = (target.parent / member.linkname).resolve()
                if link.is_absolute() or "\\" in member.linkname or not resolved.is_relative_to(destination.resolve()):
                    raise UpdateError("安装包含有越界链接，原安装未改变")
                links.append((target, member.linkname))
                continue
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
                continue
            total += member.size
            if total > 2 * 1024 * 1024 * 1024:
                raise UpdateError("安装包解压大小超限")
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            source = package.extractfile(member)
            with source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o700 if member.mode & 0o111 else 0o600)
    # Library aliases are allowed only after regular extraction, never as parents.
    for target, link in links:
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        target.symlink_to(link)
    for target, _ in links:
        try:
            resolved = target.resolve(strict=True)
            if not resolved.is_relative_to(destination.resolve()) or not resolved.is_file():
                raise ValueError
        except (OSError, RuntimeError, ValueError):
            raise UpdateError("安装包链接目标无效，原安装未改变")


def _stage(agent, release, progress, phase=None):
    root = _root()
    releases = root / "releases"
    if releases.is_symlink():
        raise UpdateError("更新目录不安全")
    releases.mkdir(mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".stage-", dir=root) as temporary:
        stage = Path(temporary)
        download = stage / "download"
        _download(release, download, progress)
        if phase:
            phase("extracting", "正在解包已校验的官方安装包", received=release["size"])
        payload = stage / "payload"
        payload.mkdir(mode=0o700)
        if release["archive"]:
            _extract(download, payload)
        else:
            os.replace(download, payload / agent)
            (payload / agent).chmod(0o700)
        binary = payload / release["executable"]
        if phase:
            phase("checking", "正在离线检查实际程序版本")
        # OpenCode archives use a platform-named root folder.
        if not binary.is_file() and agent == "opencode":
            found = list(payload.glob("*/opencode"))
            if len(found) == 1:
                binary = found[0]
        if not binary.is_file() or installed_version(agent, str(binary)) != release["version"]:
            raise UpdateError("下载版本与官方清单不符，原安装未改变")
        if agent == "codex" and any(not os.access(payload / name, os.X_OK) for name in
                                    ("bin/codex-code-mode-host", "codex-path/rg", "codex-resources/bwrap")):
            raise UpdateError("Codex 完整安装包缺少配套程序，原安装未改变")
        relative = binary.relative_to(payload)
        final = releases / (agent + "-" + release["version"] + "-" + uuid.uuid4().hex)
        os.replace(payload, final)
        return {"path": str(final / relative), "version": release["version"], "sha256": release["sha256"]}


def _validate(agent, path, sid=None, expected=None):
    from backend import terminal_launch, terminal_preflight, terminal_restart, store
    env = terminal_launch.session_environment(use_updates=False)
    arguments = []
    if sid:
        tab = store.get_tab(sid)
        if not tab:
            raise UpdateError("目标终端已删除，原任务未退出")
        preview = terminal_restart.inspect(sid, tab)
        if not preview.get("ready") or preview.get("expected") != expected or preview.get("agent") != agent:
            raise UpdateError("目标会话已改变或无法恢复，原任务未退出")
        arguments = terminal_restart.resume_arguments(sessions.load(sid))
    terminal_preflight.check(agent, path, terminal_launch.guarded_arguments(agent, arguments, env))


def _worker(agent, job, release, lock):
    installed, entry = False, None
    def save(phase=None, message=None, **fields):
        job.update(fields)
        if phase:
            job["phase"] = phase
        if message:
            job["message"] = message
        _save_job(agent, job)
    try:
        save("downloading", "正在下载官方安装包", total=release["size"], received=0)
        last = [0.0]
        def progress(count):
            if count == 0 or time.monotonic() - last[0] > 1:
                last[0] = time.monotonic()
                save(received=count)
        entry = _stage(agent, release, progress, save)
        save("checking", "正在离线检查版本与恢复参数", received=release["size"])
        _validate(agent, entry["path"], job.get("sid"), job.get("expected"))
        from backend import terminal_launch
        current_path = terminal_launch.session_environment()["CC_WEB_REAL_" + agent.upper()]
        layout = shared.plan(agent, current_path)
        with shared.install_lock(layout):
            if (installed_version(agent, current_path) != job["fromVersion"]
                    or shared.identity(current_path) != job["fromIdentity"]):
                raise UpdateError("共享安装在下载期间已改变，请重新检测；原任务未退出")
            save("activating", "正在切换网页与 SSH 共用的程序版本")
            previous = shared.previous(layout, _root(), job["fromVersion"])
            entry = shared.prepare(layout, entry, release)
            if shared.identity(current_path) != job["fromIdentity"]:
                raise UpdateError("共享安装在准备期间已改变，请重新检测；原任务未退出")
            active = {**entry, "scope": "shared", "commonPath": current_path, "layout": layout,
                      "selectedPath": str(Path(current_path).absolute()) if layout["kind"] == "file" else entry["path"],
                      "binaryHash": shared.digest(entry["path"]), "generation": uuid.uuid4().hex,
                      "requestId": job["requestId"], "previous": previous}
            # Persist intent first so a crash after the atomic switch remains recoverable.
            old_active = _load(agent, ".active.json")
            _save(agent, active, ".active.json")
            try:
                shared.activate(layout, entry, previous)
            except Exception:
                # A secondary marker failure must not leave a partial selection.
                shared.restore(previous)
                _save(agent, old_active, ".active.json")
                raise
            installed = True
            active["identity"] = shared.identity(current_path)
            _save(agent, active, ".active.json")
        save(installed=True)
        if job["mode"] == "update-restart":
            from backend import terminal_restart, store
            if not shared.matches(active):
                raise UpdateError("共享安装已被其他终端更新，取消本次重启；原任务未退出")
            save("restarting", "正在重启目标窗口并验证原会话")
            tab = store.get_tab(job["sid"])
            if not tab:
                raise UpdateError("目标终端已删除，新版已安装但没有执行重启")
            result = terminal_restart.restart(job["sid"], tab, {
                "requestId": job["requestId"], "expected": job["expected"], "confirmed": True})
            save(result=result, resumed=True)
        save("done", "共享版本已更新，已恢复原会话" if job.get("resumed") else "共享版本已更新；现有任务不重启，后续网页与 SSH 启动使用新版", finishedAt=time.time())
    except Exception as exc:
        phase = job.get("phase", "queued")
        diagnostic = {"stage": phase, "kind": type(exc).__name__, "errno": getattr(exc, "errno", None),
                      "status": getattr(exc, "code", None)}
        LOG.warning("CLI update failed agent=%s stage=%s kind=%s errno=%s status=%s", agent, phase,
                    diagnostic["kind"], diagnostic["errno"], diagnostic["status"])
        message = str(exc) if isinstance(exc, (UpdateError, shared.SharedInstallError)) else {
            "downloading": "安装包下载或写入失败，原安装未改变",
            "extracting": "安装包解包失败，原安装未改变",
            "checking": "程序版本或恢复参数检查失败，原任务未退出",
            "activating": "共享安装切换失败，请检查目录权限与更新记录",
            "restarting": "目标会话重启或恢复检查失败，请检查原终端",
        }.get(phase, "更新准备失败，原任务未退出")
        if installed:
            message = "新版已安装，但未确认会话恢复。请查看原终端；不会重复发送恢复命令。 " + message
        save("failed", message, installed=installed, finishedAt=time.time(), diagnostic=diagnostic)
    finally:
        if entry and not installed:
            try:
                releases = _root() / "releases"
                relative = Path(entry["path"]).resolve().relative_to(releases.resolve())
                shutil.rmtree(releases / relative.parts[0])
            except (OSError, ValueError, IndexError):
                pass
        lock.__exit__(None, None, None)


def start_update(agent, body):
    from backend import terminal_launch, terminal_restart, store
    _agent(agent)
    if not isinstance(body, dict) or body.get("confirmed") is not True:
        raise UpdateError("更新需要明确确认", 400)
    request_id = sessions.conversation_id(body.get("requestId"))
    if not request_id or body.get("mode") not in {"update", "update-restart"}:
        raise UpdateError("更新请求无效", 400)
    root = _root()
    signature = _signature(agent, body)
    previous = _load("request-" + request_id, ".request.json", root)
    if previous:
        return _repeat(previous, signature)
    lock = sessions.lock(agent, "update", root=root, blocking=False)
    try:
        lock.__enter__()
    except BlockingIOError:
        current = _load(agent, ".job.json")
        if current.get("requestId") == request_id:
            return _repeat(current, signature)
        raise UpdateError("此程序正在更新，请勿重复提交")
    handed_off = False
    try:
        old = _load(agent, ".job.json")
        if old.get("requestId") == request_id:
            return _repeat(old, signature)
        release = _load(agent, ".catalog.json")
        if (release.get("error") or time.time() - release.get("checkedAt", 0) >= CACHE_SECONDS
                or body.get("checkId") != release.get("checkId") or body.get("version") != release.get("version")):
            raise UpdateError("版本检测已过期或已改变，请重新检测")
        env = terminal_launch.session_environment()
        installed = installed_version(agent, env.get("CC_WEB_REAL_" + agent.upper(), ""))
        if _comparison(installed, release.get("version")) != "outdated":
            raise UpdateError("当前无需更新，或无法确认安装版本；请重新检测")
        if version_key(installed)[0] != version_key(release["version"])[0] and body.get("allowMajor") is not True:
            raise UpdateError("跨主版本更新需要额外确认", 400)
        sid = body.get("sid") if body["mode"] == "update-restart" else None
        if body["mode"] == "update-restart":
            if not isinstance(sid, str) or not sessions.SID_RE.fullmatch(sid):
                raise UpdateError("目标终端无效", 400)
            tab = store.get_tab(sid)
            if not tab:
                raise UpdateError("没有这个终端", 404)
            preview = terminal_restart.inspect(sid, tab)
            if not preview.get("ready") or preview.get("agent") != agent or preview.get("expected") != body.get("expected"):
                raise UpdateError("原会话无法准确恢复或已经改变，不会执行更新与重启")
        current = env["CC_WEB_REAL_" + agent.upper()]
        try:
            shared.writable(shared.plan(agent, current))
        except shared.SharedInstallError as exc:
            raise UpdateError(str(exc)) from exc
        job = {"requestId": request_id, "agent": agent, "mode": body["mode"], "sid": sid,
               "expected": body.get("expected") if sid else None, "phase": "queued", "version": release["version"],
               "startedAt": time.time(), "message": "更新请求已提交", "installed": False, "resumed": False,
               "signature": signature, "fromVersion": installed, "fromIdentity": shared.identity(current)}
        _save_job(agent, job)
        worker = threading.Thread(target=_worker, args=(agent, job.copy(), release, lock), daemon=True)
        worker.start()
        handed_off = True
        return public_job(job)
    finally:
        if not handed_off:
            lock.__exit__(None, None, None)


def rollback(agent, body):
    from backend import terminal_launch
    _agent(agent)
    if not isinstance(body, dict) or body.get("confirmed") is not True:
        raise UpdateError("回退需要明确确认", 400)
    root = _root()
    try:
        with sessions.lock(agent, "update", root=root, blocking=False):
            active = _load(agent, ".active.json")
            current_path = terminal_launch.session_environment(use_updates=False)["CC_WEB_REAL_" + agent.upper()]
            if (active.get("commonPath") != current_path or not shared.matches(active, allow_broken=True)
                    or not active.get("previous") or body.get("selectionId") != selection_id(active)):
                raise UpdateError("安装版本已改变或没有可回退版本，请重新检测")
            previous = active["previous"]
            layout = active["layout"]
            with shared.install_lock(layout):
                if not shared.matches(active, allow_broken=True):
                    raise UpdateError("共享安装已被其他终端更新，不会覆盖；请重新检测")
                _validate(agent, previous["path"])
                current = shared.previous(layout, root, active["version"]) if shared.matches(active) else None
                reverted = {"scope": "shared", "commonPath": active["commonPath"], "layout": layout,
                            "version": previous["version"], "generation": uuid.uuid4().hex, "previous": current,
                            "selectedPath": str(Path(layout["binary"]).absolute()) if previous["kind"] == "file" else previous["path"],
                            "binaryHash": shared.digest(previous["path"])}
                _save(agent, reverted, ".active.json")
                try:
                    shared.restore(previous)
                except Exception:
                    _save(agent, active, ".active.json")
                    raise
                reverted["identity"] = shared.identity(active["commonPath"])
                _save(agent, reverted, ".active.json")
            return {"ok": True, "message": "已回退共享安装版本；现有任务不重启，后续网页与 SSH 启动使用回退版本"}
    except BlockingIOError:
        raise UpdateError("此程序正在更新，不能同时回退")
    except shared.SharedInstallError as exc:
        raise UpdateError(str(exc)) from exc
