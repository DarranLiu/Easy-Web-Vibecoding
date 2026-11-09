import json
import asyncio
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from backend import completion_notifications as notices, workspaces


class CompletionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for mocked in (patch.object(workspaces, "DB", self.root / "private/state.sqlite3"),
                       patch.object(notices.store, "list_tabs", return_value=[{"id": "one"}, {"id": "two"}])):
            mocked.start()
            self.addCleanup(mocked.stop)

    def record(self, sid="one", key="done", stamp=None):
        with workspaces.connection() as db:
            notices._record(db, sid, key, stamp if stamp is not None else time.time())

    def test_first_visit_baselines_old_events_and_token_reads_are_independent(self):
        self.record(stamp=1)
        self.assertEqual(notices.unread("a"), {"unread": []})
        self.assertEqual(notices.unread("b"), {"unread": []})
        self.record()
        event = notices.unread("a")["unread"][0]
        notices.acknowledge("a", [event["id"]])
        self.assertEqual(notices.unread("a")["unread"], [])
        self.assertEqual(notices.unread("b")["unread"], [event])
        with workspaces.connection() as db:
            self.assertNotIn("a", [row[0] for row in db.execute("SELECT principal FROM completion_readers")])

    def test_old_ack_cannot_clear_new_reply_and_repeated_events_stay_read(self):
        notices.unread("a")
        self.record()
        old = notices.unread("a")["unread"][0]
        stamp = time.time()
        self.record(key="new", stamp=stamp)
        notices.acknowledge("a", [old["id"]])
        current = notices.unread("a")["unread"][0]
        self.assertNotEqual(old["id"], current["id"])
        notices.acknowledge("a", [current["id"]])
        self.record(key="new", stamp=stamp)
        self.record(key="older", stamp=stamp - 10)
        self.assertEqual(notices.unread("a")["unread"], [])

    def test_layout_revision_is_not_modified_and_unknown_sessions_are_hidden(self):
        before = workspaces.device_layout("desktop", {"revision": 0, "panes": ["one"], "active": "one"}, {"one"})
        notices.unread("a")
        self.record(); self.record(sid="deleted")
        values = notices.unread("a")["unread"]
        self.assertEqual(len(values), 1)
        notices.acknowledge("a", [values[0]["id"]])
        self.assertEqual(workspaces.device_layout("desktop"), before)

    def test_codex_reads_all_new_events_even_after_next_turn_and_partial_lines(self):
        notices.unread("a")
        transcript = self.root / "turns.jsonl"
        record = {"agent": "codex", "run": "run", "launched_at": 1, "transcript": str(transcript)}
        stamp = time.time()
        from datetime import datetime, timezone
        row = json.dumps({"timestamp": datetime.fromtimestamp(stamp, timezone.utc).isoformat(),
                          "type": "event_msg", "payload": {"type": "task_complete"}}).encode()
        transcript.write_bytes(row[:30])
        with patch.object(notices.agent_sessions, "transcript_exists", return_value=True), patch.object(notices.agent_sessions, "load", return_value=record):
            notices.collect()
            self.assertEqual(notices.unread("a")["unread"], [])
            with transcript.open("ab") as stream:
                stream.write(row[30:] + b'\n{"type":"event_msg","payload":{"type":"task_started"}}\n')
            notices.collect()
            value = notices.unread("a")["unread"]
            self.assertEqual(len(value), 2)
            notices.acknowledge("a", [item["id"] for item in value])
            notices.collect()
            self.assertEqual(notices.unread("a")["unread"], [])
            transcript.write_bytes(row + b"\n")
            notices.collect()
            self.assertEqual(notices.unread("a")["unread"], [])

    def test_claude_completion_survives_next_prompt_and_process_exit(self):
        notices.unread("a")
        record = {"agent": "claude", "run": "r", "activity": {"event": "UserPromptSubmit"},
                  "last_completion": {"event": "Stop", "run": "r", "at": time.time()}}
        with patch.object(notices.agent_sessions, "load", return_value=record):
            notices.collect()
        self.assertEqual(len(notices.unread("a")["unread"]), 2)
        record["run"] = "different"
        notices.acknowledge("a", [value["id"] for value in notices.unread("a")["unread"]])
        with patch.object(notices.agent_sessions, "load", return_value=record):
            notices.collect()
        self.assertEqual(notices.unread("a")["unread"], [])

    def test_ack_validation(self):
        for ids in (None, "all", ["bad/path"], ["x"] * 101):
            with self.assertRaises(workspaces.WorkspaceError):
                notices.acknowledge("a", ids)

    def test_routes_require_auth_and_never_operate_native_terminals(self):
        from backend import main

        async def request(path, method="GET", auth=False, body=None):
            headers = [(b"authorization", b"Bearer completion-test")] if auth else []
            scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
                     "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"",
                     "headers": headers, "server": ("test", 80), "client": ("127.0.0.1", 1234)}
            messages = []
            async def receive():
                return {"type": "http.request", "body": json.dumps(body or {}).encode(), "more_body": False}
            async def send(message):
                messages.append(message)
            await main.app(scope, receive, send)
            return next(message["status"] for message in messages if message["type"] == "http.response.start")

        async def run():
            with patch.object(main.config, "AUTH_ENABLED", True), patch.object(main.config, "TOKEN", "completion-test"), patch.object(main.tmux_mgr, "_tmux") as native:
                self.assertEqual(await request("/api/completions"), 401)
                self.assertEqual(await request("/api/completions/ack", "POST"), 401)
                self.assertEqual(await request("/api/completions", auth=True), 200)
                self.assertEqual(await request("/api/completions/ack", "POST", True, {"ids": []}), 200)
                self.assertEqual(await request("/api/completions/ack", "POST", True, {"ids": [None]}), 400)
                native.assert_not_called()
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
