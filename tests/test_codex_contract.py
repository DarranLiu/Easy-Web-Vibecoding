import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from backend import main, terminal_launch


class CodexContractTests(unittest.TestCase):
    def test_codex_launch_uses_current_local_model_catalog(self):
        catalog = "/tmp/codex catalogs/models-current.json"
        expected = [
            "--no-daemon",
            "--no-alt-screen",
            "-c",
            f"model_catalog_json={json.dumps(catalog)}",
            "-c",
            'tui.status_line=["weekly-limit","context-remaining"]',
        ]

        with patch.object(main.config, "CODEX_MODEL_CATALOG", catalog), patch.object(
            main.config, "CODEX_STATUS_LINE", ["weekly-limit", "context-remaining"]
        ), patch.object(main.config, "CODEX_SCROLLBACK", True), patch.object(main.config, "CODEX_NO_DAEMON", True):
            with tempfile.TemporaryDirectory() as directory, patch.object(
                main.config, "TERMINAL_LAUNCHER_DIR", Path(directory) / "bin"
            ):
                environment = terminal_launch.session_environment()
            self.assertEqual(terminal_launch.guarded_arguments("codex", [], environment), expected)
            self.assertTrue(main._launch_cmd("codex", "new").endswith("; _cc_web_codex"))

    def test_codex_launch_falls_back_when_catalog_is_unavailable(self):
        with patch.object(main.config, "CODEX_MODEL_CATALOG", ""), patch.object(
            main.config, "CODEX_STATUS_LINE", []
        ), patch.object(main.config, "CODEX_SCROLLBACK", True), patch.object(main.config, "CODEX_NO_DAEMON", True):
            self.assertEqual(terminal_launch.guarded_arguments("codex", [], {
                "CC_WEB_CODEX_MODEL_CATALOG": "", "CC_WEB_CODEX_STATUS_ITEMS": "[]",
            }), ["--no-daemon", "--no-alt-screen"])

    def test_shared_daemon_cannot_be_opted_in_from_web(self):
        with patch.dict(os.environ, {"CC_WEB_CODEX_NO_DAEMON": "0"}):
            self.assertTrue(main.config.CODEX_NO_DAEMON)
            self.assertIn("--no-daemon", terminal_launch.guarded_arguments("codex", ["resume"], os.environ))

    def test_web_defaults_do_not_weaken_permissions(self):
        launch = main._launch_cmd("codex", "new")
        for flag in ("--sandbox", "--ask-for-approval", "--yolo", "danger-full-access"):
            self.assertNotIn(flag, launch)

    def test_resume_after_interruption_keeps_web_defaults_and_user_arguments(self):
        with tempfile.TemporaryDirectory(prefix="webcc-resume-") as directory:
            home = Path(directory) / "home"
            home.mkdir()
            (home / ".hushlogin").touch()
            binary = Path(directory) / "codex tool"
            binary.write_text(f'#!{sys.executable}\nimport json, sys\nprint(json.dumps(sys.argv[1:]))\nsys.exit(130)\n')
            binary.chmod(0o700)
            catalog = str(Path(directory) / 'model catalogs' / 'current "quoted".json')
            with patch.object(main.config, "CODEX_BIN", str(binary)), patch.object(
                main.config, "CODEX_MODEL_CATALOG", catalog
            ), patch.object(main.config, "CODEX_STATUS_LINE", ["context-remaining"]), patch.object(
                main.config, "CODEX_SCROLLBACK", True
            ), patch.object(main.config, "TERMINAL_LAUNCHER_DIR", Path(directory) / "launchers"), patch.dict(
                os.environ, {"HOME": str(home), "BASH_ENV": "", "ENV": ""}
            ):
                launch = main._launch_cmd("codex", "new")
                environment = {**os.environ, **terminal_launch.session_environment()}
            base = ["--no-daemon", "--no-alt-screen", "-c", f"model_catalog_json={json.dumps(catalog)}",
                    "-c", 'tui.status_line=["context-remaining"]']
            extra = ["resume", "demo-session", "--model", "gpt-6.1-sol", "--sandbox", "workspace-write",
                     "--ask-for-approval", "on-request", "keep my quoted draft; not a shell command"]
            full_access = ["resume", "--sandbox", "danger-full-access", "--ask-for-approval", "never"]
            script = (launch + "\ncodex " + shlex.join(extra) + "\n codex "
                      + shlex.join(full_access) + "  \ncodex --version\ntrue\n")
            for shell in ("bash", "sh"):
                with self.subTest(shell=shell):
                    result = subprocess.run([shell, "-ic", script], env=environment,
                                            capture_output=True, text=True, timeout=8)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    calls = [json.loads(line) for line in result.stdout.splitlines()]
                    self.assertEqual(calls, [base, base + extra, base + full_access, base + ["--version"]])

    def test_fullscreen_codex_remains_an_explicit_opt_out(self):
        self.assertNotIn("--no-alt-screen", terminal_launch.guarded_arguments("codex", [], {
            "CC_WEB_CODEX_SCROLLBACK": "0",
        }))

    def test_running_legacy_sessions_are_not_reported_as_scrollback(self):
        tab = {"id": "demo", "type": "codex"}
        with patch.object(main.store, "list_tabs", return_value=[tab]):
            self.assertFalse(main._serialize({"demo": {"attached": 1}})[0]["codexScrollback"])
            self.assertTrue(main._serialize({"demo": {"attached": 1, "codexScrollback": True}})[0]["codexScrollback"])

    def test_web_codex_status_leaves_quota_windows_to_multiline_shelf(self):
        self.assertEqual(
            main.config.CODEX_STATUS_LINE,
            ["model-with-reasoning", "run-state", "context-remaining"],
        )


if __name__ == "__main__":
    unittest.main()
