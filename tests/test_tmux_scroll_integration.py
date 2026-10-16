import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from backend import tmux_mgr


@unittest.skipUnless(os.environ.get("CC_WEB_TMUX_TESTS") == "1", "opt-in isolated tmux test")
class TmuxScrollIntegrationTests(unittest.TestCase):
    def setUp(self):
        if not shutil.which("cc") or not shutil.which("tmux"):
            self.skipTest("cc and tmux are required")
        self.temp = tempfile.TemporaryDirectory(prefix="webcc-scroll-")
        self.addCleanup(self.temp.cleanup)
        self.socket = str(Path(self.temp.name) / "tmux.sock")
        binary = Path(self.temp.name) / "codex"
        fixture = Path(__file__).parent / "fixtures" / "native_history.c"
        subprocess.run(["cc", str(fixture), "-o", str(binary)], check=True)
        # A private socket and empty config prevent touching live tmux sessions.
        self.addCleanup(lambda: self.run_tmux(["kill-server"]))
        for name, extra in [("cc_full", ""), ("cc_inline", " inline")]:
            result = self.run_tmux([
                "new-session", "-d", "-s", name, "-x", "80", "-y", "24",
                "exec " + shlex.quote(str(binary)) + extra,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
        self.until(lambda: "native history 200" in self.capture("cc_full"))
        self.until(lambda: "inline history 299" in self.capture("cc_inline"))
        result = self.run_tmux([
            "new-session", "-d", "-s", "cc_wrapped", "-x", "80", "-y", "14",
            shlex.quote(str(binary)) + "; :",
        ])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.until(lambda: "native history 200" in self.capture("cc_wrapped"))

    def run_tmux(self, args, **kwargs):
        return subprocess.run(["tmux", "-S", self.socket, "-f", "/dev/null", *args],
                              capture_output=True, text=True, **kwargs)

    def capture(self, session):
        return self.run_tmux(["capture-pane", "-p", "-t", session]).stdout

    def state(self, session, expression):
        return self.run_tmux(["display-message", "-p", "-t", session, expression]).stdout.strip()

    def until(self, predicate):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.02)
        self.fail("tmux fixture did not reach expected state")

    def test_fullscreen_copy_mode_recovers_native_history(self):
        self.assertEqual(self.state("cc_full", "#{alternate_on}:#{history_size}:#{pane_current_command}"), "1:0:codex")
        self.run_tmux(["copy-mode", "-e", "-t", "cc_full"])
        self.assertEqual(self.state("cc_full", "#{pane_mode}"), "copy-mode")
        with patch.object(tmux_mgr, "_tmux", self.run_tmux):
            state = tmux_mgr.ScrollState()
            self.assertTrue(tmux_mgr.scroll_session("cc_full", -7, state))
            self.until(lambda: "native history 194" in self.capture("cc_full"))
            self.assertEqual(self.state("cc_full", "#{pane_in_mode}"), "0")
            self.assertTrue(tmux_mgr.scroll_session("cc_full", -7, state))
            self.until(lambda: "native history 188" in self.capture("cc_full"))
            self.assertTrue(tmux_mgr.scroll_session("cc_full", 7, state))
            self.until(lambda: "native history 194" in self.capture("cc_full"))

    def test_tiny_fullscreen_gestures_do_not_turn_into_pages(self):
        state = tmux_mgr.ScrollState()
        with patch.object(tmux_mgr, "_tmux", self.run_tmux):
            for _ in range(2):
                self.assertTrue(tmux_mgr.scroll_session("cc_full", -1, state))
            self.assertIn("native history 200", self.capture("cc_full"))
            self.assertTrue(tmux_mgr.scroll_session("cc_full", -1, state))
            self.until(lambda: "native history 197" in self.capture("cc_full"))
            self.assertTrue(tmux_mgr.scroll_session("cc_full", 3, state))
            self.until(lambda: "native history 200" in self.capture("cc_full"))

    def test_inline_codex_keeps_real_tmux_scrollback(self):
        self.assertEqual(self.state("cc_inline", "#{alternate_on}"), "0")
        self.assertGreater(int(self.state("cc_inline", "#{history_size}")), 200)
        with patch.object(tmux_mgr, "_tmux", self.run_tmux):
            self.assertTrue(tmux_mgr.scroll_session("cc_inline", -7))
        self.assertEqual(self.state("cc_inline", "#{pane_mode}"), "copy-mode")
        self.assertEqual(self.state("cc_inline", "#{scroll_position}"), "7")

    def test_shell_wrapper_and_small_pane_recover_native_history(self):
        self.assertNotEqual(self.state("cc_wrapped", "#{pane_current_command}"), "codex")
        tty = self.state("cc_wrapped", "#{pane_tty}")
        self.assertTrue(tmux_mgr._foreground_is_codex(tty))
        self.run_tmux(["copy-mode", "-e", "-t", "cc_wrapped"])
        with patch.object(tmux_mgr, "_tmux", self.run_tmux):
            self.assertTrue(tmux_mgr.scroll_session("cc_wrapped", -3, tmux_mgr.ScrollState()))
            self.until(lambda: "native history 197" in self.capture("cc_wrapped"))
            self.assertEqual(self.state("cc_wrapped", "#{pane_in_mode}"), "0")
            self.assertTrue(tmux_mgr.scroll_session("cc_wrapped", 3, tmux_mgr.ScrollState()))
            self.until(lambda: "native history 200" in self.capture("cc_wrapped"))


if __name__ == "__main__":
    unittest.main()
