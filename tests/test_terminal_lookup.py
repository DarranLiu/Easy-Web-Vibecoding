from contextlib import ExitStack
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from unittest.mock import Mock, patch

from fastapi import HTTPException
from backend import agent_sessions as sessions, config, main, store, tmux_mgr
from backend import terminal_lookup as lookup, terminal_recovery as recovery, terminal_restart as restart


class TerminalLookupTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.home = self.root / "home"
        self.cwd = self.root / "project"
        self.home.mkdir(); self.cwd.mkdir()
        self.stack.enter_context(patch.dict(os.environ, {"HOME": str(self.home), "CODEX_HOME": str(self.home / ".codex"),
            "CLAUDE_CONFIG_DIR": str(self.home / ".claude"), "XDG_DATA_HOME": str(self.home / ".local/share")}))
        self.stack.enter_context(patch.object(config, "AGENT_RUNTIME_DIR", self.root / "runtime"))
        self.stack.enter_context(patch.object(config, "ROOTS", [str(self.cwd)]))
        self.tabs, self.live = [], []
        self.stack.enter_context(patch.object(store, "list_tabs", side_effect=lambda: list(self.tabs)))
        self.stack.enter_context(patch.object(store, "get_tab", side_effect=lambda sid: next((t for t in self.tabs if t["id"] == sid), None)))
        self.stack.enter_context(patch.object(store, "add_tab", side_effect=self.tabs.append))
        self.stack.enter_context(patch.object(tmux_mgr, "list_sessions", side_effect=lambda: list(self.live)))
        self.stack.enter_context(patch.object(tmux_mgr, "session_exists", return_value=False))
        self.stack.enter_context(patch.object(restart, "_existing_pane", return_value=None))
        self.occupied = self.stack.enter_context(patch.object(recovery, "_occupied", return_value=set()))
        self.resume = self.stack.enter_context(patch.object(restart, "_restart_locked", side_effect=lambda sid, tab, body: {**tab, "alive": True}))
        self.send = self.stack.enter_context(patch.object(restart, "_send"))
        self.start = self.stack.enter_context(patch.object(tmux_mgr, "start_session"))
        self.shell = Mock(return_value={"alive": True})
        self.native = str(uuid.uuid4())

    def tearDown(self):
        self.send.assert_not_called()
        self.start.assert_not_called()

    def history(self, agent="codex", native=None, cwd=None, **extra):
        native = native or self.native
        if agent == "codex":
            path = self.home / ".codex/sessions/2026/10/28" / ("rollout-test-" + native + ".jsonl")
            value = {"type": "session_meta", "payload": {"id": native, "cwd": str(cwd or self.cwd), "source": "cli", **extra}}
        else:
            path = self.home / ".claude/projects/project" / (native + ".jsonl")
            value = {"sessionId": native, "cwd": str(cwd or self.cwd), "slug": "Synthetic session", **extra}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) + "\n")
        return path

    def preview(self, query=None):
        return lookup.inspect(query or self.native, main.safe_resolve)

    def body(self, query=None, index=0):
        preview = self.preview(query)
        choice = preview["matches"][index]
        return {"query": preview["query"], "key": choice["key"], "expected": choice["expected"],
                "confirmed": True, "requestId": str(uuid.uuid4())}

    def open(self, body):
        return lookup.open_session(body, main.safe_resolve, self.shell)

    def known(self, agent="codex", live=False):
        path = self.history(agent)
        record = {"agent": agent, "home": str(self.home / ("." + agent)), "cwd": str(self.cwd),
                  "session_id": self.native, "transcript": str(path), "pid": 0, "start": "", "run": "run1",
                  "bound": True, "args": [], "environment": {}}
        sessions.remember("abc123", record)
        tab = {"id": "abc123", "cwd": str(self.cwd), "type": agent, "name": "Synthetic title"}
        self.tabs.append(tab)
        if live:
            self.live.append({**tab, "name": "cc_abc123"})
        return record

    def test_invalid_ids_rejected_and_partial_id_does_not_guess(self):
        for value in (None, "", "../abc", "abc;whoami", "x" * 65, "codex resume abc", "a\nb"):
            with self.subTest(value=value), self.assertRaises(restart.RestartError):
                lookup.inspect(value, main.safe_resolve)
        self.history()
        self.assertEqual(self.preview(self.native[:8])["matches"], [])

    def test_exact_codex_import_is_read_only_until_confirmation(self):
        self.history(model_provider="old-private-provider")
        preview = self.preview(" " + self.native.upper() + " ")
        self.assertEqual(preview["query"], self.native)
        self.assertEqual(preview["matches"][0]["action"], "import")
        self.assertEqual(self.tabs, [])
        self.resume.assert_not_called()
        self.assertNotIn("transcript", json.dumps(preview))
        self.assertNotIn("old-private-provider", json.dumps(preview))
        body = self.body()
        for changes in ({"confirmed": False}, {"requestId": "bad"}, {"expected": "stale"}, {"key": "other"}):
            with self.assertRaises(restart.RestartError):
                self.open({**body, **changes})
        result = self.open(body)
        record = sessions.load(result["id"])
        self.assertEqual(record["session_id"], self.native)
        self.assertIn("workspace-write", record["args"])
        self.assertNotIn("old-private-provider", " ".join(restart.resume_arguments(record)))
        self.assertNotIn("--last", restart.resume_arguments(record))
        self.assertFalse(self.resume.call_args.args[2]["confirmed"])
        self.assertEqual(len(self.tabs), 1)

    def test_claude_import_uses_exact_id_and_normal_permissions(self):
        self.history("claude")
        result = self.open(self.body())
        record = sessions.load(result["id"])
        self.assertEqual(record["args"], ["--permission-mode", "default"])
        self.assertIn(self.native, restart.resume_arguments(record))

    def pending(self, sid="abc123", request_id=None):
        saved = sessions.load(sid, suffix=".saved.json")
        current = {**saved, "run": "pending-run", "pid": 123, "start": "456", "managed": True,
                   "session_id": None, "transcript": None, "bound": False, "hook_seen": False,
                   "args": restart.resume_arguments(saved), "launched_at": 11}
        sessions.save(sid, current)
        sessions.save(sid, {"requestId": request_id or str(uuid.uuid4()), "started": 10,
            "sessionId": self.native, "error": "awaiting confirmation"}, suffix=".operation.json")
        if not any(t["id"] == sid for t in self.live):
            self.live.append(next(t for t in self.tabs if t["id"] == sid))
        self.stack.enter_context(patch.object(sessions, "same_process", return_value=True))
        self.stack.enter_context(patch.object(restart, "_existing_pane", return_value={"id": "%fake"}))
        self.stack.enter_context(patch.object(restart, "_foreground", return_value={"pid": 123, "start": "456", "comm": "claude"}))
        return current

    def test_pending_claude_can_be_found_and_attached_without_restarting(self):
        self.known("claude"); current = self.pending()
        for query in (self.native, "abc123", "cc_abc123"):
            match = self.preview(query)["matches"][0]
            self.assertEqual(match["action"], "attach")
            self.assertTrue(match["resumePending"])
            self.assertEqual(match["nativeId"], self.native)
            result = self.open(self.body(query))
            self.assertTrue(result["alive"])
            self.assertTrue(result["resumePending"])
            self.assertFalse(result["resumed"])
        self.assertEqual(sessions.load("abc123"), current)
        self.resume.assert_not_called()

    def test_import_that_waits_for_claude_confirmation_returns_visible_pending_window(self):
        self.history("claude")
        def waiting(sid, tab, body):
            self.pending(sid, body["requestId"])
            raise restart.RestartError("confirmation pending")
        self.resume.side_effect = waiting
        result = self.open(self.body())
        self.assertTrue(result["resumePending"])
        self.assertFalse(result["resumed"])
        self.assertEqual(self.preview()["matches"][0]["id"], result["id"])
        self.assertEqual(self.open(self.body())["id"], result["id"])
        self.assertEqual(self.resume.call_count, 1)
        self.assertEqual(len(self.tabs), 1)

    def test_pending_launch_must_belong_to_this_operation(self):
        self.history("claude")
        def waiting(sid, tab, body):
            self.pending(sid, str(uuid.uuid4()))
            raise restart.RestartError("unrelated operation")
        self.resume.side_effect = waiting
        with self.assertRaisesRegex(restart.RestartError, "unrelated operation"):
            self.open(self.body())

    def test_pending_claude_rejects_unproven_or_changed_launches(self):
        saved = self.known("claude"); current = self.pending()
        invalid = [{"managed": False}, {"session_id": str(uuid.uuid4())}, {"hook_seen": True},
                   {"ambiguous": True}, {"launch_failed": True}, {"run": saved["run"]},
                   {"home": str(self.root)}, {"cwd": str(self.home)}, {"agent": "codex"},
                   {"launched_at": 9}, {"args": ["--continue"]},
                   {"args": ["--resume", str(uuid.uuid4())]}, {"args": ["--resume", self.native, "--fork-session"]}]
        for change in invalid:
            with self.subTest(change=change):
                self.assertIsNone(lookup._pending_claude("abc123", {**current, **change}))

    def test_pending_claude_requires_same_live_foreground_and_saved_transcript(self):
        self.known("claude"); current = self.pending()
        with patch.object(sessions, "same_process", return_value=False):
            self.assertIsNone(lookup._pending_claude("abc123", current))
        with patch.object(restart, "_existing_pane", return_value=None):
            self.assertIsNone(lookup._pending_claude("abc123", current))
        for fg in (None, {"pid": 124, "start": "456", "comm": "claude"},
                   {"pid": 123, "start": "reused", "comm": "claude"},
                   {"pid": 123, "start": "456", "comm": "codex"}):
            with patch.object(restart, "_foreground", return_value=fg):
                self.assertIsNone(lookup._pending_claude("abc123", current))
        Path(sessions.load("abc123", suffix=".saved.json")["transcript"]).unlink()
        self.assertIsNone(lookup._pending_claude("abc123", current))

    def test_pending_claude_does_not_trust_stale_or_completed_operation(self):
        self.known("claude"); current = self.pending()
        operation = sessions.load("abc123", suffix=".operation.json")
        for change in ({"requestId": "bad"}, {"sessionId": str(uuid.uuid4())},
                       {"result": {"resumed": True}}, {"started": 0}):
            sessions.save("abc123", {**operation, **change}, suffix=".operation.json")
            self.assertIsNone(lookup._pending_claude("abc123", current))

    def test_pending_lookup_does_not_expose_outside_root_directory(self):
        self.known("claude"); self.pending()
        self.tabs[0]["cwd"] = str(self.home)
        self.assertEqual(self.preview("abc123")["matches"], [])
        self.assertTrue(all(m["cwd"] == str(self.cwd) and m["id"] is None for m in self.preview()["matches"]))

    def test_pending_becomes_normal_only_after_verified_session_binding(self):
        saved = self.known("claude"); current = self.pending()
        body = self.body()
        sessions.remember("abc123", {**current, "session_id": self.native,
            "transcript": saved["transcript"], "hook_seen": True})
        with patch.object(restart, "inspect", return_value={"ready": True, "running": True, "sessionId": self.native, "expected": "hook"}):
            with self.assertRaises(restart.RestartError): self.open(body)
            match = self.preview()["matches"][0]
            self.assertFalse(match["resumePending"])
            self.assertEqual(match["action"], "attach")
        self.resume.assert_not_called()

    def test_opencode_database_import_is_exact_and_uses_isolated_port(self):
        self.native = "ses_123456789abcdef"
        home = self.home / ".local/share/opencode"
        home.mkdir(parents=True)
        with sqlite3.connect(home / "opencode.db") as db:
            db.execute("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER, parent_id TEXT)")
            db.execute("INSERT INTO session VALUES (?,?,?,?,NULL)", (self.native, "Synthetic OpenCode", str(self.cwd), 1000))
        result = self.open(self.body())
        record = sessions.load(result["id"])
        args = restart.resume_arguments(record)
        self.assertEqual(args[args.index("--session") + 1], self.native)
        self.assertEqual(args[args.index("--port") + 1], "0")
        self.assertEqual(args[args.index("--hostname") + 1], "127.0.0.1")

    def test_opencode_child_session_is_not_imported(self):
        self.native = "ses_123456789abcdef"
        home = self.home / ".local/share/opencode"
        home.mkdir(parents=True)
        with sqlite3.connect(home / "opencode.db") as db:
            db.execute("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER, parent_id TEXT)")
            db.execute("INSERT INTO session VALUES (?,?,?,?,?)", (self.native, "Child", str(self.cwd), 1000, "parent"))
        self.assertEqual(self.preview()["matches"], [])

    def test_unknown_id_does_not_scan_transcripts_or_network(self):
        with patch.object(lookup, "_history") as scan:
            self.assertEqual(self.preview("unknown-window")["matches"], [])
        scan.assert_not_called()

    def test_long_opencode_id_remains_valid_without_expanding_web_id_limit(self):
        value = "ses_" + "a" * 64
        self.assertEqual(lookup.identifier(value), value)
        with self.assertRaises(restart.RestartError): lookup.identifier(value + "a")
        with self.assertRaises(restart.RestartError): lookup.identifier("a" * 65)

    def test_lookup_results_are_not_cacheable(self):
        result = main.lookup_session("unknown")
        self.assertEqual(result.headers["cache-control"], "private, no-store")

    def test_concurrent_same_id_operation_is_rejected_before_start(self):
        self.history(); body = self.body()
        with patch.object(sessions, "lock", side_effect=BlockingIOError()), self.assertRaises(restart.RestartError):
            self.open(body)
        self.resume.assert_not_called()

    def test_known_live_short_or_prefixed_id_only_attaches(self):
        self.known(live=True)
        for query in ("abc123", "cc_abc123"):
            result = self.open(self.body(query))
            self.assertTrue(result["alive"])
            self.assertEqual(result["name"], "Synthetic title")
        self.resume.assert_not_called(); self.shell.assert_not_called()

    def test_native_id_of_live_window_validates_actual_foreground_identity(self):
        self.known(live=True)
        with patch.object(restart, "inspect", return_value={"ready": True, "running": True, "sessionId": self.native, "expected": "live"}):
            self.assertEqual(self.preview()["matches"][0]["action"], "attach")
            self.assertTrue(self.open(self.body())["alive"])
        with patch.object(restart, "inspect", return_value={"ready": True, "running": True, "sessionId": str(uuid.uuid4()), "expected": "other"}):
            self.assertEqual(self.preview()["matches"][0]["action"], "blocked")
        self.resume.assert_not_called()

    def test_stopped_known_window_reuses_binding_instead_of_import(self):
        self.known()
        self.assertEqual(self.preview()["matches"][0]["action"], "resume")
        self.assertEqual(self.open(self.body())["id"], "abc123")
        self.assertEqual(len(self.tabs), 1)

    def test_saved_identity_survives_failed_launch_record(self):
        self.known()
        sessions.save("abc123", {"agent": "codex", "launch_failed": True})
        self.assertEqual(self.preview()["matches"][0]["action"], "resume")
        self.assertEqual(self.open(self.body())["id"], "abc123")

    def test_known_window_outside_roots_is_not_exposed(self):
        self.known(live=True)
        self.tabs[0]["cwd"] = str(self.home)
        self.assertEqual(self.preview("cc_abc123")["matches"], [])

    def test_refreshed_identity_outside_roots_is_not_exposed(self):
        record = self.known()
        def changed(*args):
            sessions.save("abc123", {**record, "cwd": str(self.home)})
            return {"ready": True, "running": False, "sessionId": self.native, "expected": "changed"}
        with patch.object(restart, "inspect", side_effect=changed):
            self.assertEqual(self.preview("abc123")["matches"], [])

    def test_known_stopped_window_occupied_elsewhere_is_blocked(self):
        self.known()
        self.occupied.return_value = {self.native}
        self.assertEqual(self.preview()["matches"][0]["action"], "blocked")
        with self.assertRaises(restart.RestartError): self.open(self.body())
        self.resume.assert_not_called()

    def test_import_rechecks_external_occupancy_before_launch(self):
        self.history(); body = self.body()
        self.occupied.side_effect = [set(), set(), {self.native}]
        with self.assertRaises(restart.RestartError): self.open(body)
        self.resume.assert_not_called()

    def test_duplicate_files_or_other_running_terminal_block_import(self):
        path = self.history()
        self.occupied.return_value = {self.native}
        self.assertEqual(self.preview()["matches"][0]["action"], "blocked")
        with self.assertRaises(restart.RestartError): self.open(self.body())
        self.occupied.return_value = set()
        duplicate = self.home / ".codex/archived_sessions" / path.name
        duplicate.parent.mkdir(); duplicate.write_bytes(path.read_bytes())
        self.assertEqual(self.preview()["matches"][0]["action"], "blocked")
        self.resume.assert_not_called()

    def test_history_changed_or_new_occupancy_requires_new_confirmation(self):
        path = self.history()
        body = self.body(); path.write_text(path.read_text() + "{}\n")
        with self.assertRaises(restart.RestartError): self.open(body)
        body = self.body(); self.occupied.return_value = {self.native}
        with self.assertRaises(restart.RestartError): self.open(body)
        self.assertEqual(self.tabs, [])

    def test_roots_symlinks_wrong_ids_and_subagents_not_exposed(self):
        path = self.history(cwd=self.home)
        self.assertEqual(self.preview()["matches"], [])
        self.history(source={"subagent": "worker"})
        self.assertEqual(self.preview()["matches"], [])
        other = self.history(native=str(uuid.uuid4()))
        path.unlink(); path.symlink_to(other)
        self.assertEqual(self.preview()["matches"], [])

    def test_claude_sidechain_and_wrong_cwd_excluded(self):
        self.history("claude", isSidechain=True)
        self.assertEqual(self.preview()["matches"], [])
        self.history("claude", cwd=self.home)
        self.assertEqual(self.preview()["matches"], [])

    def test_same_uuid_across_agents_requires_explicit_choice(self):
        self.history(); self.history("claude")
        matches = self.preview()["matches"]
        self.assertEqual({m["agent"] for m in matches}, {"codex", "claude"})
        result = self.open(self.body(index=1))
        self.assertEqual(result["type"], "claude")

    def test_foreground_becomes_running_or_binding_changes_after_lookup_never_interrupts(self):
        self.known()
        body = self.body()
        original = restart._inspect
        for change in ({"running": True}, {"sessionId": str(uuid.uuid4())}, {"expected": "changed-config"}):
            calls = [0]
            def changing(sid, tab):
                calls[0] += 1
                value = original(sid, tab)
                return value if calls[0] == 1 else {**value, **change}
            with patch.object(restart, "_inspect", side_effect=changing), self.assertRaises(restart.RestartError):
                self.open(body)
        self.resume.assert_not_called()

    def test_repeated_import_request_cannot_create_another_window(self):
        self.history(); body = self.body(); self.open(body)
        with self.assertRaises(restart.RestartError): self.open(body)
        self.assertEqual(len(self.tabs), 1)
        self.assertEqual(self.resume.call_count, 1)

    def test_shell_id_can_wake_without_agent_resume(self):
        self.tabs.append({"id": "shell1", "cwd": str(self.cwd), "type": "shell"})
        self.open(self.body("shell1"))
        self.shell.assert_called_once_with("shell1")
        self.resume.assert_not_called()

    def test_missing_or_unknown_program_type_never_uses_default_launcher(self):
        for fields in ({}, {"type": None}, {"type": "unknown"}):
            self.tabs[:] = [{"id": "legacy", "cwd": str(self.cwd), **fields}]
            self.assertEqual(self.preview("legacy")["matches"][0]["action"], "blocked")
            with self.assertRaises(restart.RestartError): self.open(self.body("legacy"))
        self.shell.assert_not_called(); self.resume.assert_not_called()

    def test_open_requires_valid_request_before_lookup(self):
        with patch.object(lookup, "_lookup") as find, self.assertRaises(restart.RestartError):
            self.open({"query": self.native, "confirmed": True, "requestId": ""})
        find.assert_not_called()

    def test_routes_require_auth_and_safe_errors(self):
        for path in ("/api/session-lookup", "/api/session-lookup/open"):
            route = next(r for r in main.app.routes if r.path == path)
            self.assertIn(main.require_auth, [d.call for d in route.dependant.dependencies])
        with patch.object(lookup, "inspect", side_effect=OSError("private path")), self.assertRaises(HTTPException) as caught:
            main.lookup_session(self.native)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertNotIn("private path", caught.exception.detail)

    def test_copy_native_id_of_stopped_codex_and_claude_without_starting(self):
        for agent in ("codex", "claude"):
            self.tabs.clear()
            self.known(agent)
            result = lookup.copy_identity("abc123", self.tabs[0], main.safe_resolve)
            self.assertEqual(result, {"id": "abc123", "value": self.native, "kind": "native", "agent": agent, "state": "stopped"})
        self.resume.assert_not_called()

    def test_copy_identity_of_pending_claude_does_not_claim_loaded_session(self):
        self.known("claude"); current = self.pending()
        result = lookup.copy_identity("abc123", self.tabs[0], main.safe_resolve)
        self.assertEqual(result["state"], "pending")
        self.assertEqual(result["value"], self.native)
        self.assertEqual(sessions.load("abc123"), current)
        self.resume.assert_not_called()

    def test_copy_plain_shell_returns_explicit_web_id_not_path(self):
        result = lookup.copy_identity("shell1", {"id": "shell1", "cwd": str(self.cwd), "type": "shell"}, main.safe_resolve)
        self.assertEqual(result["kind"], "window")
        self.assertEqual(result["value"], "cc_shell1")
        self.assertNotIn(str(self.cwd), json.dumps(result))

    def test_copy_live_native_uses_verified_identity_not_tab_type(self):
        self.known("codex"); self.tabs[0]["type"] = "shell"
        with patch.object(restart, "_inspect", return_value={"ready": True, "running": True, "sessionId": self.native, "agent": "codex"}):
            result = lookup.copy_identity("abc123", self.tabs[0], main.safe_resolve)
        self.assertEqual(result["kind"], "native")
        self.assertEqual(result["state"], "running")
        self.assertEqual(result["value"], self.native)

    def test_copy_opencode_id_preserves_native_format(self):
        record = self.known()
        sessions.save("abc123", {**record, "agent": "opencode", "session_id": "ses_123456789abcdef"})
        with patch.object(restart, "_inspect", return_value={"ready": True, "running": True, "sessionId": "ses_123456789abcdef", "agent": "opencode"}):
            result = lookup.copy_identity("abc123", self.tabs[0], main.safe_resolve)
        self.assertEqual(result["value"], "ses_123456789abcdef")

    def test_copy_unbound_or_changed_native_identity_never_falls_back_to_path_or_window(self):
        self.known()
        for preview in ({"ready": False, "reason": "missing ID"},
                        {"ready": True, "agent": "codex", "sessionId": str(uuid.uuid4())}):
            with patch.object(restart, "_inspect", return_value=preview), self.assertRaises(restart.RestartError):
                lookup.copy_identity("abc123", self.tabs[0], main.safe_resolve)
        self.resume.assert_not_called()

    def test_copy_identity_checks_both_tab_and_native_directory_roots(self):
        record = self.known()
        with self.assertRaises(restart.RestartError):
            lookup.copy_identity("abc123", {**self.tabs[0], "cwd": str(self.home)}, main.safe_resolve)
        sessions.save("abc123", {**record, "cwd": str(self.home)})
        with patch.object(restart, "_inspect", return_value={"ready": True, "agent": "codex", "sessionId": self.native}), self.assertRaises(restart.RestartError):
            lookup.copy_identity("abc123", self.tabs[0], main.safe_resolve)

    def test_copy_identity_rejects_concurrent_management_without_input(self):
        self.known()
        with patch.object(sessions, "lock", side_effect=BlockingIOError()), self.assertRaises(restart.RestartError):
            lookup.copy_identity("abc123", self.tabs[0], main.safe_resolve)

    def test_copy_identity_route_auth_no_cache_and_sanitized_failures(self):
        route = next(r for r in main.app.routes if r.path == "/api/sessions/{sid}/identity")
        self.assertIn(main.require_auth, [d.call for d in route.dependant.dependencies])
        with self.assertRaises(HTTPException) as missing: main.session_identity("missing")
        self.assertEqual(missing.exception.status_code, 404)
        self.known()
        response = main.session_identity("abc123")
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.assertEqual(json.loads(response.body)["value"], self.native)
        with patch.object(lookup, "copy_identity", side_effect=OSError("private path")), self.assertRaises(HTTPException) as caught:
            main.session_identity("abc123")
        self.assertEqual(caught.exception.status_code, 503)
        self.assertNotIn("private path", caught.exception.detail)


if __name__ == "__main__":
    unittest.main()
