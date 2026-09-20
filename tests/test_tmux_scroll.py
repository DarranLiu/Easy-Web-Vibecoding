import unittest
from unittest.mock import patch

from backend import tmux_mgr


class FakeRun:
    returncode = 0


class TmuxScrollTests(unittest.TestCase):
    def test_scroll_up_enters_copy_mode_and_scrolls_history(self):
        calls = []

        def fake_tmux(args, **kwargs):
            calls.append(args)
            return FakeRun()

        with patch.object(tmux_mgr, "_tmux", fake_tmux):
            self.assertTrue(tmux_mgr.scroll_session("cc_abc123", -7))

        self.assertEqual(calls[0], ["copy-mode", "-e", "-t", "cc_abc123"])
        self.assertEqual(calls[1], ["send-keys", "-t", "cc_abc123", "-X", "-N", "7", "scroll-up"])

    def test_scroll_down_uses_tmux_copy_mode_scroll_down(self):
        calls = []

        def fake_tmux(args, **kwargs):
            calls.append(args)
            return FakeRun()

        with patch.object(tmux_mgr, "_tmux", fake_tmux):
            self.assertTrue(tmux_mgr.scroll_session("cc_abc123", 3))

        self.assertEqual(calls[1], ["send-keys", "-t", "cc_abc123", "-X", "-N", "3", "scroll-down"])


if __name__ == "__main__":
    unittest.main()
