import asyncio
from contextlib import ExitStack
from datetime import datetime, timezone
import json
import hashlib
import io
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tempfile
import tarfile
import time
import unittest
import uuid
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from backend import agent_sessions as sessions, agent_updates as updates
from backend import config, main, terminal_launch, terminal_restart as restart, tmux_mgr


class RestartUnitTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="webcc-restart-unit-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.override = patch.object(config, "AGENT_RUNTIME_DIR", self.root / "runtime")
        self.override.start()
        self.addCleanup(self.override.stop)
        update_override = patch.object(config, "AGENT_UPDATE_DIR", self.root / "updates")
        update_override.start()
        self.addCleanup(update_override.stop)
        self.identifier = str(uuid.uuid4())

    def record(self, agent="codex", args=None):
        return {"agent": agent, "session_id": self.identifier, "args": args or [], "cwd": str(self.root)}

    def test_resume_is_exact_and_never_replays_prompts_or_uses_last(self):
        args = restart.resume_arguments(self.record(args=["resume", "old-id", "--last", "-m", "demo-model", "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "Original prompt", "--no-daemon"]))
        self.assertEqual(args[:2], ["resume", self.identifier])
        self.assertNotIn("--last", args)
        self.assertNotIn("Original prompt", args)
        self.assertIn("workspace-write", args)
        self.assertIn("on-request", args)
        self.assertIn("--no-daemon", terminal_launch.guarded_arguments("codex", args, {}))
        args = restart.resume_arguments(self.record("claude", ["--continue", "--fork-session", "--model", "demo-model", "--permission-mode", "plan", "Old prompt"]))
        self.assertEqual(args[-2:], ["--resume", self.identifier])
        self.assertNotIn("--continue", args)
        self.assertNotIn("--fork-session", args)
        self.assertIn("plan", args)

    def test_unknown_flags_and_bad_ids_are_rejected_before_stopping(self):
        with self.assertRaises(restart.RestartError):
            restart.resume_arguments(self.record(args=["--future-unknown", "something"]))
        record = self.record()
        record["session_id"] = "some-name-not-a-uuid"
        with self.assertRaises(restart.RestartError):
            restart.resume_arguments(record)

    def test_old_transcript_provider_never_overrides_current_launch_routing(self):
        record = self.record(args=["-c", 'model_provider="current-provider"'])
        record["provider"] = "old-provider"
        args = restart.resume_arguments(record)
        self.assertIn('model_provider="current-provider"', args)
        self.assertFalse(any("old-provider" in arg for arg in args))
        record["args"] = []
        self.assertFalse(any("model_provider" in arg for arg in restart.resume_arguments(record)))

    def test_private_metadata_permissions_and_symlink_protection(self):
        sessions.save("fixture", {"run": "demo"})
        self.assertEqual(config.AGENT_RUNTIME_DIR.stat().st_mode & 0o777, 0o700)
        self.assertEqual((config.AGENT_RUNTIME_DIR / "fixture.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual(sessions.load("../outside"), {})
        outside = self.root / "outside.json"
        outside.write_text('{"secret": true}')
        (config.AGENT_RUNTIME_DIR / "symlink.json").symlink_to(outside)
        self.assertEqual(sessions.load("symlink"), {})

    def test_operation_lock_blocks_other_backends_and_management(self):
        with sessions.lock("fixture", "operation", blocking=False):
            self.assertTrue(restart.is_mutating("fixture"))
            with patch.object(main.store, "get_tab", return_value={"id": "fixture"}), patch.object(tmux_mgr, "kill_session") as kill:
                for call in (main.stop_session, main.start_session, main.delete_session):
                    with self.assertRaises(HTTPException) as raised:
                        call("fixture", None)
                    self.assertEqual(raised.exception.status_code, 409)
                kill.assert_not_called()
        self.assertFalse(restart.is_mutating("fixture"))

    def test_missing_tab_and_invalid_body_do_not_start_or_stop(self):
        request = Mock(json=AsyncMock(return_value=[]))
        with patch.object(main.store, "get_tab", return_value={"id": "fixture"}), patch.object(restart, "restart") as execute:
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(main.restart_session("fixture", request, None))
            self.assertEqual(raised.exception.status_code, 400)
            execute.assert_not_called()
        with patch.object(main.store, "get_tab", return_value=None):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(main.restart_session("fixture", request, None))
            self.assertEqual(raised.exception.status_code, 404)

    def test_confirmation_and_stale_challenge_fail_without_input(self):
        preview = {"ready": True, "running": True, "expected": "challenge"}
        with patch.object(restart, "_inspect", return_value=preview), patch.object(restart, "_send") as send:
            for body in ({"expected": "old", "confirmed": True}, {"expected": "challenge", "confirmed": False}):
                body["requestId"] = str(uuid.uuid4())
                with self.assertRaises(restart.RestartError):
                    restart.restart("fixture", {}, body)
            send.assert_not_called()

    def test_pid_reuse_and_stale_hooks_cannot_replace_identity(self):
        record = {"pid": os.getpid(), "start": "wrong-start", "agent": "claude", "run": "current"}
        self.assertFalse(sessions.same_process(record))
        sessions.save("fixture", record)
        sessions.handle_hook({"session_id": self.identifier}, {
            "CC_WEB_SESSION_ID": "fixture", "CC_WEB_AGENT_RUNTIME_DIR": str(config.AGENT_RUNTIME_DIR),
            "CC_WEB_AGENT_RUN": "old", "CC_WEB_AGENT_PID": str(os.getpid()),
        })
        self.assertEqual(sessions.load("fixture"), record)

    def test_interactive_child_agent_cannot_replace_root_window_binding(self):
        record = {"pid": os.getpid(), "start": sessions.process(os.getpid())["start"], "agent": "claude", "run": "current"}
        sessions.save("fixture", record)
        env = {"CC_WEB_SESSION_ID": "fixture", "CC_WEB_AGENT_RUNTIME_DIR": str(config.AGENT_RUNTIME_DIR),
               "CC_WEB_AGENT_RUN": "current", "CC_WEB_AGENT_PID": str(os.getpid())}
        with patch.dict(os.environ, env), patch.object(os, "isatty", return_value=True), patch.object(
            os, "tcgetpgrp", return_value=os.getpgrp()
        ), patch.object(sessions, "record_process") as create, patch.object(subprocess, "Popen") as watch:
            self.assertEqual(sessions.prepare_launch("codex", ["resume", self.identifier]), ["resume", self.identifier])
            create.assert_not_called()
            watch.assert_not_called()
        self.assertEqual(sessions.load("fixture"), record)

    def test_exit_timeout_and_lingering_backend_never_force_kill_or_launch_again(self):
        binary = self.root / "native"
        binary.write_text("offline fixture")
        binary.chmod(0o700)
        record = {**self.record(), "run": "demo", "pid": 123, "start": "1", "home": str(self.root)}
        pane = {"id": "%fixture", "pid": 100, "tty": "/dev/pts/99", "cwd": str(self.root)}
        expected = restart._expected("fixture", pane, record)
        preview = {"ready": True, "running": True, "expected": expected}
        for native_alive in (True, False):
            sessions.save("fixture", record)
            with self.subTest(native_alive=native_alive), patch.object(restart, "_inspect", return_value=preview), patch.object(
                restart, "_existing_pane", return_value=pane
            ), patch.object(restart, "_foreground", return_value={"pid": 123, "start": "1"}), patch.object(
                sessions, "same_process", return_value=native_alive
            ), patch.object(sessions, "descendants", return_value=[]), patch.object(
                sessions, "codex_conversation", return_value={"session_id": self.identifier}
            ), patch.object(terminal_launch, "session_environment", return_value={"CC_WEB_REAL_CODEX": str(binary)}), patch.object(
                restart, "_wait", return_value=False
            ), patch.object(restart.terminal_preflight, "check", return_value={"path": str(binary), "identity": []}), patch.object(
                terminal_launch, "shell_bootstrap", return_value=self.root / "fixture.shell"
            ), patch.object(restart, "_send") as send, patch.object(tmux_mgr, "exit_copy_mode"), patch.object(tmux_mgr, "kill_session") as kill:
                with self.assertRaises(restart.RestartError):
                    restart.restart("fixture", {}, {"requestId": str(uuid.uuid4()), "expected": expected, "confirmed": True})
                kill.assert_not_called()
                self.assertTrue(all(call.args[1:] == ("C-c",) for call in send.call_args_list))

    def test_one_time_restart_plan_expires_and_cannot_be_replayed(self):
        record = {"run": "demo", "pid": 0}
        sessions.save("fixture", record)
        suffix = "." + str(uuid.uuid4()) + ".plan.json"
        plan = {"agent": "codex", "run": "demo", "args": ["resume", self.identifier], "expires": time.time() - 1}
        sessions.save("fixture", plan, suffix=suffix)
        with patch.dict(os.environ, {"CC_WEB_SESSION_ID": "fixture", "CC_WEB_AGENT_RUNTIME_DIR": str(config.AGENT_RUNTIME_DIR),
                                     "CC_WEB_RESTART_PLAN": str(config.AGENT_RUNTIME_DIR / ("fixture" + suffix))}):
            with self.assertRaises(ValueError):
                sessions.take_restart_plan("codex")

    def test_codex_closed_files_and_returned_shell_are_exit_states_not_switches(self):
        record = {**self.record(), "run": "demo", "pid": 123, "start": "1"}
        pane = {"id": "%fixture", "pid": 100, "tty": "/dev/pts/99"}
        sessions.save("fixture", record)
        with patch.object(sessions, "same_process", return_value=True), patch.object(restart, "_pane", return_value=pane), \
             patch.object(restart, "_foreground", return_value={"pid": 123, "start": "1"}) as foreground, \
             patch.object(sessions, "codex_conversation", return_value=None):
            self.assertEqual(restart._codex_interrupt_state("fixture", pane, record), "closing")
            foreground.return_value = None
            self.assertEqual(restart._codex_interrupt_state("fixture", pane, record), "closing")

    def test_codex_exit_state_rejects_real_switches_ambiguity_and_other_foreground(self):
        record = {**self.record(), "run": "demo", "pid": 123, "start": "1"}
        pane = {"id": "%fixture", "pid": 100, "tty": "/dev/pts/99"}
        sessions.save("fixture", record)
        with patch.object(sessions, "same_process", return_value=True), patch.object(restart, "_pane", return_value=pane), \
             patch.object(restart, "_foreground", return_value={"pid": 123, "start": "1"}) as foreground, \
             patch.object(sessions, "codex_conversation") as identity:
            for value in (str(uuid.uuid4()), None):
                identity.return_value = {"session_id": value}
                with self.assertRaisesRegex(restart.RestartError, "原会话已改变"):
                    restart._codex_interrupt_state("fixture", pane, record)
            identity.return_value = {"session_id": self.identifier}
            self.assertEqual(restart._codex_interrupt_state("fixture", pane, record), "ready")
            foreground.return_value = {"pid": 456, "start": "2"}
            with self.assertRaisesRegex(restart.RestartError, "前台程序已改变"):
                restart._codex_interrupt_state("fixture", pane, record)

    def test_codex_exit_state_checks_saved_identity_and_pane_ownership(self):
        record = {**self.record(), "run": "demo", "pid": 123, "start": "1"}
        pane = {"id": "%fixture", "pid": 100, "tty": "/dev/pts/99"}
        sessions.save("fixture", record)
        with patch.object(sessions, "same_process", return_value=True), \
             patch.object(restart, "_pane", return_value={**pane, "pid": 101}):
            with self.assertRaisesRegex(restart.RestartError, "终端归属已改变"):
                restart._codex_interrupt_state("fixture", pane, record)
        sessions.save("fixture", {**record, "session_id": str(uuid.uuid4())})
        with self.assertRaisesRegex(restart.RestartError, "原会话已改变"):
            restart._codex_interrupt_state("fixture", pane, record)

    def test_codex_exited_state_does_not_require_open_session_files(self):
        record = {**self.record(), "run": "demo", "pid": 123, "start": "1"}
        sessions.save("fixture", record)
        with patch.object(sessions, "same_process", return_value=False), \
             patch.object(sessions, "codex_conversation") as identity:
            self.assertEqual(restart._codex_interrupt_state("fixture", {}, record), "exited")
            identity.assert_not_called()

    def test_claude_switch_between_preflight_and_interrupt_cancels_without_input(self):
        binary = self.root / "native"
        binary.write_text("offline fixture")
        binary.chmod(0o700)
        record = {**self.record("claude"), "run": "demo", "pid": 123, "start": "1", "home": str(self.root)}
        pane = {"id": "%fixture", "pid": 100, "tty": "/dev/pts/99", "cwd": str(self.root)}
        preview = {"ready": True, "running": True, "expected": restart._expected("fixture", pane, record)}
        sessions.save("fixture", record)

        def switched(_):
            sessions.save("fixture", {**record, "session_id": str(uuid.uuid4())})
            return {"pid": 123, "start": "1"}

        with patch.object(restart, "_inspect", return_value=preview), patch.object(
            restart, "_existing_pane", return_value=pane
        ), patch.object(restart, "_pane", return_value=pane), patch.object(restart, "_foreground", side_effect=switched), patch.object(
            sessions, "same_process", return_value=True
        ), patch.object(sessions, "descendants", return_value=[]), patch.object(
            terminal_launch, "session_environment", return_value={"CC_WEB_REAL_CLAUDE": str(binary)}
        ), patch.object(restart.terminal_preflight, "check", return_value={"path": str(binary), "identity": []}), patch.object(
            terminal_launch, "shell_bootstrap", return_value=self.root / "fixture.shell"
        ), patch.object(restart, "_send") as send:
            with self.assertRaisesRegex(restart.RestartError, "原会话已改变"):
                restart.restart("fixture", {}, {"requestId": str(uuid.uuid4()), "expected": preview["expected"], "confirmed": True})
            send.assert_not_called()


@unittest.skipUnless(shutil.which("tmux"), "tmux required for isolated offline integration")
class RestartOfflineTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix="webcc-restart-offline-")))
        self.home = self.root / "home"
        self.home.mkdir()
        self.socket = str(self.root / "tmux.sock")
        self.env = {"PATH": "/usr/bin:/bin", "HOME": str(self.home), "CODEX_HOME": str(self.home / ".codex"), "XDG_DATA_HOME": str(self.home / ".local/share"),
                    "CLAUDE_CONFIG_DIR": str(self.home / ".claude"), "TERM": "xterm-256color", "BASH_ENV": "", "ENV": ""}
        self.stack.enter_context(patch.dict(os.environ, self.env, clear=True))
        self.stack.enter_context(patch.object(config, "AGENT_RUNTIME_DIR", self.root / "runtime"))
        self.stack.enter_context(patch.object(config, "AGENT_UPDATE_DIR", self.root / "updates"))
        self.stack.enter_context(patch.object(config, "TERMINAL_LAUNCHER_DIR", self.root / "launchers"))
        self.stack.enter_context(patch.object(config, "CODEX_MODEL_CATALOG", ""))
        self.stack.enter_context(patch.object(config, "CODEX_STATUS_LINE", []))
        fixture = Path(__file__).parent / "fixtures" / "restart_agent.py"
        for agent in ("codex", "claude", "opencode"):
            binary = self.root / agent
            binary.write_text(f"#!{sys.executable}\n" + fixture.read_text())
            binary.chmod(0o700)
            self.stack.enter_context(patch.object(config, agent.upper() + "_BIN", str(binary)))
        self.stack.enter_context(patch.object(tmux_mgr, "_tmux", self.tmux))
        self.tmux(["new-session", "-d", "-s", "keepalive", "sleep 120"]).check_returncode()
        self.addCleanup(self.cleanup_server)

    def tmux(self, args, **kwargs):
        return subprocess.run(["tmux", "-S", self.socket, "-f", "/dev/null", *args], env=self.env,
                              capture_output=True, text=True, timeout=10, **kwargs)

    def cleanup_server(self):
        self.tmux(["kill-server"])
        time.sleep(.6)

    def wait(self, predicate, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.1)
        self.fail("Offline fixture did not become ready")

    def launch(self, agent, sid="fixture", args=(), tracked=True):
        if tracked:
            command = main._launch_cmd(agent, "new") + (" " + shlex.join(args) if args else "")
            tmux_mgr.start_session(sid, str(self.root), command, {"type": agent})
        else:
            self.tmux(["new-session", "-d", "-s", "cc_" + sid, "-c", str(self.root)]).check_returncode()
            self.tmux(["send-keys", "-t", "cc_" + sid, str(self.root / agent), "Enter"]).check_returncode()
        self.wait(lambda: "OFFLINE_READY" in self.tmux(["capture-pane", "-p", "-t", "cc_" + sid]).stdout)
        tab = {"id": sid, "type": agent, "cwd": str(self.root), "name": "Synthetic task"}
        if tracked:
            self.wait(lambda: bool(sessions.load(sid).get("session_id") or sessions.load(sid).get("ambiguous")))
        return tab

    def body(self, tab):
        preview = restart.inspect(tab["id"], tab)
        self.assertTrue(preview["ready"])
        return {"requestId": str(uuid.uuid4()), "expected": preview["expected"], "confirmed": True}

    def test_codex_restart_preserves_exact_session_shell_and_other_same_directory_task(self):
        tab = self.launch("codex", args=("--sandbox", "workspace-write", "--ask-for-approval", "on-request"))
        other = self.launch("codex", "other")
        before, untouched = sessions.load("fixture"), sessions.load("other")
        pane_pid = restart._pane("fixture")["pid"]
        body = self.body(tab)
        result = restart.restart("fixture", tab, body)
        after = sessions.load("fixture")
        self.assertTrue(result["resumed"])
        self.assertEqual(after["session_id"], before["session_id"])
        self.assertNotEqual(after["pid"], before["pid"])
        self.assertEqual(restart._pane("fixture")["pid"], pane_pid)
        self.assertEqual(sessions.load(other["id"])["pid"], untouched["pid"])
        self.assertTrue(sessions.same_process(untouched))
        self.assertEqual(after["args"][:2], ["resume", before["session_id"]])
        self.assertIn("workspace-write", after["args"])
        self.assertIn("on-request", after["args"])
        self.assertEqual(restart.restart("fixture", tab, body), result)
        self.assertEqual(sessions.load("fixture")["pid"], after["pid"])

    def test_codex_delayed_exit_restores_exact_history_without_second_interrupt(self):
        self.tmux(["set-environment", "-g", "WEBCC_FIXTURE_EXIT_DELAY", "1.2"]).check_returncode()
        tab = self.launch("codex")
        other = self.launch("codex", "other")
        before, untouched = sessions.load("fixture"), sessions.load(other["id"])
        send = restart._send
        with patch.object(restart, "_send", side_effect=send) as sent:
            result = restart.restart("fixture", tab, self.body(tab))
        self.assertTrue(result["resumed"])
        self.assertEqual(sessions.load("fixture")["session_id"], before["session_id"])
        self.assertNotEqual(sessions.load("fixture")["pid"], before["pid"])
        self.assertEqual([call.args[1:] for call in sent.call_args_list if call.args[1:] == ("C-c",)], [("C-c",)])
        self.assertTrue(sessions.same_process(untouched))

    def test_codex_real_switch_after_interrupt_cancels_without_resume(self):
        self.tmux(["set-environment", "-g", "WEBCC_FIXTURE_EXIT_ACTION", "switch"]).check_returncode()
        tab = self.launch("codex")
        before = sessions.load("fixture")
        send = restart._send
        with patch.object(restart, "_send", side_effect=send) as sent:
            with self.assertRaisesRegex(restart.RestartError, "原会话已改变"):
                restart.restart("fixture", tab, self.body(tab))
        self.assertEqual([call.args[1:] for call in sent.call_args_list], [("C-c",)])
        self.assertTrue(sessions.same_process(before))

    def test_codex_failed_exit_attempt_can_restore_when_shell_is_ready(self):
        self.tmux(["set-environment", "-g", "WEBCC_FIXTURE_EXIT_DELAY", "1.2"]).check_returncode()
        tab = self.launch("codex")
        before = sessions.load("fixture")
        wait = restart._wait
        with patch.object(restart, "_wait", side_effect=lambda predicate, timeout: False if timeout == 12 else wait(predicate, timeout)):
            with self.assertRaisesRegex(restart.RestartError, "尚未正常退出"):
                restart.restart("fixture", tab, self.body(tab))
        self.wait(lambda: not sessions.same_process(before))
        result = restart.restart("fixture", tab, self.body(tab))
        self.assertTrue(result["resumed"])
        self.assertEqual(sessions.load("fixture")["session_id"], before["session_id"])

    def update_payload(self, agent, compatible=True):
        source = (self.root / agent).read_text().replace('FAKE_VERSION = "1.2.3"', 'FAKE_VERSION = "1.2.4"')
        if not compatible:
            source = source.replace("--no-daemon", "--unsupported-daemon")
        data = source.encode()
        if agent != "claude":
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode="w:gz") as package:
                names = ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg", "codex-resources/bwrap"] if agent == "codex" else ["opencode-linux-x64-baseline/opencode"]
                for name in names:
                    entry = tarfile.TarInfo(name)
                    entry.size, entry.mode = len(data), 0o700
                    package.addfile(entry, io.BytesIO(data))
            data = buffer.getvalue()
        release = {"version": "1.2.4", "checkedAt": time.time(), "attemptedAt": time.time(),
                   "checkId": str(uuid.uuid4()), "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                   "url": "https://github.com/official/synthetic-fixture", "archive": agent != "claude",
                   "executable": "bin/codex" if agent == "codex" else agent}
        updates._save(agent, release, ".catalog.json")
        return release, data

    def test_verified_updates_restore_each_agent_exactly_without_touching_other_tasks(self):
        for agent in ("codex", "claude", "opencode"):
            with self.subTest(agent=agent):
                sid, other_sid = "updated_" + agent, "untouched_" + agent
                tab = self.launch(agent, sid)
                other = self.launch(agent, other_sid)
                before, untouched = sessions.load(sid), sessions.load(other_sid)
                parent = restart._pane(sid)["pid"]
                preview = restart.inspect(sid, tab)
                release, payload = self.update_payload(agent)
                body = {"requestId": str(uuid.uuid4()), "mode": "update-restart", "confirmed": True,
                        "sid": sid, "expected": preview["expected"], "version": release["version"], "checkId": release["checkId"]}
                with patch.object(updates, "_open", return_value=io.BytesIO(payload)), \
                     patch.object(main.store, "get_tab", side_effect=lambda target: tab if target == sid else other if target == other_sid else None):
                    updates.start_update(agent, body)
                    self.wait(lambda: updates._job(agent).get("phase") not in updates.BUSY_PHASES, 15)
                job = updates._job(agent)
                self.assertEqual(job["phase"], "done", job.get("message"))
                self.assertTrue(job["resumed"])
                after = sessions.load(sid)
                self.assertEqual(after["session_id"], before["session_id"])
                self.assertEqual(after["home"], before["home"])
                self.assertNotEqual(after["pid"], before["pid"])
                self.assertEqual(restart._pane(sid)["pid"], parent)
                self.assertTrue(sessions.same_process(untouched))
                self.assertEqual(sessions.load(other_sid)["pid"], untouched["pid"])
                env = terminal_launch.session_environment()
                self.assertEqual(updates.installed_version(agent, env["CC_WEB_REAL_" + agent.upper()]), "1.2.4")
                self.assertEqual(updates.installed_version(agent, str(self.root / agent)), "1.2.4")

    def test_verified_but_incompatible_update_never_exits_the_original_codex(self):
        tab = self.launch("codex")
        before = sessions.load("fixture")
        release, payload = self.update_payload("codex", compatible=False)
        body = {"requestId": str(uuid.uuid4()), "mode": "update", "confirmed": True,
                "version": release["version"], "checkId": release["checkId"]}
        with patch.object(updates, "_open", return_value=io.BytesIO(payload)):
            updates.start_update("codex", body)
            self.wait(lambda: updates._job("codex").get("phase") not in updates.BUSY_PHASES)
        self.assertEqual(updates._job("codex")["phase"], "failed")
        self.assertFalse(updates._load("codex", ".active.json"))
        self.assertTrue(sessions.same_process(before))

    def test_claude_restart_uses_exact_session_and_retains_user_hooks(self):
        user_settings = self.root / "settings.json"
        user_settings.write_text(json.dumps({"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "/usr/bin/true"}]}]}, "permissions": {"defaultMode": "plan"}}))
        tab = self.launch("claude", args=("--settings", str(user_settings), "--permission-mode", "plan"))
        before = sessions.load("fixture")
        self.assertTrue(before["hook_seen"])
        generated = list(config.AGENT_RUNTIME_DIR.glob("*-settings.json"))[0]
        settings = json.loads(generated.read_text())
        self.assertEqual(len(settings["hooks"]["SessionStart"]), 2)
        self.assertEqual(settings["permissions"]["defaultMode"], "plan")
        result = restart.restart("fixture", tab, self.body(tab))
        after = sessions.load("fixture")
        self.assertTrue(result["resumed"])
        self.assertEqual(before["session_id"], after["session_id"])
        self.assertNotIn("--continue", after["args"])
        self.assertIn("--permission-mode", after["args"])

    def test_missing_transcript_never_interrupts_native_process(self):
        tab = self.launch("codex")
        record = sessions.load("fixture")
        Path(record["transcript"]).unlink()
        with self.assertRaises(restart.RestartError):
            restart.inspect("fixture", tab)
        self.assertTrue(sessions.same_process(record))

    def test_claude_switch_invalidates_confirmation_and_restores_the_new_current_id(self):
        tab = self.launch("claude")
        before = sessions.load("fixture")
        body = self.body(tab)
        current = str(uuid.uuid4())
        self.tmux(["send-keys", "-t", "cc_fixture", "-l", "--", "FAKE_SWITCH " + current + "\n"])
        self.wait(lambda: sessions.load("fixture").get("session_id") == current)
        with self.assertRaises(restart.RestartError):
            restart.restart("fixture", tab, body)
        self.assertTrue(sessions.same_process(before))
        restart.restart("fixture", tab, self.body(tab))
        self.assertEqual(sessions.load("fixture")["session_id"], current)

    def test_ambiguous_codex_files_never_choose_latest(self):
        tab = self.launch("codex", args=("--fake-multiple",))
        record = sessions.load("fixture")
        self.assertIsNone(record.get("session_id"))
        with self.assertRaises(restart.RestartError):
            restart.inspect("fixture", tab)
        self.assertTrue(sessions.same_process(record))

    def test_legacy_claude_requires_explicit_matching_uuid_then_becomes_tracked(self):
        tab = self.launch("claude", tracked=False)
        preview = restart.inspect("fixture", tab)
        self.assertTrue(preview["canBind"])
        self.assertFalse(preview["ready"])
        paths = list((self.home / ".claude/projects/offline").glob("*.jsonl"))
        identifier = paths[0].stem
        with self.assertRaises(restart.RestartError):
            restart.bind("fixture", tab, str(uuid.uuid4()))
        preview = restart.bind("fixture", tab, identifier)
        self.assertTrue(preview["ready"])
        restart.restart("fixture", tab, self.body(tab))
        self.assertTrue(sessions.load("fixture")["hook_seen"])
        self.assertEqual(sessions.load("fixture")["session_id"], identifier)

    def test_exited_agent_can_restore_without_killing_shell(self):
        tab = self.launch("codex")
        before = sessions.load("fixture")
        self.tmux(["send-keys", "-t", "cc_fixture", "C-c"])
        self.wait(lambda: not sessions.same_process(before))
        self.assertFalse(restart.inspect("fixture", tab)["running"])
        restart.restart("fixture", tab, self.body(tab))
        self.assertEqual(sessions.load("fixture")["session_id"], before["session_id"])

    def test_stopped_tmux_restores_recorded_conversation_not_a_new_one(self):
        tab = self.launch("codex")
        before = sessions.load("fixture")
        tmux_mgr.kill_session("cc_fixture")
        self.wait(lambda: not sessions.same_process(before))
        tab["alive"] = False
        preview = restart.inspect("fixture", tab)
        self.assertTrue(preview["stopped"])
        result = restart.restart("fixture", tab, self.body(tab))
        self.assertTrue(result["alive"])
        self.assertEqual(sessions.load("fixture")["session_id"], before["session_id"])

    def test_legacy_codex_migration_guards_parent_shell_after_manual_exit_and_resume(self):
        tab = self.launch("codex", tracked=False)
        preview = restart.inspect("fixture", tab)
        original = sessions.load("fixture")["session_id"]
        restart.restart("fixture", tab, {"requestId": str(uuid.uuid4()), "expected": preview["expected"], "confirmed": True})
        current = sessions.load("fixture")
        self.tmux(["send-keys", "-t", "cc_fixture", "C-c"])
        self.wait(lambda: not sessions.same_process(current))
        self.tmux(["send-keys", "-t", "cc_fixture", "codex resume " + original, "Enter"])
        self.wait(lambda: sessions.load("fixture").get("run") != current["run"] and sessions.load("fixture").get("session_id") == original)
        latest = sessions.load("fixture")
        self.assertTrue(latest["managed"])
        self.assertIn("--no-daemon", restart._arguments(latest["pid"]))
        self.assertTrue((config.AGENT_RUNTIME_DIR / "fixture.shell").is_file())

    def test_new_executable_without_isolation_flag_never_interrupts_existing_task(self):
        tab = self.launch("codex")
        before = sessions.load("fixture")
        broken = self.root / "unsupported"
        broken.write_text("#!/bin/sh\nprintf '%s\\n' '--no-alt-screen'\n")
        broken.chmod(0o700)
        with patch.object(config, "CODEX_BIN", str(broken)), patch.object(restart, "_send") as send:
            with self.assertRaisesRegex(restart.RestartError, "--no-daemon"):
                restart.restart("fixture", tab, self.body(tab))
            send.assert_not_called()
        self.assertTrue(sessions.same_process(before))

    def test_stopped_sidebar_start_uses_saved_id_and_original_account_directory(self):
        tab = self.launch("claude")
        before = sessions.load("fixture")
        tmux_mgr.kill_session("cc_fixture")
        self.wait(lambda: not sessions.same_process(before))
        alternate = self.root / "wrong-account"
        alternate.mkdir()
        with patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(alternate)}), patch.object(main.store, "get_tab", return_value=tab):
            result = main.start_session("fixture", None)
        self.assertTrue(result["resumed"])
        after = sessions.load("fixture")
        self.assertEqual(after["session_id"], before["session_id"])
        self.assertEqual(after["home"], before["home"])

    def test_agent_started_in_shell_tab_restores_its_saved_dialog(self):
        tab = self.launch("codex")
        before = sessions.load("fixture")
        tab["type"] = "shell"
        tmux_mgr.kill_session("cc_fixture")
        self.wait(lambda: not sessions.same_process(before))
        with patch.object(main.store, "get_tab", return_value=tab):
            result = main.start_session("fixture", None)
        self.assertEqual(result["resumeAgent"], "codex")
        self.assertEqual(sessions.load("fixture")["session_id"], before["session_id"])

    def test_opencode_exact_resume_with_private_route_tracking(self):
        tab = self.launch("opencode")
        other = self.launch("opencode", "other")
        before, untouched = sessions.load("fixture"), sessions.load("other")
        result = restart.restart("fixture", tab, self.body(tab))
        self.assertTrue(result["resumed"])
        self.assertEqual(sessions.load("fixture")["session_id"], before["session_id"])
        self.assertNotIn("--continue", sessions.load("fixture")["args"])
        self.assertTrue(sessions.same_process(untouched))
        self.assertNotEqual(before["session_id"], untouched["session_id"])

    def test_tools_and_failed_launch_do_not_lose_last_verified_history(self):
        tab = self.launch("codex")
        before = sessions.load("fixture")
        self.assertEqual(sessions.load("fixture", suffix=".saved.json")["session_id"], before["session_id"])
        for args in (["doctor"], ["-c", "example=true", "update"], ["archive"], ["apply", "task-id"]):
            self.assertFalse(sessions.interactive("codex", args))
        self.tmux(["send-keys", "-t", "cc_fixture", "C-c"])
        self.wait(lambda: not sessions.same_process(before))
        sessions.save("fixture", {**before, "session_id": None, "launch_failed": True})
        self.assertEqual(restart.inspect("fixture", tab)["sessionId"], before["session_id"])

    def test_stopped_unknown_dialog_is_not_replaced_with_a_new_or_recent_one(self):
        tab = {"id": "unknown", "type": "claude", "cwd": str(self.root)}
        with patch.object(main.store, "get_tab", return_value=tab), patch.object(tmux_mgr, "start_session") as start:
            with self.assertRaises(HTTPException):
                main.start_session("unknown", None)
            start.assert_not_called()

    def test_background_snapshot_adopts_current_legacy_conversation_without_input(self):
        self.launch("codex", tracked=False)
        self.launch("codex", "other", tracked=False)
        before = {sid: restart._foreground(restart._pane(sid)) for sid in ("fixture", "other")}
        live = [{"id": sid, "type": "codex", "cwd": str(self.root)} for sid in before]
        with patch.object(tmux_mgr, "list_sessions", return_value=live), patch.object(restart, "_send") as send:
            counts = restart.snapshot_existing()
            send.assert_not_called()
        self.assertEqual(counts["identified"], 2)
        identifiers = []
        for sid in before:
            record = sessions.load(sid, suffix=".saved.json")
            identifiers.append(record["session_id"])
            self.assertEqual(record["pid"], before[sid]["pid"])
            self.assertTrue(sessions.same_process(record))
        self.assertEqual(len(set(identifiers)), 2)

    def test_opencode_home_and_stale_observer_cannot_resume_previous_dialog(self):
        from backend import opencode_sessions
        tab = self.launch("opencode")
        record = sessions.load("fixture")
        observation = sessions.load("fixture", suffix=".route.json")
        sessions.save("fixture", {**observation, "run": "stale", "session_id": "ses_old123456789", "order": 2}, suffix=".route.json")
        self.assertEqual(opencode_sessions.refresh("fixture", record)["session_id"], record["session_id"])
        sessions.save("fixture", {**observation, "session_id": None, "order": 3}, suffix=".route.json")
        opencode_sessions.refresh("fixture", record)
        with self.assertRaisesRegex(restart.RestartError, "主页"):
            restart.inspect("fixture", tab)
        self.tmux(["send-keys", "-t", "cc_fixture", "C-c"])
        self.wait(lambda: not sessions.same_process(record))
        with self.assertRaisesRegex(restart.RestartError, "主页"):
            restart.inspect("fixture", tab)


@unittest.skipUnless(os.environ.get("CC_WEB_NATIVE_RESTART_TESTS") == "1", "opt-in native Codex restart test")
class NativeCodexRestartTests(unittest.TestCase):
    tmux = RestartOfflineTests.tmux
    cleanup_server = RestartOfflineTests.cleanup_server
    wait = RestartOfflineTests.wait

    def test_current_cli_restores_synthetic_history_in_isolated_home(self):
        binary = os.environ.get("CC_WEB_NATIVE_CODEX") or shutil.which("codex")
        if not binary:
            self.skipTest("Native Codex not installed")
        RestartOfflineTests.setUp(self)
        self.stack.enter_context(patch.object(config, "CODEX_BIN", binary))
        home = self.home / ".codex"
        home.mkdir()
        bundled = subprocess.check_output([binary, "debug", "models", "--bundled"], env=self.env, text=True, timeout=15)
        catalog = self.root / "catalog.json"
        catalog.write_text(bundled)
        models = json.loads(bundled)
        model = (models["models"] if isinstance(models, dict) else models)[0]["slug"]
        (home / "config.toml").write_text(
            f'model = {json.dumps(model)}\nmodel_provider = "offline"\n'
            f'model_catalog_json = {json.dumps(str(catalog))}\ncheck_for_update_on_startup = false\n'
            '\n[analytics]\nenabled = false\n'
            '\n[model_providers.offline]\nname = "Offline restart fixture"\n'
            'base_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n'
            f'\n[projects.{json.dumps(str(self.root))}]\ntrust_level = "trusted"\n'
        )
        identifier = str(uuid.uuid4())
        directory = home / "sessions/2026/01/01"
        directory.mkdir(parents=True)
        timestamp = datetime.now(timezone.utc).isoformat()
        version = subprocess.check_output([binary, "--version"], env=self.env, text=True, timeout=15).strip().split()[-1]
        records = [
            {"type": "session_meta", "payload": {"id": identifier, "timestamp": timestamp,
                "cwd": str(self.root), "originator": "codex_cli_rs", "cli_version": version,
                "source": "cli", "model_provider": "offline"}},
            {"type": "event_msg", "payload": {"type": "user_message", "message": "Offline restart fixture", "images": [], "local_images": []}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Synthetic original conversation"}]}},
            {"type": "event_msg", "payload": {"type": "agent_message", "message": "Synthetic original conversation"}},
        ]
        (directory / ("rollout-2026-01-01T00-00-00-" + identifier + ".jsonl")).write_text(
            "".join(json.dumps({"timestamp": timestamp, **item}) + "\n" for item in records))
        sid = "native"
        tmux_mgr.start_session(sid, str(self.root), main._launch_cmd("codex", "new") + " resume " + identifier)
        self.wait(lambda: "Synthetic original conversation" in self.tmux(["capture-pane", "-p", "-t", "cc_native"]).stdout, 20)
        tab = {"id": sid, "type": "codex", "cwd": str(self.root)}
        preview = restart.inspect(sid, tab)
        before = sessions.load(sid)
        result = restart.restart(sid, tab, {"requestId": str(uuid.uuid4()), "expected": preview["expected"], "confirmed": True})
        self.assertTrue(result["resumed"])
        self.assertEqual(sessions.load(sid)["session_id"], identifier)
        self.assertNotEqual(sessions.load(sid)["pid"], before["pid"])
        self.wait(lambda: "Synthetic original conversation" in self.tmux(["capture-pane", "-p", "-t", "cc_native"]).stdout, 20)


@unittest.skipUnless(os.environ.get("CC_WEB_NATIVE_OPENCODE_TESTS") == "1", "opt-in native OpenCode restart test")
class NativeOpenCodeRestartTests(unittest.TestCase):
    tmux = RestartOfflineTests.tmux
    cleanup_server = RestartOfflineTests.cleanup_server
    wait = RestartOfflineTests.wait

    def test_tui_route_observer_and_exact_resume_without_account_or_prompt(self):
        binary = os.environ.get("CC_WEB_NATIVE_OPENCODE") or shutil.which("opencode")
        if not binary:
            self.skipTest("Native OpenCode not installed")
        RestartOfflineTests.setUp(self)
        self.stack.enter_context(patch.object(config, "OPENCODE_BIN", binary))
        isolated = {"OPENCODE_DISABLE_AUTOUPDATE": "true", "OPENCODE_DISABLE_MODELS_FETCH": "true",
                    "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true", "OPENCODE_DISABLE_PROJECT_CONFIG": "true",
                    "OPENCODE_CONFIG_CONTENT": '{"autoupdate":false,"mcp":{},"plugin":[],"provider":{}}'}
        self.env.update(isolated)
        os.environ.update(isolated)
        identifier = "ses_" + uuid.uuid4().hex
        fixture = self.root / "session.json"
        fixture.write_text(json.dumps({"info": {"id": identifier, "slug": "offline-session", "projectID": "global",
            "directory": str(self.root), "title": "Synthetic offline history", "version": "1.18.33",
            "time": {"created": 1700000000000, "updated": 1700000000000}}, "messages": []}))
        result = subprocess.run([binary, "import", str(fixture)], cwd=self.root, env=self.env,
                                capture_output=True, text=True, timeout=45)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        self.assertIn(identifier, result.stdout)
        for key, value in isolated.items():
            self.tmux(["set-environment", key, value]).check_returncode()
        sid = "nativeoc"
        tmux_mgr.start_session(sid, str(self.root), main._launch_cmd("opencode", "new") + " --session " + identifier)
        self.wait(lambda: sessions.load(sid).get("session_id") == identifier, 30)
        tab = {"id": sid, "type": "opencode", "cwd": str(self.root)}
        before = sessions.load(sid)
        preview = restart.inspect(sid, tab)
        result = restart.restart(sid, tab, {"requestId": str(uuid.uuid4()), "expected": preview["expected"], "confirmed": True})
        self.assertTrue(result["resumed"])
        self.assertEqual(sessions.load(sid)["session_id"], identifier)
        self.assertNotEqual(sessions.load(sid)["pid"], before["pid"])


if __name__ == "__main__":
    unittest.main()
