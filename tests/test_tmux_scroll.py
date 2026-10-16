import unittest
import subprocess
from types import SimpleNamespace
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

    def run_scroll(self, state, lines, scroll_state=None):
        calls = []

        def fake_tmux(args, **kwargs):
            calls.append(args)
            result = FakeRun()
            if args[0] == "display-message":
                result.stdout = state
            return result

        with patch.object(tmux_mgr, "_tmux", fake_tmux):
            result = tmux_mgr.scroll_session("cc_demo", lines, scroll_state)
        return result, calls

    def test_fullscreen_codex_uses_its_own_history(self):
        for lines, button in [(-7, 64), (7, 65)]:
            result, calls = self.run_scroll("1\t\tcodex\t24\n", lines)
            self.assertTrue(result)
            report = f"\x1b[<{button};1;2M"
            self.assertEqual(calls[1:], [["send-keys", "-t", "cc_demo", "-l", "--", report * 2]])

    def test_fullscreen_codex_escapes_existing_copy_mode(self):
        result, calls = self.run_scroll("1\tcopy-mode\tcodex\t24\n", -7)
        self.assertTrue(result)
        self.assertEqual(calls[1], ["send-keys", "-t", "cc_demo", "-X", "cancel"])
        self.assertEqual(calls[2][-1], "\x1b[<64;1;2M" * 2)
        self.assertFalse(any(call[0] == "copy-mode" for call in calls))

    def test_inline_codex_still_uses_tmux_history(self):
        result, calls = self.run_scroll("0\t\tcodex\t24\n", -7)
        self.assertTrue(result)
        self.assertEqual(calls[1][0], "copy-mode")
        self.assertEqual(calls[-1][-1], "scroll-up")

    def test_unknown_state_does_not_send_navigation_keys(self):
        for state in ["", "1\tchoose-tree\tcodex\t24", "1\t\tcodex\tinvalid", "1\t\tcodex\t0"]:
            result, calls = self.run_scroll(state, -7)
            self.assertFalse(result)
            self.assertEqual(len(calls), 1)

    def test_large_gesture_is_bounded(self):
        result, calls = self.run_scroll("1\t\tcodex\t24\n", -9999)
        self.assertTrue(result)
        self.assertEqual(calls[-1], ["send-keys", "-t", "cc_demo", "-l", "--", "\x1b[<64;1;2M" * 66])

    def test_native_small_movements_accumulate_without_overshoot(self):
        state = tmux_mgr.ScrollState()
        for _ in range(2):
            result, calls = self.run_scroll("1\t\tcodex\t24\n", -1, state)
            self.assertTrue(result)
            self.assertEqual(len(calls), 1)
        result, calls = self.run_scroll("1\t\tcodex\t24\n", -1, state)
        self.assertTrue(result)
        self.assertEqual(calls[-1][-1], "\x1b[<64;1;2M")
        self.assertEqual(state.remainder, 0)

    def test_short_codex_panes_target_transcript_not_composer(self):
        for height in [4, 9, 14, 24, 50]:
            result, calls = self.run_scroll(f"1\t\tcodex\t{height}\n", -3)
            self.assertTrue(result)
            self.assertEqual(calls[-1][-1], "\x1b[<64;1;2M")

    def test_foreground_codex_wrapper_uses_native_history_and_recovers_copy_mode(self):
        with patch.object(tmux_mgr, '_foreground_is_codex', return_value=True):
            result, calls = self.run_scroll('1\tcopy-mode\tsh\t14\t/dev/pts/11\n', -3)
        self.assertTrue(result)
        self.assertEqual(calls[1], ['send-keys', '-t', 'cc_demo', '-X', 'cancel'])
        self.assertEqual(calls[2][-1], '\x1b[<64;1;2M')

    def test_native_scroll_preserves_and_bounds_pointer_row(self):
        for row, expected in [(1, 1), (2, 2), (7, 7), (-8, 1), (9999, 14), ('bad', 2), (None, 2)]:
            def fake_tmux(args, **kwargs):
                result = FakeRun()
                result.stdout = '1\t\tcodex\t14\n'
                return result
            with patch.object(tmux_mgr, '_tmux', side_effect=fake_tmux) as tmux:
                self.assertTrue(tmux_mgr.scroll_session('cc_demo', -3, tmux_mgr.ScrollState(), row))
                self.assertEqual(tmux.call_args.args[0][-1], f'\x1b[<64;1;{expected}M')

    def test_background_codex_does_not_receive_foreground_shell_scroll(self):
        with patch.object(tmux_mgr, '_foreground_is_codex', return_value=False):
            result, calls = self.run_scroll('1\t\tsh\t24\t/dev/pts/11\n', -3)
        self.assertTrue(result)
        self.assertEqual(calls[1][0], 'copy-mode')

    def test_wrapper_detection_checks_foreground_group_without_reading_arguments(self):
        for processes, expected in [('77 77 sh\n77 77 codex\n', True), ('77 77 bash\n77 88 codex\n', False)]:
            with patch.object(tmux_mgr.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=processes)) as ps:
                self.assertEqual(tmux_mgr._foreground_is_codex('/dev/pts/11'), expected)
                self.assertEqual(ps.call_args.args[0][-1], 'tpgid=,pgid=,comm=')
        with patch.object(tmux_mgr.subprocess, 'run') as ps:
            self.assertFalse(tmux_mgr._foreground_is_codex('/etc/passwd'))
            ps.assert_not_called()

    def test_wrapper_detection_failure_is_safe(self):
        with patch.object(tmux_mgr.subprocess, 'run', side_effect=OSError):
            self.assertFalse(tmux_mgr._foreground_is_codex('/dev/pts/11'))
        with patch.object(tmux_mgr.subprocess, 'run', side_effect=subprocess.TimeoutExpired('ps', 1)):
            self.assertFalse(tmux_mgr._foreground_is_codex('/dev/pts/11'))

    def test_native_reversal_pause_and_target_change_discard_remainder(self):
        for action in ["reverse", "pause", "target", "reset"]:
            state = tmux_mgr.ScrollState()
            with patch.object(tmux_mgr.time, "monotonic", return_value=10):
                self.assertEqual(state.wheel_steps(("cc_demo", 24), -2), 0)
            target = ("cc_other", 24) if action == "target" else ("cc_demo", 24)
            if action == "reset":
                state.reset()
            with patch.object(tmux_mgr.time, "monotonic", return_value=10.3 if action == "pause" else 10.01):
                self.assertEqual(state.wheel_steps(target, 2 if action == "reverse" else -2), 0)

    def test_native_remainders_are_connection_local_and_cleared_for_shells(self):
        first, second = tmux_mgr.ScrollState(), tmux_mgr.ScrollState()
        first.wheel_steps(("cc_demo", 24), -2)
        self.assertEqual(second.wheel_steps(("cc_demo", 24), -1), 0)
        self.run_scroll("0\t\tbash\t24\n", -1, first)
        self.assertEqual(first.remainder, 0)

    def test_failed_native_send_clears_remainder(self):
        state = tmux_mgr.ScrollState()
        def fake_tmux(args, **kwargs):
            result = FakeRun()
            result.stdout = "1\t\tcodex\t24\n"
            if args[0] == "send-keys":
                result.returncode = 1
            return result
        with patch.object(tmux_mgr, "_tmux", fake_tmux):
            self.assertFalse(tmux_mgr.scroll_session("cc_demo", -7, state))
        self.assertEqual(state.remainder, 0)

    def test_zero_and_invalid_gestures_do_nothing(self):
        for lines in [0, "invalid", None]:
            with patch.object(tmux_mgr, "_tmux") as run:
                self.assertFalse(tmux_mgr.scroll_session("cc_demo", lines))
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
