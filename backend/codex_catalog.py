"""Offline, executable-bound model catalogs for guarded Codex launches."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

if __package__:
    from backend import agent_sessions as sessions
else:
    import agent_sessions as sessions

MAX_BYTES = 8 * 1024 * 1024
EXPORT_TIMEOUT = 8
RETRY_SECONDS = 600
LOCK_SECONDS = 3


def _identity(path):
    info = os.stat(path)
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]


def _root(env):
    return Path(env.get("CC_WEB_AGENT_UPDATE_DIR") or
                Path(env.get("HOME") or Path.home()) / ".cache/cc-web-terminal/updates") / "model-catalogs"


def _legacy(env):
    home = Path(env.get("HOME") or Path.home())
    return {str((base / "catalogs/models-current.json").absolute())
            for base in (home / ".codex", Path(env.get("CODEX_HOME") or home / ".codex"))}


def _managed(value, env):
    path = Path(value).absolute()
    return str(path) in _legacy(env) or (
        path.parent == _root(env).absolute() and bool(re.fullmatch(r"[a-f0-9]{64}\.json", path.name)))


def mode(env):
    value = env.get("CC_WEB_CODEX_MODEL_CATALOG", "")
    explicit = env.get("CC_WEB_CODEX_CATALOG_MODE")
    if explicit in {"auto", "custom", "native"}:
        return explicit
    # Existing tmux shells predate the policy marker and inherit the old path.
    return "auto" if value == "auto" or value and _managed(value, env) else "custom" if value else "native"


def _arguments(args, env):
    result, custom, index = [], False, 0
    while index < len(args):
        arg = args[index]
        if arg == "--":
            result.extend(args[index:])
            break
        count, assignment = 1, None
        if arg in {"-c", "--config"} and index + 1 < len(args):
            count, assignment = 2, args[index + 1]
        elif arg.startswith("--config="):
            assignment = arg[len("--config="):]
        elif arg.startswith("-c") and not arg.startswith("--"):
            assignment = arg[2:]
        managed = False
        if assignment is not None:
            key, separator, value = assignment.partition("=")
            if separator and key.strip() == "model_catalog_json":
                try:
                    parsed = json.loads(value)
                    managed = isinstance(parsed, str) and _managed(parsed, env)
                except ValueError:
                    pass  # Unknown TOML syntax belongs to the user, not this migration.
                custom |= not managed
        if not managed:
            result.extend(args[index:index + count])
        index += count
    return result, custom


def _read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("Model catalog exceeds size limit")
    value = json.loads(data)
    models = value.get("models") if isinstance(value, dict) else None
    if not isinstance(models, list) or not models:
        raise ValueError("Model catalog is empty")
    slugs = [item.get("slug") if isinstance(item, dict) else None for item in models]
    if not all(isinstance(slug, str) and slug for slug in slugs) or len(set(slugs)) != len(slugs):
        raise ValueError("Invalid model catalog")
    return data


def _export(binary, output):
    # Never read login state, project config, hooks or network model lists.
    with tempfile.TemporaryDirectory(prefix="webcc-model-export-") as temporary:
        env = {"PATH": os.defpath, "HOME": temporary, "CODEX_HOME": temporary,
               "XDG_CONFIG_HOME": temporary, "XDG_DATA_HOME": temporary,
               "XDG_STATE_HOME": temporary, "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1"}
        with open(output, "wb") as stream:
            result = subprocess.run([binary, "--no-daemon", "debug", "models", "--bundled"],
                                    env=env, cwd=temporary, stdin=subprocess.DEVNULL,
                                    stdout=stream, stderr=subprocess.DEVNULL, timeout=EXPORT_TIMEOUT)
        if result.returncode:
            raise ValueError("Bundled model export unavailable")


def _cached(binary, identity, env):
    root = sessions.runtime_dir(_root(env))
    key = hashlib.sha256(json.dumps(identity).encode()).hexdigest()
    target = root / (key + ".json")
    deadline = time.monotonic() + LOCK_SECONDS
    while True:
        try:
            with sessions.lock(key, "catalog", root, blocking=False):
                state = sessions.load(key, root, ".state.json")
                try:
                    data = _read(target)
                    if state.get("identity") == identity and state.get("sha256") == hashlib.sha256(data).hexdigest():
                        return str(target)
                except (OSError, ValueError):
                    pass
                retry_after = state.get("retry_after", 0)
                if isinstance(retry_after, (int, float)) and retry_after > time.time():
                    return ""
                fd, temporary = tempfile.mkstemp(prefix=".models-", dir=root)
                os.close(fd)
                try:
                    _export(binary, temporary)
                    data = _read(temporary)
                    if _identity(binary) != identity:
                        raise ValueError("Executable changed during model export")
                    os.replace(temporary, target)
                    sessions.save(key, {"identity": identity, "sha256": hashlib.sha256(data).hexdigest()}, root, ".state.json")
                    return str(target)
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    sessions.save(key, {"retry_after": time.time() + RETRY_SECONDS}, root, ".state.json")
                    print("[Web CC] Model catalog export unavailable; using native Codex discovery, not an old catalog.", file=sys.stderr)
                    return ""
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
        except BlockingIOError:
            if time.monotonic() >= deadline:
                return ""
            time.sleep(.025)


def prepare(binary, args, env):
    """Return effective executable/args/env without touching a running session."""
    updated = dict(env)
    policy = mode(env)
    if policy == "custom":
        return binary, list(args), updated
    arguments, custom = _arguments(args, env)
    updated["CC_WEB_CODEX_CATALOG_MODE"] = policy
    updated["CC_WEB_CODEX_MODEL_CATALOG"] = ""
    if policy == "native" or custom:
        return binary, arguments, updated
    # Resolve the shared symlink once so an update cannot pair a new CLI with
    # a catalog exported from the previous target. Saved-version plans stay pinned.
    resolved = str(Path(binary).resolve(strict=True))
    identity = _identity(resolved)
    try:
        updated["CC_WEB_CODEX_MODEL_CATALOG"] = _cached(resolved, identity, env)
    except (OSError, ValueError, RuntimeError):
        print("[Web CC] Model catalog cache unavailable; using native Codex discovery.", file=sys.stderr)
    if _identity(resolved) != identity:
        raise RuntimeError("Codex changed during launch preparation; retry without altering the saved session.")
    return resolved, arguments, updated
