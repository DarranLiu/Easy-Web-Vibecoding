from contextlib import ExitStack
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from backend import agent_sessions as sessions, agent_updates as updates, config, terminal_restart as restart


@unittest.skipUnless(Path("/proc/self/exe").exists() and shutil.which("sleep"), "Linux native process fixture required")
class NativeIdentityTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix="webcc-native-identity-")))
        self.versions = self.root / "share/claude/versions"
        self.versions.mkdir(parents=True)
        self.versions.chmod(0o755)
        self.entry = self.root / "bin/claude"
        self.entry.parent.mkdir()
        self.latest = self.binary(self.versions / "2.1.304")
        self.entry.symlink_to(self.latest)
        self.stack.enter_context(patch.object(config, "CLAUDE_BIN", str(self.entry)))
        self.stack.enter_context(patch.dict(os.environ, {"CC_WEB_REAL_CLAUDE": str(self.entry)}))

    def binary(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(shutil.which("sleep"), path)
        path.chmod(0o700)
        return path

    def launch(self, path=None):
        path = path or self.binary(self.versions / "2.1.303")
        child = subprocess.Popen([str(path), "60"], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        def stop():
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=5)
        self.stack.callback(stop)
        info = sessions.process(child.pid)
        self.assertIsNotNone(info)
        self.assertEqual(info["comm"], path.name)
        return info

    def test_version_named_native_release_is_recognized_without_rewriting_raw_identity(self):
        info = self.launch()
        self.assertEqual(sessions.native_agent(info), "claude")
        self.assertEqual(info["comm"], "2.1.303")
        self.assertEqual(sessions.process(info["pid"])["comm"], "2.1.303")

    def test_probe_uses_the_running_executable_not_the_updated_shared_entry(self):
        info = self.launch()
        foreground = {**info, "comm": "claude"}
        with patch.object(restart, "_existing_pane", return_value={"id": "%offline"}), \
             patch.object(restart, "_foreground", return_value=foreground), \
             patch.object(updates, "installed_version", return_value="2.1.303") as probe:
            value = updates.running_version("offline")
        self.assertEqual(value["agent"], "claude")
        self.assertEqual(value["version"], "2.1.303")
        self.assertEqual(value["state"], "running")
        probe.assert_called_once_with("claude", f"/proc/{info['pid']}/exe")

    def test_deleted_old_executable_is_still_recognized_via_proc(self):
        info = self.launch()
        (self.versions / "2.1.303").unlink()
        self.assertTrue(os.readlink(f"/proc/{info['pid']}/exe").endswith(" (deleted)"))
        self.assertEqual(sessions.native_agent(info), "claude")

    def test_numeric_name_outside_the_selected_installation_is_not_trusted(self):
        for directory in (self.root / "unrelated", self.root / "unselected/claude/versions"):
            with self.subTest(directory=directory):
                info = self.launch(self.binary(directory / "2.1.303"))
                self.assertIsNone(sessions.native_agent(info))

    def test_changed_pid_identity_or_unrelated_executable_name_is_rejected(self):
        info = self.launch()
        self.assertIsNone(sessions.native_agent({**info, "start": "stale"}))
        self.assertIsNone(sessions.native_agent({**info, "comm": "2.1.305"}))
        self.assertIsNone(sessions.native_agent({**info, "comm": "2.1.303-beta"}))

    def test_world_writable_directory_and_group_writable_executable_are_rejected(self):
        info = self.launch()
        self.versions.chmod(0o777)
        self.assertIsNone(sessions.native_agent(info))
        self.versions.chmod(0o755)
        (self.versions / "2.1.303").chmod(0o770)
        self.assertIsNone(sessions.native_agent(info))

    def test_native_installer_group_directory_permissions_remain_supported(self):
        info = self.launch()
        self.versions.chmod(0o775)
        self.assertEqual(sessions.native_agent(info), "claude")

    def test_missing_process_files_fail_closed_without_launching_a_probe(self):
        info = self.launch()
        with patch.object(sessions.os, "readlink", side_effect=OSError("gone")), \
             patch.object(updates, "installed_version") as probe:
            self.assertIsNone(sessions.native_agent(info))
        probe.assert_not_called()

    def test_existing_named_agents_keep_their_original_behavior(self):
        for name in ("claude", "codex", "opencode"):
            self.assertEqual(sessions.native_agent({"comm": name}), name)
        self.assertIsNone(sessions.native_agent(None))
        self.assertIsNone(sessions.native_agent({"comm": "python"}))

    def test_foreground_resolution_normalizes_the_verified_alias_and_preserves_job_control(self):
        info = self.launch()
        root = {"pid": 100, "comm": "bash", "tty": 99, "pgid": 100, "foreground": info["pid"], "start": "root"}
        alias = {**info, "ppid": 100, "tty": 99, "foreground": info["pid"]}
        with patch.object(sessions, "process", side_effect=lambda pid: root if pid == 100 else alias), \
             patch.object(sessions, "descendants", return_value=[100, info["pid"]]):
            foreground = restart._foreground({"pid": 100})
            self.assertEqual(foreground["pid"], info["pid"])
            self.assertEqual(foreground["comm"], "claude")
            self.assertEqual(alias["comm"], "2.1.303")
            with patch.object(sessions, "native_agent", return_value=None), self.assertRaises(restart.RestartError):
                restart._foreground({"pid": 100})

    def test_unknown_foreground_is_not_reported_as_an_idle_window(self):
        with patch.object(restart, "_existing_pane", return_value={"id": "%offline"}), \
             patch.object(restart, "_foreground", side_effect=restart.RestartError("Other foreground")):
            self.assertEqual(updates.running_version("offline")["state"], "unknown")
        with patch.object(restart, "_existing_pane", return_value=None):
            self.assertEqual(updates.running_version("offline")["state"], "idle")
