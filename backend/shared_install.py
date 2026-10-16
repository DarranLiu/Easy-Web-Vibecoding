"""Atomically update the user's shared CLI entry without overwriting live files."""
from contextlib import contextmanager
import fcntl
import hashlib
import os
from pathlib import Path
import shutil
import tempfile
import urllib.parse
import uuid


class SharedInstallError(RuntimeError):
    pass


def identity(path):
    path = Path(path)
    link = path.lstat()
    target = path.stat()
    return [str(path), os.readlink(path) if path.is_symlink() else None,
            link.st_dev, link.st_ino, link.st_mtime_ns,
            target.st_dev, target.st_ino, target.st_size, target.st_mtime_ns]


def redirect_npm_codex(alias, binary, root):
    """Explicit migration only: retain the unused npm package and back up its entry."""
    if __package__:
        from backend import agent_sessions as sessions
    else:
        import agent_sessions as sessions
    alias, binary = Path(alias).absolute(), Path(binary).absolute()
    if alias == binary or not alias.is_symlink():
        return False
    target = os.readlink(alias)
    if str((alias.parent / target).resolve()) == str(binary.resolve()):
        return False
    npm_entry = (alias.parent / target).resolve()
    if npm_entry.parts[-6:] != ("lib", "node_modules", "@openai", "codex", "bin", "codex.js"):
        raise SharedInstallError("旧入口不是可确认的 npm Codex，未修改")
    writable(plan("codex", str(alias)))
    if not binary.is_file() or not os.access(binary, os.X_OK) or binary.stat().st_uid != os.getuid():
        raise SharedInstallError("共用 Codex 入口不可确认，未修改旧入口")
    before = identity(alias)
    sessions.save("codex-npm-entry", {"path": str(alias), "target": target,
                  "commonPath": str(binary), "before": before}, root, suffix=".migration.json")
    if identity(alias) != before:
        raise SharedInstallError("旧入口在迁移期间已改变，未覆盖")
    _replace_link(alias, binary)
    return True


def plan(agent, binary):
    path = Path(binary).absolute()
    result = {"binary": str(path), "switch": str(path), "kind": "file" if agent == "opencode" else "link"}
    if path.is_symlink():
        target = Path(os.readlink(path))
        if not target.is_absolute():
            target = path.parent / target
        if agent == "codex" and target.parts[-3:] == ("current", "bin", "codex"):
            current = target.parent.parent
            if current.is_symlink() and current.parent.name == "standalone":
                result.update(kind="bundle", switch=str(current), releases=str(current.parent / "releases"),
                              lock=str(current.parent / "install.lock"), channel=str(current.parent / "auto-update-version"))
        elif agent == "claude" and target.parent.name == "versions" and target.parent.parent.name == "claude":
            result["releases"] = str(target.parent)
    return result


def writable(layout):
    switch = Path(layout["switch"])
    parent = switch.parent
    if (not switch.is_symlink() and not switch.is_file()) or switch.lstat().st_uid != os.getuid():
        raise SharedInstallError("共享程序入口不属于当前用户，不能自动更新；请使用原安装方式")
    if parent.stat().st_uid != os.getuid() or not os.access(parent, os.W_OK) or parent.stat().st_mode & 0o002:
        raise SharedInstallError("共享安装目录不可安全写入；请使用原安装方式更新")


