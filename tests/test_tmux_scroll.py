import unittest
from unittest.mock import patch

from backend import tmux_mgr


class FakeRun:
    returncode = 0
    stdout = "0\t\tbash\t24\n"


class TmuxScrollTests(unittest.TestCase):
    def test_scroll_up_enters_copy_mode_and_scrolls_history(self):
        calls = []

        def fake_tmux(args, **kwargs):
            calls.append(args)
            return FakeRun()

        with patch.object(tmux_mgr, "_tmux", fake_tmux):
            self.assertTrue(tmux_mgr.scroll_session("cc_abc123", -7))

        self.assertEqual(calls[1], ["copy-mode", "-e", "-t", "cc_abc123"])
        self.assertEqual(calls[2], ["send-keys", "-t", "cc_abc123", "-X", "-N", "7", "scroll-up"])

    def test_scroll_down_uses_tmux_copy_mode_scroll_down(self):
        calls = []

        def fake_tmux(args, **kwargs):
            calls.append(args)
            return FakeRun()

        with patch.object(tmux_mgr, "_tmux", fake_tmux):
            self.assertTrue(tmux_mgr.scroll_session("cc_abc123", 3))

        self.assertEqual(calls[2], ["send-keys", "-t", "cc_abc123", "-X", "-N", "3", "scroll-down"])

    def run_scroll(self, state, lines):
        calls = []

        def fake_tmux(args, **kwargs):
            calls.append(args)
            result = FakeRun()
            if args[0] == "display-message":
                result.stdout = state
            return result

        with patch.object(tmux_mgr, "_tmux", fake_tmux):
            result = tmux_mgr.scroll_session("cc_demo", lines)
        return result, calls

    def test_fullscreen_codex_uses_its_own_history(self):
        for lines, key in [(-7, "PPage"), (7, "NPage")]:
            result, calls = self.run_scroll("1\t\tcodex\t24\n", lines)
            self.assertTrue(result)
            self.assertEqual(calls[1:], [["send-keys", "-t", "cc_demo", "-N", "1", key]])

    def test_fullscreen_codex_escapes_existing_copy_mode(self):
        result, calls = self.run_scroll("1\tcopy-mode\tcodex\t24\n", -7)
        self.assertTrue(result)
        self.assertEqual(calls[1], ["send-keys", "-t", "cc_demo", "-X", "cancel"])
        self.assertEqual(calls[2][-1], "PPage")
        self.assertFalse(any(call[0] == "copy-mode" for call in calls))

    def test_inline_codex_still_uses_tmux_history(self):
        result, calls = self.run_scroll("0\t\tcodex\t24\n", -7)
        self.assertTrue(result)
        self.assertEqual(calls[1][0], "copy-mode")
        self.assertEqual(calls[-1][-1], "scroll-up")

    def test_unknown_state_does_not_send_navigation_keys(self):
        for state in ["", "1\tchoose-tree\tcodex\t24", "1\t\tcodex\tinvalid"]:
            result, calls = self.run_scroll(state, -7)
            self.assertFalse(result)
            self.assertEqual(len(calls), 1)

    def test_large_gesture_is_bounded(self):
        result, calls = self.run_scroll("1\t\tcodex\t24\n", -9999)
        self.assertTrue(result)
        self.assertEqual(calls[-1], ["send-keys", "-t", "cc_demo", "-N", "5", "PPage"])

    def test_zero_and_invalid_gestures_do_nothing(self):
        for lines in [0, "invalid", None]:
            with patch.object(tmux_mgr, "_tmux") as run:
                self.assertFalse(tmux_mgr.scroll_session("cc_demo", lines))
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
