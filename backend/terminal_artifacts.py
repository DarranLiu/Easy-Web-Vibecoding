"""Private copies of verified native executables, never account/config directories."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile

from backend import agent_sessions as sessions


def identity(path):
    info = Path(path).stat()
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]


def root():
    directory = sessions.runtime_dir() / "releases"
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid():
        raise RuntimeError("Unsafe recovery artifact directory")
    return directory


def validate(value, agent):
    path = Path(value.get("path", ""))
    base = root().resolve()
    if (not path.is_absolute() or not path.is_relative_to(base)
            or path.resolve(strict=True) != path or identity(path) != value.get("identity")
            or value.get("agent") != agent or not os.access(path, os.X_OK)):
        raise RuntimeError("Saved recovery program is unavailable or changed")
    return str(path)


def recognizes(path, agent):
    try:
        relative = Path(path).relative_to(root())
        key = relative.parts[0]
        value = sessions.load("artifact_" + key, suffix=".artifact.json")
        return validate(value, agent) == str(path)
    except (OSError, RuntimeError, ValueError, IndexError):
        return False


def capture(record):
    pid, agent = record["pid"], record["agent"]
    executable = Path(f"/proc/{pid}/exe")
    source = executable.resolve(strict=True)
    source_id = identity(executable)
    if not sessions.same_process(record) or identity(source) != source_id:
        raise RuntimeError("Native executable changed during inspection")
    if recognizes(source, agent):
        key = source.relative_to(root()).parts[0]
        return sessions.load("artifact_" + key, suffix=".artifact.json")
    with source.open("rb") as stream:
        if stream.read(4) != b"\x7fELF":
            raise RuntimeError("Only self-contained native builds can be saved for recovery")
    key = hashlib.sha256(json.dumps([agent, str(source), source_id]).encode()).hexdigest()[:40]
    with sessions.lock("artifact_" + key, "artifact"):
        saved = sessions.load("artifact_" + key, suffix=".artifact.json")
        if saved:
            validate(saved, agent)
            return saved
        # Codex standalone distributions have sibling hosts/resources. Copy the
        # distribution, not just the executable; npm's platform binary has a
        # separate sibling PATH directory and is treated the same way.
        bundle = None
        if agent == "codex" and source.parent.name == "bin" and (source.parent.parent / "codex-package.json").is_file():
            bundle = source.parent.parent
        elif agent == "codex" and source.parent.name == "codex" and (source.parent.parent / "path").is_dir():
            bundle = source.parent.parent
        files = [source] if bundle is None else list(bundle.rglob("*"))
        total, signatures, links = 0, {}, {}
        for item in files:
            info = item.lstat()
            if (not item.is_symlink() and info.st_mode & 0o022) or info.st_uid not in {0, os.getuid()}:
                raise RuntimeError("Recovery bundle is not privately owned")
            if item.is_symlink():
                target = os.readlink(item)
                if bundle is None or os.path.isabs(target) or not item.resolve(strict=True).is_relative_to(bundle):
                    raise RuntimeError("Recovery bundle contains an external symlink")
                links[str(item)] = target
            elif item.is_file():
                total += info.st_size
                signatures[str(item)] = identity(item)
            elif not stat.S_ISDIR(info.st_mode):
                raise RuntimeError("Recovery bundle contains a special file")
        if total > 2 * 1024 ** 3:
            raise RuntimeError("Recovery bundle exceeds the size limit")
        target = root() / key
        with tempfile.TemporaryDirectory(prefix=".capture-", dir=root()) as temporary:
            staging = Path(temporary) / "release"
            if bundle:
                shutil.copytree(bundle, staging, symlinks=True)
                relative = source.relative_to(bundle)
            else:
                staging.mkdir(mode=0o700)
                relative = Path(agent)
                shutil.copy2(source, staging / relative)
            if (not sessions.same_process(record) or identity(executable) != source_id
                    or any(identity(path) != value for path, value in signatures.items())
                    or any(os.readlink(path) != target for path, target in links.items())):
                raise RuntimeError("Native distribution changed during capture")
            if target.exists():
                # An interrupted capture has no manifest and cannot be trusted.
                shutil.rmtree(target)
            os.replace(staging, target)
        path = target / relative
        value = {"agent": agent, "path": str(path), "identity": identity(path)}
        sessions.save("artifact_" + key, value, suffix=".artifact.json")
        return value
