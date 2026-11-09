import asyncio
from contextlib import ExitStack
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
import uuid
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from backend import agent_sessions as sessions, config, main, terminal_artifacts as artifacts
from backend import terminal_continuity as continuity, terminal_preflight as preflight
from backend import terminal_recovery, terminal_restart as restart, tmux_mgr

LIST_SESSIONS = tmux_mgr.list_sessions

class ContinuityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(config, "AGENT_RUNTIME_DIR", self.root / "runtime"))
        self.stack.enter_context(patch.object(sessions, "boot_id", return_value="new-boot"))
        self.tab = {"id": "test01", "type": "codex", "cwd": str(self.root)}
        self.record = {"agent": "codex", "session_id": str(uuid.uuid4()), "run": "original",
                       "cwd": str(self.root), "home": str(self.root), "args": [],
                       "pid": 99999999, "start": "123", "boot": "old-boot"}
        self.tabs = [self.tab]
        self.stack.enter_context(patch.object(continuity.store, "list_tabs", side_effect=lambda: self.tabs))
        self.stack.enter_context(patch.object(continuity.store, "get_tab", side_effect=lambda sid: next((tab for tab in self.tabs if tab["id"] == sid), None)))
        self.live = []
        self.stack.enter_context(patch.object(tmux_mgr, "list_sessions", side_effect=lambda: self.live))
        self.stack.enter_context(patch.object(terminal_recovery, "_occupied", return_value=set()))
        self.stack.enter_context(patch.object(main, "safe_resolve"))
        self.stack.enter_context(patch.object(restart, "_inspect", return_value={"ready": True, "running": False, "stopped": True, "expected": "checked"}))
        self.execute = self.stack.enter_context(patch.object(restart, "restart_locked", return_value={"resumed": True}))
        self.artifact = artifacts.root() / "test" / "codex"
        self.artifact.parent.mkdir()
        self.artifact.write_bytes(b"\x7fELFdemo")
        self.artifact.chmod(0o700)
        self.arm()

    def arm(self, sid="test01", **changes):
        sessions.save(sid, self.record)
        value = {"armed": True, "boot": "old-boot", "state": "watching", "signature": continuity.signature(self.record),
                 "artifact": {"path": str(self.artifact), "identity": artifacts.identity(self.artifact), "agent": "codex"}}
        value.update(changes)
        sessions.save(sid, value, suffix=continuity.SUFFIX)
        return value

    def enqueue(self, sid="test01"):
        return continuity.enqueue(sid, continuity.signature(self.record))

    def test_only_proven_previous_boot_running_windows_are_eligible(self):
        self.assertTrue(continuity.status("test01", False)["eligible"])
        self.assertFalse(continuity.status("test01", True)["eligible"])
        self.assertFalse(continuity.status("legacy", False)["eligible"])
        for changes in ({"boot": "new-boot"}, {"armed": False}, {"artifact": {}}, {"signature": "changed"}):
            self.arm(**changes)
            self.assertFalse(continuity.status("test01", False)["eligible"])

    def test_duplicate_or_lost_response_never_enqueues_a_second_launch(self):
        self.assertEqual(self.enqueue()["state"], "queued")
        request = sessions.load("test01", suffix=continuity.SUFFIX)["requestId"]
        self.enqueue()
        self.assertEqual(sessions.load("test01", suffix=continuity.SUFFIX)["requestId"], request)
        continuity.run_next()
        self.assertEqual(self.enqueue()["state"], "ready")
        continuity.run_next()
        self.execute.assert_called_once()
        body = self.execute.call_args.args[2]
        self.assertTrue(body["savedVersion"])
        self.assertNotIn("confirmed", body)

    def test_live_window_is_attached_without_input_or_update(self):
        self.enqueue()
        self.live = [self.tab]
        continuity.run_next()
        self.assertEqual(self.enqueue()["state"], "attached")
        self.execute.assert_not_called()

    def test_stop_or_delete_cancels_queued_recovery(self):
        self.enqueue()
        continuity.disarm("test01")
        continuity.run_next()
        self.execute.assert_not_called()
        self.assertFalse(continuity.status("test01", False)["eligible"])
        self.arm()
        self.enqueue()
        self.tabs.clear()
        continuity.run_next()
        self.execute.assert_not_called()

    def test_missing_inventory_disarms_same_boot_but_preserves_reboot_intent(self):
        continuity.missing(set())
        self.assertTrue(continuity.status("test01", False)["eligible"])
        self.arm(boot="new-boot")
        continuity.missing(set())
        self.assertFalse(sessions.load("test01", suffix=continuity.SUFFIX)["armed"])

    def test_changed_record_or_occupied_dialogue_is_not_started(self):
        for changed in (True, False):
            self.arm()
            self.enqueue()
            if changed:
                sessions.save("test01", {**self.record, "session_id": str(uuid.uuid4())})
            with patch.object(terminal_recovery, "_occupied", return_value={self.record["session_id"]}):
                continuity.run_next()
            self.assertEqual(continuity.status("test01", False)["state"], "attention")
        self.execute.assert_not_called()

    def test_failed_job_does_not_block_next_and_never_automatically_retries(self):
        self.tabs.append({**self.tab, "id": "test02"})
        self.arm("test02")
        self.enqueue()
        self.enqueue("test02")
        self.execute.side_effect = [restart.RestartError("Version unavailable"), {"resumed": True}]
        continuity.run_next()
        continuity.run_next()
        continuity.run_next()
        self.assertEqual(self.execute.call_count, 2)
        self.assertEqual(continuity.status("test01", False)["state"], "attention")
        self.assertEqual(continuity.status("test02", False)["state"], "ready")

    def test_two_backends_share_one_serial_worker(self):
        self.enqueue()
        entered, finish = threading.Event(), threading.Event()
        def execute(*args):
            entered.set()
            finish.wait(3)
            return {"resumed": True}
        self.execute.side_effect = execute
        worker = threading.Thread(target=continuity.run_next)
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            continuity.run_next()
            self.assertEqual(self.execute.call_count, 1)
        finally:
            finish.set()
            worker.join(3)
        self.assertFalse(worker.is_alive())

    def test_worker_restart_does_not_replay_uncertain_command(self):
        self.enqueue()
        value = sessions.load("test01", suffix=continuity.SUFFIX)
        value["state"] = "restoring"
        sessions.save("test01", value, suffix=continuity.SUFFIX)
        continuity.run_next()
        self.execute.assert_not_called()
        self.assertEqual(continuity.status("test01", False)["state"], "attention")

    def test_missing_or_changed_artifact_never_falls_back_to_latest(self):
        self.enqueue()
        self.artifact.unlink()
        continuity.run_next()
        self.execute.assert_not_called()
        self.assertEqual(continuity.status("test01", False)["state"], "attention")

    def test_stale_enqueue_body_and_bad_request_are_rejected(self):
        with self.assertRaises(restart.RestartError):
            continuity.enqueue("test01", "stale")
        request = Mock(json=AsyncMock(return_value={}))
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(main.enqueue_session_restore("test01", request, None))
        self.assertEqual(caught.exception.status_code, 400)

    def test_request_is_fast_queue_admission_not_native_restart(self):
        request = Mock(json=AsyncMock(return_value={"expected": continuity.signature(self.record)}))
        with patch.object(main, "safe_resolve"):
            result = asyncio.run(main.enqueue_session_restore("test01", request, None))
        self.assertEqual(result["state"], "queued")
        self.execute.assert_not_called()

    def test_boot_identity_prevents_pid_reuse(self):
        with patch.object(sessions, "process", return_value={"start": "123"}):
            self.assertFalse(sessions.same_process(self.record))
            self.assertTrue(sessions.same_process({**self.record, "boot": "new-boot"}))

    def test_saved_version_is_selected_even_if_shared_install_changes(self):
        with patch.object(restart.terminal_launch, "session_environment", return_value={"CC_WEB_REAL_CODEX": "/changed/latest"}), patch.object(preflight, "check", side_effect=RuntimeError("checked")) as check:
            # Use the real implementation beneath the worker mock.
            with self.assertRaises(restart.RestartError):
                restart._restart_locked("test01", self.tab, {"requestId": str(uuid.uuid4()), "expected": "checked", "savedVersion": True})
            self.assertEqual(check.call_args.args[1], str(self.artifact))

    def test_preflight_caches_only_capabilities_and_still_checks_arguments(self):
        preflight._help.cache_clear()
        executable = self.root / "help"
        executable.write_text("#!/bin/sh\nprintf '%s\\n' '--no-daemon --model'\n")
        executable.chmod(0o700)
        with patch.object(preflight.subprocess, "run", wraps=subprocess.run) as run:
            preflight.check("codex", str(executable), ["--model", "demo"])
            preflight.check("codex", str(executable), ["--model", "demo"])
            self.assertEqual(run.call_count, 2)
            with self.assertRaisesRegex(RuntimeError, "--unknown"):
                preflight.check("codex", str(executable), ["--unknown"])
            executable.write_text("#!/bin/sh\nprintf '%s\\n' '--no-daemon --model --unknown'\n")
            preflight.check("codex", str(executable), ["--unknown"])
            self.assertEqual(run.call_count, 4)

    def test_capture_keeps_codex_bundle_after_original_install_is_removed(self):
        bundle = self.root / "distribution"
        (bundle / "bin").mkdir(parents=True)
        binary = bundle / "bin" / "codex"
        shutil.copy2(shutil.which("sleep"), binary)
        (bundle / "codex-package.json").write_text('{}')
        (bundle / "codex-resources").mkdir()
        (bundle / "codex-resources" / "test.txt").write_text("resource")
        (bundle / "codex").symlink_to("bin/codex")
        for item in bundle.rglob("*"):
            if not item.is_symlink():
                item.chmod(0o755 if item.is_dir() or item == binary else 0o644)
        proc = subprocess.Popen([str(binary), "30"])
        try:
            record = {**sessions.process(proc.pid), "agent": "codex", "boot": "new-boot"}
            value = artifacts.capture(record)
            again = artifacts.capture(record)
            self.assertEqual(value, again)
            shutil.rmtree(bundle)
            saved = Path(artifacts.validate(value, "codex"))
            self.assertEqual((saved.parent.parent / "codex-resources/test.txt").read_text(), "resource")
            self.assertEqual((saved.parent.parent / "codex").resolve(), saved)
        finally:
            proc.terminate()
            proc.wait(3)

    def test_tmux_failure_is_not_reported_as_all_windows_stopped(self):
        # API errors must not be turned into a successful empty inventory.
        original = tmux_mgr.list_sessions.side_effect
        with patch.object(tmux_mgr, "_tmux", return_value=Mock(returncode=1, stderr="permission denied")):
            with self.assertRaises(HTTPException) as caught:
                tmux_mgr.list_sessions.side_effect = RuntimeError("inventory unavailable")
                main.list_sessions(None)
            self.assertEqual(caught.exception.status_code, 503)
        tmux_mgr.list_sessions.side_effect = original

    def test_tmux_inventory_distinguishes_missing_server_from_errors_and_timeout(self):
        for stderr in ("permission denied", "server exited unexpectedly"):
            with patch.object(tmux_mgr, "_tmux", return_value=Mock(returncode=1, stderr=stderr)):
                with self.assertRaises(RuntimeError):
                    LIST_SESSIONS()
        with patch.object(tmux_mgr, "_tmux", side_effect=subprocess.TimeoutExpired("tmux", 5)):
            with self.assertRaises(RuntimeError):
                LIST_SESSIONS()
        with patch.object(tmux_mgr, "_tmux", return_value=Mock(returncode=1, stderr="no server running on /tmp/test")):
            self.assertEqual(LIST_SESSIONS(), [])

    def test_failed_restore_does_not_rearm_on_a_later_server_boot(self):
        self.enqueue()
        self.execute.side_effect = restart.RestartError("Unavailable")
        continuity.run_next()
        with patch.object(sessions, "boot_id", return_value="third-boot"):
            self.assertFalse(continuity.status("test01", False)["eligible"])

    def test_native_prompt_is_attention_not_success_and_does_not_block_queue(self):
        self.enqueue()
        self.execute.return_value = {"alive": True, "resumed": False, "resumePending": True}
        continuity.run_next()
        self.assertEqual(continuity.status("test01", True)["state"], "attention")
        self.assertTrue(self.execute.call_args.args[2]["backgroundRestore"])

    def test_moved_claude_history_requires_exact_id_cwd_unique_path_and_prior_proof(self):
        record = {**self.record, "agent": "claude", "hook_seen": True, "transcript": str(self.root / "missing.jsonl")}
        path = self.root / "projects" / "moved" / (record["session_id"] + ".jsonl")
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"sessionId": record["session_id"], "cwd": record["cwd"]}) + '\n')
        for candidate, content in (
            ({**record, "hook_seen": False}, {"sessionId": record["session_id"], "cwd": record["cwd"]}),
            (record, {"sessionId": str(uuid.uuid4()), "cwd": record["cwd"]}),
            (record, {"sessionId": record["session_id"], "cwd": str(self.root / "other")}),
        ):
            sessions.save("test01", candidate)
            path.write_text(json.dumps(content) + '\n')
            self.assertEqual(sessions.refresh_claude_transcript("test01", candidate), candidate)
        path.write_text(json.dumps({"sessionId": record["session_id"], "cwd": record["cwd"]}) + '\n')
        sessions.save("test01", record)
        other = self.root / "projects" / "duplicate" / path.name
        other.parent.mkdir()
        shutil.copy2(path, other)
        self.assertEqual(sessions.refresh_claude_transcript("test01", record), record)
        other.unlink()
        result = sessions.refresh_claude_transcript("test01", record)
        self.assertEqual(result["transcript"], str(path))
        self.assertEqual(result["session_id"], record["session_id"])
        self.assertEqual(result["run"], record["run"])
        self.assertTrue(sessions.transcript_exists(result))
        self.assertEqual(sessions.load("test01", suffix=".saved.json"), result)

    def test_live_explicit_claude_resume_can_keep_history_in_original_project(self):
        record = {**self.record, **sessions.process(os.getpid()), "boot": "new-boot", "agent": "claude",
                  "managed": True, "hook_seen": True, "cwd": str(Path.cwd()), "transcript": str(self.root / "missing.jsonl"),
                  "args": ["--resume", self.record["session_id"]]}
        path = self.root / "projects" / "original" / (record["session_id"] + ".jsonl")
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"sessionId": record["session_id"], "cwd": str(self.root)}) + '\n')
        sessions.save("test01", record)
        with patch.object(sessions, "native_agent", return_value="claude"):
            result = sessions.refresh_claude_transcript("test01", record)
        self.assertEqual(result["transcript"], str(path))
        self.assertEqual(result["cwd"], record["cwd"])
        for changed in ({"args": ["--continue"]}, {"pid": 99999999}, {"hook_seen": False}, {"managed": False}):
            candidate = {**record, **changed}
            sessions.save("test01", candidate)
            with patch.object(sessions, "native_agent", return_value="claude"):
                self.assertEqual(sessions.refresh_claude_transcript("test01", candidate), candidate)


if __name__ == "__main__":
    unittest.main()
