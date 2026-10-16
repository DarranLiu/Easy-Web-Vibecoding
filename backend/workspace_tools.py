"""Bounded, read-only Git/history and conflict-aware UTF-8 editing."""
from contextlib import contextmanager
import fcntl
import hashlib
import os
from pathlib import Path
import selectors
import stat
import subprocess
import tempfile
import time

from backend.workspaces import WorkspaceError

MAX_TEXT = 512 * 1024


def _text(raw):
    if len(raw) > MAX_TEXT or b"\x00" in raw:
        raise WorkspaceError("Binary or large files are read-only", 415)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise WorkspaceError("Only UTF-8 files can be edited without changing their encoding", 415) from exc


@contextmanager
def _open(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as exc:
        raise WorkspaceError("File is unavailable or is a symbolic link", 409) from exc
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise WorkspaceError("Not a regular file", 400)
        yield fd
    finally:
        os.close(fd)


def read_text(path):
    with _open(path) as fd:
        raw = os.read(fd, MAX_TEXT + 1)
    return {"text": _text(raw), "etag": hashlib.sha256(raw).hexdigest(), "encoding": "utf-8", "size": len(raw),
            "newline": "crlf" if b"\r\n" in raw and b"\n" not in raw.replace(b"\r\n", b"") else "lf"}


def write_text(path, body):
    if not isinstance(body.get("text"), str) or not isinstance(body.get("etag"), str):
        raise WorkspaceError("Text and original file revision are required")
    raw = body["text"].encode("utf-8")
    _text(raw)
    temporary = None
    with _open(path) as fd:
        fcntl.flock(fd, fcntl.LOCK_EX)
        before = os.fstat(fd)
        if before.st_nlink != 1:
            raise WorkspaceError("Hard-linked files are read-only", 415)
        original = os.read(fd, MAX_TEXT + 1)
        if hashlib.sha256(original).hexdigest() != body["etag"]:
            raise WorkspaceError("File was changed by another editor or agent; reload before saving", 409)
        _text(original)
        try:
            newfd, temporary = tempfile.mkstemp(prefix=".cc-edit-", dir=path.parent)
            with os.fdopen(newfd, "wb") as stream:
                os.fchmod(stream.fileno(), stat.S_IMODE(before.st_mode))
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            current = path.lstat()
            if (current.st_ino, current.st_dev, current.st_mtime_ns, current.st_size) != (before.st_ino, before.st_dev, before.st_mtime_ns, before.st_size):
                raise WorkspaceError("File changed while saving; original file was not overwritten", 409)
            os.replace(temporary, path)
        finally:
            if temporary:
                Path(temporary).unlink(missing_ok=True)
    return {"etag": hashlib.sha256(raw).hexdigest(), "size": len(raw)}


def command(args, limit=MAX_TEXT, timeout=5):
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"})
    output = bytearray()
    deadline = time.monotonic() + timeout
    truncated = False
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise WorkspaceError("Repository inspection timed out", 504)
                for key, _ in selector.select(min(remaining, .2)):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        output.extend(chunk)
                        if len(output) > limit:
                            truncated = True
                            child.kill()
                            return bytes(output[:limit]), True
            code = child.wait(timeout=max(.01, deadline - time.monotonic()))
            if code:
                raise WorkspaceError("Git inspection unavailable; select a readable repository", 400)
            return bytes(output), truncated
    except subprocess.TimeoutExpired as exc:
        raise WorkspaceError("Repository inspection timed out", 504) from exc
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        child.stdout.close()


def git_args(path):
    return ["git", "--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false",
            "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-C", str(path)]


def git_status(path):
    args = git_args(path)
    root, _ = command([*args, "rev-parse", "--show-toplevel"], limit=8192)
    try:
        branch, _ = command([*args, "symbolic-ref", "--short", "-q", "HEAD"], limit=8192)
    except WorkspaceError:
        branch, _ = command([*args, "rev-parse", "--short", "HEAD"], limit=8192)
    raw, truncated = command([*args, "status", "--porcelain=v1", "-z", "--untracked-files=normal"])
    if truncated:
        raise WorkspaceError("Repository has too many changes; use the native terminal", 413)
    parts, changes, index = raw.split(b"\0"), [], 0
    while index < len(parts):
        row = parts[index]
        index += 1
        if not row:
            continue
        code, name = row[:2].decode("ascii"), os.fsdecode(row[3:])
        original = None
        if "R" in code or "C" in code:
            if index < len(parts):
                original = os.fsdecode(parts[index])
                index += 1
        changes.append({"status": code, "path": name, "original": original})
    return {"root": os.fsdecode(root).strip(), "branch": branch.decode(errors="replace").strip(), "changes": changes}


def git_diff(path, filename, staged=False):
    relative = Path(filename)
    if not filename or relative.is_absolute() or ".." in relative.parts or "\x00" in filename:
        raise WorkspaceError("Invalid repository-relative file")
    args = [*git_args(path), "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3"]
    if staged:
        args.append("--cached")
    raw, truncated = command([*args, "--", filename])
    return {"text": raw.decode("utf-8", errors="replace"), "truncated": truncated}


def history(name, query):
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 160:
        raise WorkspaceError("Search must contain 1-160 characters")
    raw, truncated = command(["tmux", "capture-pane", "-p", "-J", "-t", name, "-S", "-10000"], limit=1024 * 1024)
    lines = raw.decode("utf-8", errors="replace").splitlines()
    matches = [{"line": i + 1, "text": line[:1000]} for i, line in enumerate(lines) if query.casefold() in line.casefold()]
    return {"matches": matches[-200:], "total": len(matches), "truncated": truncated or len(matches) > 200,
            "lines": len(lines), "scope": "tmux-history"}