@contextmanager
def install_lock(layout):
    writable(layout)
    if not layout.get("lock"):
        yield
        return
    fd = os.open(layout["lock"], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if os.fstat(fd).st_uid != os.getuid():
            raise SharedInstallError("原生安装锁归属异常，未改变共享安装")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SharedInstallError("普通终端正在更新 Codex，请等待完成后重新检测")
        yield
    finally:
        os.close(fd)


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def _same_bundle(source, target):
    if target.is_symlink() or not target.is_dir() or target.stat().st_uid != os.getuid():
        return False
    for item in source.rglob("*"):
        other = target / item.relative_to(source)
        if item.is_symlink():
            if not other.is_symlink() or os.readlink(item) != os.readlink(other):
                return False
        elif item.is_file():
            if other.is_symlink() or not other.is_file() or other.stat().st_uid != os.getuid():
                return False
            if item.stat().st_size != other.stat().st_size or digest(item) != digest(other):
                return False
        elif not other.is_dir() or other.is_symlink():
            return False
    return True


def _replace_link(path, target):
    path = Path(path)
    temporary = path.parent / (".shared-" + uuid.uuid4().hex)
    try:
        temporary.symlink_to(target)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _replace_file(path, source):
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix=".shared-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output, Path(source).open("rb") as stream:
            shutil.copyfileobj(stream, output)
            output.flush()
            os.fsync(output.fileno())
            os.fchmod(output.fileno(), 0o700)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def previous(layout, root, version):
    switch = Path(layout["switch"])
    result = {"layout": layout, "version": version, "path": str(Path(layout["binary"]).resolve(strict=True))}
    if switch.is_symlink():
        result.update(kind="link", target=os.readlink(switch))
    else:
        directory = Path(root) / "releases" / ("previous-" + uuid.uuid4().hex)
        directory.mkdir(parents=True, mode=0o700)
        backup = directory / Path(layout["binary"]).name
        shutil.copy2(switch, backup)
        backup.chmod(0o700)
        result.update(kind="file", path=str(backup))
    if layout.get("channel"):
        channel = Path(layout["channel"])
        if channel.is_symlink():
            raise SharedInstallError("原生自动更新标记不安全，未改变共享安装")
        result["channel"] = channel.read_text() if channel.exists() else None
    return result


def prepare(layout, entry, release):
    """Use the existing native install layout where it is recognizable."""
    if not layout.get("releases"):
        return dict(entry)
    root = Path(layout["releases"])
    if root.is_symlink() or root.stat().st_uid != os.getuid():
        raise SharedInstallError("原生版本目录不安全，未改变共享安装")
    if layout["kind"] == "bundle":
        source = Path(entry["path"]).parent.parent
        asset = Path(urllib.parse.urlsplit(release["url"]).path).name
        platform = asset.removeprefix("codex-package-").removesuffix(".tar.gz")
        if not platform or "/" in platform or ".." in platform:
            raise SharedInstallError("Codex 安装包平台无效")
        target = root / (release["version"] + "-" + platform)
        if target.exists() or target.is_symlink():
            if not _same_bundle(source, target):
                raise SharedInstallError("目标版本目录已存在但内容不同；不会覆盖可能正在运行的程序")
        else:
            with tempfile.TemporaryDirectory(prefix=".shared-stage-", dir=root) as temporary:
                staged = Path(temporary) / "payload"
                shutil.copytree(source, staged, symlinks=True)
                if not (staged / "codex").exists():
                    (staged / "codex").symlink_to("bin/codex")
                os.rename(staged, target)
        return {**entry, "path": str(target / "bin/codex")}
    target = root / release["version"]
    if target.exists() or target.is_symlink():
        if target.is_symlink() or not target.is_file() or digest(target) != digest(entry["path"]):
            raise SharedInstallError("目标版本文件已存在但内容不同；原任务未退出")
    else:
        _replace_file(target, entry["path"])
    return {**entry, "path": str(target)}


def activate(layout, entry, previous=None):
    switch = Path(layout["switch"])
    if layout["kind"] == "file":
        _replace_file(switch, entry["path"])
    else:
        target = Path(entry["path"]).parent.parent if layout["kind"] == "bundle" else entry["path"]
        _replace_link(switch, target)
    if layout.get("channel") and previous and (previous.get("channel") or "").strip() == Path(previous["target"]).name:
        _write_channel(layout["channel"], Path(entry["path"]).parent.parent.name + "\n")


def matches(entry, allow_broken=False):
    if not isinstance(entry, dict):
        return False
    try:
        if entry.get("scope") != "shared":
            return False
        if entry.get("identity"):
            return identity(entry["commonPath"]) == entry["identity"]
        path = Path(entry["commonPath"])
        return str(path.resolve(strict=True)) == entry["selectedPath"] and digest(path) == entry["binaryHash"]
    except OSError:
        if allow_broken and entry.get("scope") == "shared" and entry.get("selectedPath"):
            try:
                path = Path(entry["commonPath"])
                return path.is_symlink() and str(path.resolve()) == entry["selectedPath"]
            except (OSError, KeyError, TypeError, ValueError, RuntimeError):
                return False
        return False
    except (KeyError, TypeError, ValueError, RuntimeError):
        return False


def restore(previous):
    layout = previous["layout"]
    if previous["kind"] == "link":
        _replace_link(layout["switch"], previous["target"])
    else:
        _replace_file(layout["switch"], previous["path"])
    if layout.get("channel") and "channel" in previous:
        _write_channel(layout["channel"], previous["channel"])


def _write_channel(path, value):
    path = Path(path)
    if value is None:
        path.unlink(missing_ok=True)
        return
    fd, name = tempfile.mkstemp(prefix=".shared-channel-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)
