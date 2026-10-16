"""Opt-in native Codex regression: no credentials, network calls, or shared tmux.

Run with CC_WEB_CODEX_TESTS=1. All transcripts and unsent drafts are synthetic.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

from backend import tmux_mgr


@unittest.skipUnless(os.environ.get("CC_WEB_CODEX_TESTS") == "1", "opt-in native Codex test")
class CodexOfflineScrollTests(unittest.TestCase):
    def test_wrapped_codex_with_multiline_composer_at_different_heights(self):
        binary = shutil.which("codex")
        if not binary or not shutil.which("tmux"):
            self.skipTest("Codex and tmux must be installed")
        with tempfile.TemporaryDirectory(prefix="webcc-codex-scroll-") as directory:
            root = Path(directory)
            home = root / "home"
            home.mkdir()
            env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "CODEX_HOME": str(home), "TERM": "xterm-256color"}
            catalog = root / "models.json"
            bundled = subprocess.run([binary, "debug", "models", "--bundled"],
                                     env=env, capture_output=True, text=True, check=True, timeout=15)
            version = subprocess.run([binary, "--version"], env=env, capture_output=True,
                                     text=True, check=True, timeout=15).stdout.strip().split()[-1]
            catalog.write_text(bundled.stdout)
            models = json.loads(bundled.stdout)
            model = (models.get("models", []) if isinstance(models, dict) else models)[0]["slug"]
            config = (
                f'model = {json.dumps(model)}\nmodel_provider = "offline"\n'
                f'model_catalog_json = {json.dumps(str(catalog))}\ncheck_for_update_on_startup = false\n'
                '\n[tui]\nfullscreen_transcript = true\nanimations = false\n'
                '\n[analytics]\nenabled = false\n'
                '\n[model_providers.offline]\nname = "Offline scroll test"\n'
                'base_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n'
                f'\n[projects.{json.dumps(directory)}]\ntrust_level = "trusted"\n'
            )
            (home / "config.toml").write_text(config)
            socket = str(root / "tmux.sock")

            def tmux(args, **kwargs):
                return subprocess.run(["tmux", "-S", socket, "-f", "/dev/null", *args],
                                      capture_output=True, text=True, timeout=10, **kwargs)

            def run(*args):
                result = tmux(list(args))
                result.check_returncode()
                return result.stdout

            def visible(name):
                return [int(n) for n in re.findall(r"OFFLINE ROW (\d+)", run("capture-pane", "-p", "-t", name))]

            now = datetime.now(timezone.utc)
            timestamp = now.isoformat()
            date = now.strftime("%Y-%m-%dT%H-%M-%S")
            sessions = home / "sessions" / now.strftime("%Y/%m/%d")
            sessions.mkdir(parents=True)
            message = "\n".join(f"OFFLINE ROW {i:03d}" for i in range(300))
            try:
                run("new-session", "-d", "-s", "keepalive", "sleep 120")
                run("set-option", "-g", "remain-on-exit", "on")
                cases = [(height, False) for height in (14, 24, 30)] + [(height, True) for height in (14, 24, 30)]
                for height, inline in cases:
                    with self.subTest(height=height, inline=inline):
                        identifier = str(uuid.uuid4())
                        records = [
                            {"type": "session_meta", "payload": {"id": identifier, "timestamp": timestamp,
                                "cwd": directory, "originator": "codex_cli_rs", "cli_version": version, "source": "cli", "model_provider": "offline"}},
                            {"type": "event_msg", "payload": {"type": "user_message", "message": "Offline scroll fixture", "images": [], "local_images": []}},
                            {"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": message}]}},
                            {"type": "event_msg", "payload": {"type": "agent_message", "message": message}},
                        ]
                        rollout = sessions / f"rollout-{date}-{identifier}.jsonl"
                        rollout.write_text("".join(json.dumps({"timestamp": timestamp, **item}) + "\n" for item in records))
                        # Non-exec env wrapper reproduces pane_current_command=sh.
                        args = ["env", "-i", *(f"{k}={v}" for k, v in env.items()),
                                binary, "resume", identifier, "--no-daemon", "-C", directory]
                        if inline:
                            args.append("--no-alt-screen")
                        command = shlex.join(args)
                        name = f"test{height}_{inline}"
                        run("new-session", "-d", "-s", name, "-x", "100", "-y", str(height), command)
                        run("set-option", "-t", name, "status", "off")
                        deadline = time.monotonic() + 15
                        while not visible(name) and time.monotonic() < deadline:
                            time.sleep(.1)
                        self.assertTrue(visible(name), run("capture-pane", "-p", "-t", name))
                        draft = "\n".join(f"Unsent draft row {i}" for i in range(8))
                        run("send-keys", "-t", name, "-l", "--", "\x1b[200~" + draft + "\x1b[201~")
                        time.sleep(.4)
                        before = visible(name)
                        self.assertTrue(before)
                        if inline:
                            self.assertEqual(run("display-message", "-p", "-t", name, "#{alternate_on}").strip(), "0")
                            history = run("capture-pane", "-p", "-S", "-", "-t", name)
                            self.assertIn("OFFLINE ROW 000", history)
                            self.assertIn("OFFLINE ROW 299", history)
                            with patch.object(tmux_mgr, "_tmux", tmux):
                                self.assertTrue(tmux_mgr.scroll_session(name, -height, tmux_mgr.ScrollState()))
                            time.sleep(.2)
                            self.assertEqual(run("display-message", "-p", "-t", name, "#{pane_mode}").strip(), "copy-mode")
                            position = int(run("display-message", "-p", "-t", name, "#{scroll_position}").strip())
                            self.assertEqual(position, height)
                            reading = run("capture-pane", "-p", "-S", str(-position), "-E", str(-position + height - 1), "-t", name)
                            self.assertGreaterEqual(len(re.findall(r"OFFLINE ROW \d+", reading)), height - 2, reading)
                            self.assertNotIn("Unsent draft row", reading)
                            run("kill-session", "-t", name)
                            continue
                        pointer_row = 1 if height == 14 else 2
                        with patch.object(tmux_mgr, "_tmux", tmux):
                            self.assertTrue(tmux_mgr.scroll_session(name, -3, tmux_mgr.ScrollState(), pointer_row))
                            time.sleep(.3)
                            after = visible(name)
                            self.assertTrue(after)
                            self.assertEqual(before[0] - after[0], 3)
                            self.assertTrue(tmux_mgr.scroll_session(name, 3, tmux_mgr.ScrollState(), pointer_row))
                        time.sleep(.3)
                        self.assertEqual(visible(name), before)
                        self.assertEqual(run("display-message", "-p", "-t", name, "#{pane_mode}").strip(), "")
                        run("kill-session", "-t", name)
            finally:
                tmux(["kill-server"])


if __name__ == "__main__":
    unittest.main()
