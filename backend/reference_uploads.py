"""Private, bounded uploads used as file references in terminal prompts."""
import asyncio
from datetime import datetime
import os
from pathlib import Path
import secrets
import stat
from urllib.parse import unquote

MAX_BYTES = 100 * 1024 * 1024


class UploadError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _name(value):
    raw = unquote(value, encoding="utf-8", errors="replace").replace("\\", "/").split("/")[-1]
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in raw).strip("._")
    safe = safe.encode("utf-8")[:160].decode("utf-8", "ignore").strip("._")
    return safe or "attachment"


def _write(fd, data):
    pending = memoryview(data)
    while pending:
        try:
            count = os.write(fd, pending)
        except InterruptedError:
            continue
        if count <= 0:
            raise OSError("Upload write stopped")
        pending = pending[count:]


async def _write_chunk(fd, chunk):
    task = asyncio.create_task(asyncio.to_thread(_write, fd, chunk))
    try:
        await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


async def store(request, directory, safe_resolve):
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/octet-stream":
        raise UploadError("上传格式无效", 415)
    length = request.headers.get("content-length")
    if length is not None:
        try:
            size = int(length)
        except ValueError:
            raise UploadError("文件大小无效")
        if size < 0:
            raise UploadError("文件大小无效")
        if size > MAX_BYTES:
            raise UploadError("单个文件不能超过 100 MiB", 413)
    root = Path(directory).absolute()
    safe_resolve(str(root))
    if root.is_symlink():
        raise UploadError("缓存目录不能是符号链接", 403)
    try:
        root.mkdir(mode=0o700, exist_ok=True)
        directory_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as exc:
        raise UploadError("参考文件缓存目录不可用", 403) from exc
    temporary = ".upload-" + secrets.token_hex(16)
    file_fd = None
    try:
        info = os.fstat(directory_fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise UploadError("参考文件缓存目录须由当前用户独占", 403)
        resolved = Path(os.readlink('/proc/self/fd/' + str(directory_fd))).resolve()
        safe_resolve(str(resolved))
        if resolved != root.resolve():
            raise UploadError("参考文件缓存目录已变化", 409)
        file_fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
        count = 0
        async for chunk in request.stream():
            count += len(chunk)
            if count > MAX_BYTES:
                raise UploadError("单个文件不能超过 100 MiB", 413)
            if chunk:
                await _write_chunk(file_fd, chunk)
        if length is not None and count != size:
            raise UploadError("文件传输不完整，请重新上传")
        os.close(file_fd)
        file_fd = None
        name = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(8) + "-" + _name(request.headers.get("x-file-name", ""))
        os.link(temporary, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd, follow_symlinks=False)
        os.unlink(temporary, dir_fd=directory_fd)
        return {"ok": True, "name": name, "path": str(resolved / name), "size": count}
    except OSError as exc:
        raise UploadError("参考文件保存失败，请检查磁盘空间和权限", 500) from exc
    finally:
        if file_fd is not None:
            os.close(file_fd)
        try:
            os.unlink(temporary, dir_fd=directory_fd)
        except OSError:
            pass
        os.close(directory_fd)
