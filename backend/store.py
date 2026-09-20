"""Persistent tab store.

A "tab" is a chat-like entry for one CC terminal. It outlives the tmux session:
killing the session leaves the tab behind (shown grey, restartable) until the
user deletes it explicitly. The tmux session itself is the live process; this
store only remembers the metadata needed to list and restart tabs.
"""
import json
import os
import threading
from pathlib import Path

from backend.private_files import write_private_json

STORE = Path(os.environ.get("CC_WEB_STORE", str(Path.home() / ".cc-web-tabs.json")))
_lock = threading.RLock()


def _load():
    try:
        return json.loads(STORE.read_text())
    except Exception:
        return []


def _save(tabs):
    write_private_json(STORE, tabs, indent=2)


def list_tabs():
    with _lock:
        return _load()


def get_tab(tid):
    with _lock:
        for t in _load():
            if t["id"] == tid:
                return t
        return None


def add_tab(tab):
    with _lock:
        tabs = _load()
        if any(t["id"] == tab["id"] for t in tabs):
            return tab
        tabs.append(tab)
        _save(tabs)
        return tab


def update_tab(tid, **fields):
    with _lock:
        tabs = _load()
        for t in tabs:
            if t["id"] == tid:
                t.update(fields)
        _save(tabs)


def remove_tab(tid):
    with _lock:
        _save([t for t in _load() if t["id"] != tid])


# --- Group (per-directory) display aliases ----------------------------------
# A display-only label for a project/cwd group. Does NOT touch the filesystem.
GROUPS = Path(os.environ.get("CC_WEB_GROUPS", str(Path.home() / ".cc-web-groups.json")))


def get_groups() -> dict:
    try:
        return json.loads(GROUPS.read_text())
    except Exception:
        return {}


def set_group_label(cwd: str, label: str):
    with _lock:
        g = get_groups()
        if label:
            g[cwd] = label
        else:
            g.pop(cwd, None)
        write_private_json(GROUPS, g, indent=2)


# --- Manual (user-created) groups -------------------------------------------
# A list of named groups; terminals can be assigned to one via tab["group"].
# Persisted so empty groups still show.
MANUAL = Path(os.environ.get("CC_WEB_MANUAL", str(Path.home() / ".cc-web-manual-groups.json")))


def get_manual_groups() -> list:
    try:
        return json.loads(MANUAL.read_text())
    except Exception:
        return []


def _save_manual(lst):
    write_private_json(MANUAL, lst, indent=2)


def add_manual_group(name):
    with _lock:
        g = get_manual_groups()
        if name and name not in g:
            g.append(name)
            _save_manual(g)


def rename_manual_group(old, new):
    with _lock:
        if not new:
            return
        g = get_manual_groups()
        out = []
        for x in g:
            x2 = new if x == old else x
            if x2 not in out:
                out.append(x2)
        _save_manual(out)
        tabs = _load()
        for t in tabs:
            if t.get("group") == old:
                t["group"] = new
        _save(tabs)


def remove_manual_group(name):
    with _lock:
        _save_manual([x for x in get_manual_groups() if x != name])
        tabs = _load()
        for t in tabs:
            if t.get("group") == name:
                t["group"] = ""
        _save(tabs)
