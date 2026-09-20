"""Configuration for Web CC Terminal.

All values can be overridden via environment variables so nothing is hard-coded
to one machine. Defaults stay inside the current user's home directory.
"""
import os
import secrets
import shutil
from pathlib import Path

# --- Auth -------------------------------------------------------------------
# Simple shared-token authentication. Set CC_WEB_TOKEN to pin it,
# otherwise a random token is generated and printed at startup.
# Set CC_WEB_AUTH=0 to disable auth entirely (ONLY safe on localhost).
TOKEN = os.environ.get("CC_WEB_TOKEN") or "dev-" + secrets.token_hex(8)
AUTH_ENABLED = os.environ.get("CC_WEB_AUTH", "1") != "0"

# --- Network ----------------------------------------------------------------
# Bind to localhost only; put an HTTPS reverse proxy or secure tunnel in front.
HOST = os.environ.get("CC_WEB_HOST", "127.0.0.1")
PORT = int(os.environ.get("CC_WEB_PORT", "8000"))

# --- Directory browsing whitelist ------------------------------------------
_DEFAULT_ROOTS = [str(Path.home())]
ROOTS = [
    str(Path(p).resolve())
    for p in os.environ.get("CC_WEB_ROOTS", ",".join(_DEFAULT_ROOTS)).split(",")
    if p.strip()
]

# --- Claude binary ----------------------------------------------------------
# Resolved from the server's PATH at import time; override with CC_WEB_CLAUDE.
CLAUDE_BIN = os.environ.get("CC_WEB_CLAUDE") or shutil.which("claude") or "claude"

# --- Default directory the file picker opens at -----------------------------
DEFAULT_DIR = os.environ.get("CC_WEB_DEFAULT_DIR", str(Path.home()))

# --- Agent binaries + terminal-type availability ----------------------------
CODEX_BIN = os.environ.get("CC_WEB_CODEX") or shutil.which("codex") or "codex"
_CODEX_HOME = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser()
_DEFAULT_CODEX_MODEL_CATALOG = _CODEX_HOME / "catalogs" / "models-current.json"
_CODEX_MODEL_CATALOG_OVERRIDE = os.environ.get("CC_WEB_CODEX_MODEL_CATALOG")
CODEX_MODEL_CATALOG = (
    _CODEX_MODEL_CATALOG_OVERRIDE.strip()
    if _CODEX_MODEL_CATALOG_OVERRIDE is not None
    else (
        str(_DEFAULT_CODEX_MODEL_CATALOG)
        if _DEFAULT_CODEX_MODEL_CATALOG.is_file()
        else ""
    )
)
_DEFAULT_CODEX_STATUS_LINE = [
    "model-with-reasoning",
    "run-state",
    "context-remaining",
]
_CODEX_STATUS_LINE_OVERRIDE = os.environ.get("CC_WEB_CODEX_STATUS_LINE")
CODEX_STATUS_LINE = (
    [item.strip() for item in _CODEX_STATUS_LINE_OVERRIDE.split(",") if item.strip()]
    if _CODEX_STATUS_LINE_OVERRIDE is not None
    else _DEFAULT_CODEX_STATUS_LINE
)
_OPENCODE_USER_BIN = Path.home() / ".opencode" / "bin" / "opencode"
OPENCODE_BIN = (
    os.environ.get("CC_WEB_OPENCODE")
    or shutil.which("opencode")
    or (str(_OPENCODE_USER_BIN) if _OPENCODE_USER_BIN.is_file() else "opencode")
)


def _bin_ok(b: str) -> bool:
    if not b:
        return False
    if os.path.sep in b:
        return os.path.isfile(b) and os.access(b, os.X_OK)
    return bool(shutil.which(b))


CLAUDE_OK = _bin_ok(CLAUDE_BIN)
CODEX_OK = _bin_ok(CODEX_BIN)
OPENCODE_OK = _bin_ok(OPENCODE_BIN)
