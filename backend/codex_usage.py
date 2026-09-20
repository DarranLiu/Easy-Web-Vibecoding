"""Read Codex account rate limits through the official App Server protocol."""

import fcntl
import json
import os
import selectors
import subprocess
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any


class CodexUsageError(RuntimeError):
    pass


_CACHE_LOCK = threading.Lock()
_CACHE_TTL_SECONDS = 10 * 60.0
_FAILURE_RETRY_SECONDS = 10 * 60.0
_RUNTIME_DIR = Path(os.environ.get("XDG_RUNTIME_DIR") or "/tmp")
_CACHE_PATH = _RUNTIME_DIR / f"cc-web-codex-usage-{os.getuid()}.json"
_LOCK_PATH = _RUNTIME_DIR / f"cc-web-codex-usage-{os.getuid()}.lock"


def _send(proc: subprocess.Popen, message: dict[str, Any]) -> None:
    if proc.stdin is None:
        raise CodexUsageError("Codex App Server input is unavailable")
    payload = (json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8")
    proc.stdin.write(payload)
    proc.stdin.flush()


def _read_response(
    proc: subprocess.Popen,
    request_id: int,
    deadline: float,
    buffer: bytearray,
) -> dict[str, Any]:
    if proc.stdout is None:
        raise CodexUsageError("Codex App Server output is unavailable")
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ)
    try:
        while time.monotonic() < deadline:
            newline = buffer.find(b"\n")
            if newline >= 0:
                raw = bytes(buffer[:newline])
                del buffer[:newline + 1]
                try:
                    message = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if message.get("id") != request_id:
                    continue
                if message.get("error"):
                    raise CodexUsageError("Codex App Server rejected the request")
                result = message.get("result")
                if isinstance(result, dict):
                    return result
                raise CodexUsageError("Codex App Server returned an invalid response")
            ready = selector.select(max(0.0, deadline - time.monotonic()))
            if not ready:
                break
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                break
            buffer.extend(chunk)
    finally:
        selector.close()
    raise CodexUsageError("Codex App Server timed out")


def _query_rate_limits(codex_bin: str, timeout: float = 8.0) -> dict[str, Any]:
    try:
        proc = subprocess.Popen(
            [codex_bin, "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
    except (OSError, ValueError) as exc:
        raise CodexUsageError("Unable to start Codex App Server") from exc

    try:
        deadline = time.monotonic() + timeout
        buffer = bytearray()
        _send(proc, {
            "method": "initialize",
            "id": 0,
            "params": {
                "clientInfo": {
                    "name": "web_cc_terminal",
                    "title": "CC Terminal",
                    "version": "0.1.0",
                },
            },
        })
        _read_response(proc, 0, deadline, buffer)
        _send(proc, {"method": "initialized", "params": {}})
        _send(proc, {"method": "account/rateLimits/read", "id": 1})
        return _read_response(proc, 1, deadline, buffer)
    finally:
        try:
            if proc.stdin:
                proc.stdin.close()
        except OSError:
            pass
        try:
            proc.terminate()
            proc.wait(timeout=1.0)
        except (OSError, subprocess.TimeoutExpired):
            try:
                proc.kill()
                proc.wait(timeout=1.0)
            except (OSError, subprocess.TimeoutExpired):
                pass


def _percent(value: Any) -> float | None:
    try:
        return round(min(100.0, max(0.0, float(value))), 1)
    except (TypeError, ValueError):
        return None


def _window(value: Any, kind: str) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    used = _percent(value.get("usedPercent"))
    try:
        duration = int(value.get("windowDurationMins"))
        resets_at = int(value.get("resetsAt"))
    except (TypeError, ValueError):
        return None
    if used is None or duration <= 0 or resets_at <= 0:
        return None
    return {
        "kind": kind,
        "usedPercent": used,
        "remainingPercent": round(100.0 - used, 1),
        "windowDurationMins": duration,
        "resetsAt": resets_at,
    }


def _normalize_rate_limits(result: dict[str, Any]) -> dict[str, Any]:
    default = result.get("rateLimits") if isinstance(result.get("rateLimits"), dict) else None
    if not default:
        raise CodexUsageError("Codex returned no default rate limit")
    window = _window(default.get("primary"), "primary") or _window(default.get("secondary"), "secondary")
    if window is None:
        raise CodexUsageError("Codex returned no usable rate-limit windows")
    return {
        "window": window,
        "fetchedAt": int(time.time()),
        "stale": False,
    }


def _open_flags(base: int) -> int:
    return base | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)


@contextmanager
def _shared_lock():
    try:
        fd = os.open(_LOCK_PATH, _open_flags(os.O_CREAT | os.O_RDWR), 0o600)
        os.fchmod(fd, 0o600)
    except OSError as exc:
        raise CodexUsageError("Unable to open the shared Codex usage lock") from exc
    with os.fdopen(fd, "r+b") as lock_file:
        try:
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            except OSError as exc:
                raise CodexUsageError("Unable to acquire the shared Codex usage lock") from exc
            yield
        finally:
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass


def _read_record() -> dict[str, Any] | None:
    try:
        value = json.loads(_CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _write_record(record: dict[str, Any]) -> None:
    temp = _CACHE_PATH.with_name(f"{_CACHE_PATH.name}.{os.getpid()}.tmp")
    try:
        fd = os.open(temp, _open_flags(os.O_CREAT | os.O_WRONLY | os.O_TRUNC), 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=True, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, _CACHE_PATH)
    except OSError as exc:
        raise CodexUsageError("Unable to update the shared Codex usage cache") from exc
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def _record_data(
    record: dict[str, Any] | None,
    stale: bool,
    next_refresh_at: float | None = None,
) -> dict[str, Any] | None:
    data = record.get("data") if isinstance(record, dict) else None
    if not isinstance(data, dict) or not isinstance(data.get("window"), dict):
        return None
    result = dict(data)
    result["stale"] = stale
    if next_refresh_at is not None:
        result["nextRefreshAt"] = int(next_refresh_at)
    return result


def get_usage(codex_bin: str) -> dict[str, Any]:
    with _CACHE_LOCK, _shared_lock():
        now = time.time()
        record = _read_record()
        try:
            queried_at = float(record.get("queriedAt", 0)) if record else 0.0
        except (TypeError, ValueError):
            queried_at = 0.0
        failed = bool(record and record.get("failed"))
        wait_seconds = _FAILURE_RETRY_SECONDS if failed else _CACHE_TTL_SECONDS
        age = now - queried_at
        if queried_at > 0 and 0 <= age < wait_seconds:
            cached = _record_data(record, stale=failed, next_refresh_at=queried_at + wait_seconds)
            if cached is not None:
                return cached
            raise CodexUsageError("Codex usage refresh is in failure backoff")

        previous = _record_data(record, stale=True)
        try:
            data = _normalize_rate_limits(_query_rate_limits(codex_bin))
        except CodexUsageError:
            failed_at = time.time()
            _write_record({"queriedAt": failed_at, "failed": True, "data": previous})
            if previous is not None:
                previous["nextRefreshAt"] = int(failed_at + _FAILURE_RETRY_SECONDS)
                return previous
            raise
        completed_at = time.time()
        _write_record({"queriedAt": completed_at, "failed": False, "data": data})
        result = dict(data)
        result["nextRefreshAt"] = int(completed_at + _CACHE_TTL_SECONDS)
        return result
