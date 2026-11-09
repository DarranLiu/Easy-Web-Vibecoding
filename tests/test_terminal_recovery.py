import asyncio
from contextlib import ExitStack
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from backend import agent_sessions as sessions, config, main, terminal_recovery as recovery, terminal_restart as restart


class StoppedRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.cwd = self.root / "project"
        self.cwd.mkdir()
        self.home = self.root / "account"
        self.home.mkdir()
        self.stack.enter_context(patch.dict(os.environ, {"HOME": str(self.home), "CODEX_HOME": str(self.home / ".codex"),
            "CLAUDE_CONFIG_DIR": str(self.home / ".claude"), "XDG_DATA_HOME": str(self.home / ".local/share")}))
        self.stack.enter_context(patch.object(config, "AGENT_RUNTIME_DIR", self.root / "runtime"))
        self.stack.enter_context(patch.object(restart, "_existing_pane", return_value=None))
        self.occupied = self.stack.enter_context(patch.object(recovery, "_occupied", return_value=set()))
        self.send = self.stack.enter_context(patch.object(restart, "_send"))
        self.start = self.stack.enter_context(patch.object(main.tmux_mgr, "start_session"))
        self.identifier = str(uuid.uuid4())
        self.tab = {"id": "legacy", "type": "claude", "cwd": str(self.cwd)}

    def history(self, agent="claude", identifier=None, cwd=None, **extra):
        identifier = identifier or self.identifier
        if agent == "claude":
            path = self.home / ".claude/projects/project" / (identifier + ".jsonl")
            item = {"sessionId": identifier, "cwd": str(cwd or self.cwd), "slug": "Synthetic history", **extra}
        else:
            path = self.home / ".codex/sessions/2026/10/20" / ("rollout-synthetic-" + identifier + ".jsonl")
            item = {"type": "session_meta", "payload": {"id": identifier, "cwd": str(cwd or self.cwd), "source": "cli", **extra}}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(item) + "\n")
        return path

    def body(self, preview=None):
        preview = preview or recovery.inspect("legacy", self.tab)
        choice = preview["candidates"][0]
        return {"expected": preview["expected"], "sessionId": choice["sessionId"], "candidateKey": choice["candidateKey"], "confirmed": True}

    def tearDown(self):
        self.send.assert_not_called()
        self.start.assert_not_called()

    def test_legacy_history_requires_selection_and_explicit_confirmation(self):
        self.history()
        preview = recovery.inspect("legacy", self.tab)
        self.assertTrue(preview["defaultsUsed"])
        self.assertEqual(len(preview["candidates"]), 1)
        self.assertEqual(sessions.load("legacy"), {})
        body = self.body(preview)
        with self.assertRaises(restart.RestartError):
            recovery.bind("legacy", self.tab, {**body, "confirmed": False})
        result = recovery.bind("legacy", self.tab, body)
        self.assertTrue(result["ready"])
        self.assertTrue(result["stopped"])
        self.assertEqual(result["sessionId"], self.identifier)
        record = sessions.load("legacy")
        self.assertTrue(record["bound"])
        self.assertEqual(record["args"], ["--permission-mode", "default"])
        self.assertEqual(sessions.load("legacy", suffix=".saved.json"), record)

    def test_codex_archived_exact_history_never_reuses_old_provider_or_last(self):
        path = self.history("codex", model_provider="old-provider")
        destination = self.home / ".codex/archived_sessions" / path.name
        destination.parent.mkdir(parents=True)
        path.rename(destination)
        self.tab["type"] = "codex"
        preview = recovery.inspect("legacy", self.tab)
        result = recovery.bind("legacy", self.tab, self.body(preview))
        args = restart.resume_arguments(sessions.load("legacy"))
        self.assertEqual(args[:2], ["resume", result["sessionId"]])
        self.assertNotIn("--last", args)
        self.assertNotIn("old-provider", " ".join(args))
        self.assertIn("workspace-write", args)
        self.assertIn("on-request", args)

    def test_wrong_directory_sidechain_bad_json_and_symlink_are_not_candidates(self):
        self.history(cwd=self.root / "unrelated")
        self.history(identifier=str(uuid.uuid4()), isSidechain=True)
        path = self.history(identifier=str(uuid.uuid4()))
        path.write_bytes(b"not json\n")
        link = self.history(identifier=str(uuid.uuid4()))
        link.unlink()
        link.symlink_to(self.history("codex"))
        self.assertEqual(recovery.inspect("legacy", self.tab)["candidates"], [])

    def test_codex_subagent_and_wrong_identifier_are_not_candidates(self):
        self.tab["type"] = "codex"
        self.history("codex", source={"subagent": "worker"})
        self.assertEqual(recovery.inspect("legacy", self.tab)["candidates"], [])
        path = self.history("codex")
        path.write_text(json.dumps({"type": "session_meta", "payload": {"id": str(uuid.uuid4()), "cwd": str(self.cwd)}}))
        self.assertEqual(recovery.inspect("legacy", self.tab)["candidates"], [])

    def test_codex_local_titles_are_searchable_without_replaying_message_content(self):
        self.tab["type"] = "codex"
        self.history("codex")
        index = self.home / ".codex/session_index.jsonl"
        index.write_text(json.dumps({"id": self.identifier, "thread_name": "Original feature discussion"}) + "\n")
        preview = recovery.inspect("legacy", self.tab, "feature discussion")
        self.assertEqual(preview["candidates"][0]["title"], "Original feature discussion")
        self.assertFalse(sessions.load("legacy"))

    def test_duplicate_record_cannot_bind_even_with_exact_id(self):
        path = self.history()
        duplicate = path.parent.parent / "duplicate" / path.name
        duplicate.parent.mkdir()
        duplicate.write_bytes(path.read_bytes())
        preview = recovery.inspect("legacy", self.tab)
        self.assertTrue(preview["candidates"][0]["duplicate"])
        with self.assertRaises(restart.RestartError):
            recovery.bind("legacy", self.tab, self.body(preview))
        self.assertFalse(sessions.load("legacy"))

    def test_stale_window_or_modified_or_deleted_history_never_binds(self):
        path = self.history()
        body = self.body()
        sessions.save("legacy", {"agent": "claude", "run": "changed"})
        with self.assertRaisesRegex(restart.RestartError, "状态已改变"):
            recovery.bind("legacy", self.tab, body)
        sessions.save("legacy", {})
        body = self.body()
        path.write_text(path.read_text() + "{}\n")
        with self.assertRaisesRegex(restart.RestartError, "记录已改变"):
            recovery.bind("legacy", self.tab, body)
        body = self.body()
        path.unlink()
        with self.assertRaises(restart.RestartError):
            recovery.bind("legacy", self.tab, body)

    def test_live_window_or_background_process_never_rebinds(self):
        self.history()
        with patch.object(restart, "_existing_pane", return_value={"id": "%1"}), self.assertRaises(restart.RestartError):
            recovery.inspect("legacy", self.tab)
        with patch.object(sessions, "same_process", return_value=True), self.assertRaises(restart.RestartError):
            recovery.inspect("legacy", self.tab)

    def test_in_use_candidates_are_visible_but_binding_rechecks_occupancy(self):
        self.history()
        body = self.body()
        self.occupied.return_value = {self.identifier}
        self.assertTrue(recovery.inspect("legacy", self.tab)["candidates"][0]["inUse"])
        with self.assertRaisesRegex(restart.RestartError, "其他窗口"):
            recovery.bind("legacy", self.tab, body)

    def test_history_binding_rechecks_occupancy_at_start_and_serializes_other_tabs(self):
        self.history()
        recovery.bind("legacy", self.tab, self.body())
        record = sessions.load("legacy")
        with sessions.lock(restart._conversation_key(record), "conversation", blocking=False):
            with self.assertRaisesRegex(restart.RestartError, "其他窗口恢复"):
                restart.restart_locked("legacy", self.tab, {})
        self.occupied.return_value = {self.identifier}
        with self.assertRaisesRegex(restart.RestartError, "其他窗口运行"):
            restart.inspect("legacy", self.tab)

    def test_disabled_hooks_and_bad_utf8_fail_without_overwriting_metadata(self):
        path = self.history()
        path.write_bytes(b"\xff\xfe\n")
        self.assertEqual(recovery.inspect("legacy", self.tab)["candidates"], [])
        self.history()
        original = {"agent": "claude", "args": ["--bare"], "run": "old"}
        sessions.save("legacy", original)
        with self.assertRaisesRegex(restart.RestartError, "会话钩子"):
            recovery.bind("legacy", self.tab, self.body())
        self.assertEqual(sessions.load("legacy"), original)

    def test_original_arguments_and_account_survive_binding(self):
        self.history()
        sessions.save("legacy", {"agent": "claude", "home": str(self.home / ".claude"), "cwd": str(self.cwd),
            "args": ["--model", "demo-model", "--permission-mode", "plan"], "run": "old"})
        with patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.root / "other-account")}):
            preview = recovery.inspect("legacy", self.tab)
            recovery.bind("legacy", self.tab, self.body(preview))
        self.assertEqual(sessions.load("legacy")["home"], str(self.home / ".claude"))
        self.assertIn("plan", restart.resume_arguments(sessions.load("legacy")))
        self.assertIn("demo-model", restart.resume_arguments(sessions.load("legacy")))

    def test_pagination_search_and_invalid_query(self):
        for _ in range(4):
            self.history(identifier=str(uuid.uuid4()))
        with patch.object(recovery, "PAGE_SIZE", 2):
            first = recovery.inspect("legacy", self.tab)
            second = recovery.inspect("legacy", self.tab, offset=2)
            self.assertTrue(first["hasMore"])
            self.assertFalse(second["hasMore"])
            self.assertFalse(set(item["sessionId"] for item in first["candidates"]) & set(item["sessionId"] for item in second["candidates"]))
        sid = first["candidates"][0]["sessionId"]
        self.assertEqual(len(recovery.inspect("legacy", self.tab, sid)["candidates"]), 1)
        for query, offset in (("x" * 161, 0), ("", -1), ("", True)):
            with self.assertRaises(restart.RestartError):
                recovery.inspect("legacy", self.tab, query, offset)

    def test_opencode_readonly_database_matches_exact_directory_and_root_session(self):
        self.tab["type"] = "opencode"
        path = self.home / ".local/share/opencode/opencode.db"
        path.parent.mkdir(parents=True)
        with sqlite3.connect(path) as db:
            db.execute("CREATE TABLE session(id,title,directory,parent_id,time_updated)")
            db.executemany("INSERT INTO session VALUES(?,?,?,?,?)", [
                ("ses_original123456", "Synthetic conversation", str(self.cwd), None, 1800000000000),
                ("ses_unrelated12345", "Other", str(self.root), None, 1800000000000),
                ("ses_subagent12345", "Child", str(self.cwd), "ses_original123456", 1800000000000)])
        preview = recovery.inspect("legacy", self.tab)
        self.assertEqual([row["sessionId"] for row in preview["candidates"]], ["ses_original123456"])
        self.assertEqual(recovery.bind("legacy", self.tab, self.body(preview))["sessionId"], "ses_original123456")

    def test_api_rejects_missing_tabs_invalid_body_and_operation_conflicts(self):
        with patch.object(main.store, "get_tab", return_value=None), self.assertRaises(HTTPException) as error:
            main.inspect_recovery("missing", _=None)
        self.assertEqual(error.exception.status_code, 404)
        with self.assertRaises(HTTPException) as error:
            asyncio.run(main.bind_recovery("legacy", Mock(json=AsyncMock(return_value=[])), None))
        self.assertEqual(error.exception.status_code, 400)
        with sessions.lock("legacy", "operation", blocking=False), self.assertRaises(HTTPException) as error:
            asyncio.run(main.bind_recovery("legacy", Mock(json=AsyncMock(return_value={})), None))
        self.assertEqual(error.exception.status_code, 409)
