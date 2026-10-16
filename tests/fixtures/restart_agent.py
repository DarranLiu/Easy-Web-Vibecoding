"""Offline native-agent stand-in: real PTY/processes, synthetic sessions only."""
import ctypes
import json
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import sys
import termios
import threading
import time
import tty
import uuid

agent = Path(sys.argv[0]).name
ctypes.CDLL(None).prctl(15, agent.encode(), 0, 0, 0)
args = sys.argv[1:]
FAKE_VERSION = "1.2.3"
if "--version" in args:
    print(("codex-cli " if agent == "codex" else "") + FAKE_VERSION)
    sys.exit(0)
if "--help" in args:
    print("--no-daemon --no-alt-screen --resume --settings --permission-mode --sandbox --ask-for-approval --model -m -s -a -c -C --session --port --hostname --config --profile -p --enable --disable")
    sys.exit(0)
identifier = str(uuid.uuid4())
if agent == "opencode":
    identifier = "ses_" + uuid.uuid4().hex
flag = {"codex": "resume", "claude": "--resume", "opencode": "--session"}[agent]
if flag in args:
    identifier = args[args.index(flag) + 1]
home = (Path(os.environ["XDG_DATA_HOME"]) / "opencode" if agent == "opencode" else
        Path(os.environ["CODEX_HOME" if agent == "codex" else "CLAUDE_CONFIG_DIR"]))
directory = home / ("sessions/2026/01/01" if agent == "codex" else "projects/offline")
directory.mkdir(parents=True, exist_ok=True)
path = directory / (("rollout-offline-" if agent == "codex" else "") + identifier + ".jsonl")
if not path.exists():
    entry = ({"type": "session_meta", "payload": {"id": identifier, "cwd": os.getcwd(), "source": "cli", "model_provider": "offline"}}
             if agent == "codex" else {"sessionId": identifier, "cwd": os.getcwd(), "type": "user", "message": "Synthetic fixture"})
    path.write_text(json.dumps(entry) + "\n")
stream = path.open("a")
if agent == "opencode":
    with sqlite3.connect(home / "opencode.db") as db:
        db.execute("CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT)")
        db.execute("INSERT OR REPLACE INTO session VALUES (?, ?, NULL)", (identifier, os.getcwd()))
    observation = os.environ.get("CC_WEB_OPENCODE_OBSERVATION")
    if observation:
        def heartbeat():
            order = 0
            while True:
                order += 1
                Path(observation).write_text(json.dumps({"run": os.environ["CC_WEB_AGENT_RUN"], "pid": os.getpid(), "order": order,
                    "session_id": identifier, "cwd": os.getcwd(), "at": time.time()}))
                time.sleep(1)
        threading.Thread(target=heartbeat, daemon=True).start()
extra = None
if "--fake-multiple" in args:
    other = str(uuid.uuid4())
    other_path = directory / ("rollout-offline-" + other + ".jsonl")
    other_path.write_text(json.dumps({"type": "session_meta", "payload": {"id": other, "source": "cli"}}) + "\n")
    extra = other_path.open("a")
settings = {}
def emit_start(source="startup"):
    for group in settings.get("hooks", {}).get("SessionStart", []):
        for hook in group["hooks"]:
            subprocess.run(shlex.split(hook["command"]), input=json.dumps({
                "session_id": identifier, "transcript_path": str(path), "cwd": os.getcwd(),
                "hook_event_name": "SessionStart", "source": source,
            }), text=True, check=True)

if agent == "claude" and "--settings" in args:
    settings = json.loads(Path(args[args.index("--settings") + 1]).read_text())
    emit_start("resume" if flag in args else "startup")
attributes = termios.tcgetattr(0)
tty.setraw(0)
try:
    os.write(1, ("OFFLINE_READY " + agent + " " + identifier + "\r\n").encode())
    pending = b""
    while True:
        data = os.read(0, 4096)
        if not data or b"\x03" in data:
            if agent == "codex" and os.environ.get("WEBCC_FIXTURE_EXIT_ACTION") == "switch":
                stream.close()
                identifier = str(uuid.uuid4())
                path = directory / ("rollout-offline-" + identifier + ".jsonl")
                path.write_text(json.dumps({"type": "session_meta", "payload": {
                    "id": identifier, "cwd": os.getcwd(), "source": "cli"}}) + "\n")
                stream = path.open("a")
                continue
            if agent == "codex" and os.environ.get("WEBCC_FIXTURE_EXIT_DELAY"):
                stream.close()
                time.sleep(float(os.environ["WEBCC_FIXTURE_EXIT_DELAY"]))
            break
        pending += data
        if agent == "claude" and b"\n" in pending and pending.startswith(b"FAKE_SWITCH "):
            identifier = str(uuid.UUID(pending.split(b"\n")[0].split()[1].decode()))
            path = directory / (identifier + ".jsonl")
            path.write_text(json.dumps({"sessionId": identifier, "cwd": os.getcwd(), "type": "user", "message": "Synthetic switched conversation"}) + "\n")
            emit_start("clear")
            pending = b""
finally:
    termios.tcsetattr(0, termios.TCSANOW, attributes)
    stream.close()
    if extra:
        extra.close()
