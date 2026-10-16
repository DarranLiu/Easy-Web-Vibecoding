import asyncio
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from backend import agent_activity, main, workspaces, workspace_tools


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dbpatch = patch.object(workspaces, "DB", self.root / "private/state.sqlite3")
        self.dbpatch.start()
        self.addCleanup(self.dbpatch.stop)
        self.known = {"one", "two"}
        self.space = workspaces.create("Project", str(self.root), ["one", "two"])

    def test_seed_import_is_once_even_after_all_workspaces_deleted(self):
        with patch.object(workspaces, "DB", self.root / "empty/state.sqlite3"):
            self.assertEqual(workspaces.listing([]), [])
            first = workspaces.listing([{"id": "old", "cwd": str(self.root / "old")}])
            self.assertEqual(len(first), 1)
            for row in first:
                workspaces.delete(row["id"], row["revision"])
            self.assertEqual(workspaces.listing([{"id": "old", "cwd": str(self.root / "old")}]), [])
        self.assertEqual(len(workspaces.listing([{"id": "old", "cwd": "other"}])), 1)

    def test_membership_conflict_and_unknown_session(self):
        updated = workspaces.update(self.space["id"], {"name": "Renamed", "revision": 1}, self.known)
        self.assertEqual(updated["revision"], 2)
        for body in ({"name": "Stale", "revision": 1}, {"members": ["deleted"], "revision": 2}):
            with self.assertRaises(workspaces.WorkspaceError) as caught:
                workspaces.update(self.space["id"], body, self.known)
            self.assertEqual(caught.exception.status, 409)

    def test_layout_roundtrip_is_per_device_and_revisioned(self):
        body = {"panes": ["one", None, "two"], "active": "two", "direction": "row", "ratios": {"cols": [1, 2]}, "revision": 0}
        saved = workspaces.layout(self.space["id"], "desktop_demo", body)
        self.assertEqual(saved["revision"], 1)
        self.assertEqual(workspaces.layout(self.space["id"], "desktop_demo"), saved)
        self.assertEqual(workspaces.layout(self.space["id"], "mobile_demo")["panes"], [])
        with self.assertRaises(workspaces.WorkspaceError) as caught:
            workspaces.layout(self.space["id"], "desktop_demo", body)
        self.assertEqual(caught.exception.status, 409)

    def test_layout_rejects_cross_workspace_duplicates_and_invalid_numbers(self):
        for body in ({"panes": ["other"]}, {"panes": ["one", "one"]}, {"panes": ["one"], "active": "two"},
                     {"panes": [], "ratios": {"rows": [float("nan")]}}, {"panes": ["one"] * 5}):
            with self.assertRaises(workspaces.WorkspaceError):
                workspaces.layout(self.space["id"], "device", {"revision": 0, **body})

    def test_removing_member_invalidates_saved_layout_but_adding_does_not(self):
        workspaces.layout(self.space["id"], "device", {"panes": ["two"], "active": "two", "revision": 0})
        workspaces.update(self.space["id"], {"members": ["one"], "revision": 1}, self.known)
        view = workspaces.layout(self.space["id"], "device")
        self.assertEqual(view["panes"], [None])
        self.assertIsNone(view["active"])
        self.assertEqual(view["revision"], 2)
        workspaces.update(self.space["id"], {"members": ["one", "two"], "revision": 2}, self.known)
        self.assertEqual(workspaces.layout(self.space["id"], "device")["revision"], 2)

    def test_device_layout_survives_workspace_membership_changes_and_deletion(self):
        other = workspaces.create("Other", str(self.root), ["three"])
        value = {"revision": 0, "panes": ["one", "three", "two"], "active": "three", "direction": "row", "ratios": {"cols": [1, 2]}}
        saved = workspaces.device_layout("desktop_demo", value, {"one", "two", "three"})
        workspaces.update(self.space["id"], {"revision": 1, "members": []}, self.known)
        workspaces.delete(self.space["id"], 2)
        workspaces.delete(other["id"], 1)
        self.assertEqual(workspaces.device_layout("desktop_demo"), saved)
        self.assertEqual(workspaces.device_layout("mobile_demo")["revision"], 0)
        self.assertEqual(workspaces.device_layout("mobile_demo")["panes"], [])

    def test_device_layout_cas_and_validation_do_not_require_workspace_membership(self):
        valid = {"revision": 0, "panes": ["unassigned"], "active": "unassigned"}
        saved = workspaces.device_layout("desktop_demo", valid, {"unassigned"})
        self.assertEqual(saved["panes"], ["unassigned"])
        with self.assertRaises(workspaces.WorkspaceError) as caught:
            workspaces.device_layout("desktop_demo", valid, {"unassigned"})
        self.assertEqual(caught.exception.status, 409)
        for body in ({"panes": ["missing"]}, {"panes": ["one", "one"]}, {"panes": ["one"], "active": "two"},
                     {"panes": ["one"] * 5}, {"panes": [], "ratios": {"cols": [float("inf")]}}):
            with self.assertRaises(workspaces.WorkspaceError):
                workspaces.device_layout("another", {"revision": 0, **body}, self.known)

    def test_storage_private_and_symlink_rejected(self):
        self.assertEqual(workspaces.DB.stat().st_mode & 0o777, 0o600)
        self.assertEqual(workspaces.DB.parent.stat().st_mode & 0o777, 0o700)
        link = self.root / "link.sqlite3"
        link.symlink_to(workspaces.DB)
        with patch.object(workspaces, "DB", link), self.assertRaises(workspaces.WorkspaceError):
            workspaces.listing()

    def test_notifications_dedupe_ack_and_bound(self):
        activity = {"phase": "complete", "source": "claude-hook", "updatedAt": time.time(), "eventKey": "run:event:1"}
        one = workspaces.record_events({"one": activity})
        self.assertEqual(len(workspaces.record_events({"one": activity})), 1)
        workspaces.acknowledge([one[0]["id"]])
        self.assertEqual(workspaces.record_events({})[0]["seen"], 1)
        for i in range(305):
            activity = {**activity, "updatedAt": time.time(), "eventKey": str(i)}
            workspaces.record_events({"one": activity})
        with workspaces.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events").fetchone()[0], 300)

    def test_authenticated_routes_and_no_native_process_actions(self):
        async def request(method, path, authenticated=False):
            parsed, _, query = path.partition("?")
            headers = [(b"authorization", ("Bearer " + main.config.TOKEN).encode())] if authenticated else []
            scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
                     "scheme": "http", "path": parsed, "raw_path": parsed.encode(), "query_string": query.encode(),
                     "headers": headers, "server": ("test", 80), "client": ("127.0.0.1", 1234)}
            messages = []
            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}
            async def send(message):
                messages.append(message)
            await main.app(scope, receive, send)
            return next(message["status"] for message in messages if message["type"] == "http.response.start")
        async def run():
            with patch.object(main.config, "AUTH_ENABLED", True):
                self.assertEqual(await request("GET", "/api/workspaces"), 401)
                self.assertEqual(await request("GET", "/api/layouts/desktop_demo"), 401)
                self.assertEqual(await request("PUT", "/api/layouts/desktop_demo"), 401)
                self.assertEqual(await request("GET", "/api/git/status?path=" + str(self.root)), 401)
                self.assertEqual(await request("GET", "/api/fs/edit?path=" + str(self.root)), 401)
                with patch.object(main.store, "list_tabs", return_value=[]), patch.object(main.tmux_mgr, "kill_session") as kill:
                    self.assertEqual(await request("GET", "/api/workspaces", True), 200)
                    self.assertEqual(await request("GET", "/api/layouts/desktop_demo", True), 200)
                    self.assertEqual(await request("DELETE", "/api/workspaces/" + self.space["id"] + "?revision=1", True), 200)
                    kill.assert_not_called()
        asyncio.run(run())


class WorkspaceToolsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.file = self.root / "example.txt"
        self.file.write_bytes(b"original\r\n")

    def test_save_preserves_mode_crlf_and_catches_other_editor(self):
        self.file.chmod(0o640)
        original = workspace_tools.read_text(self.file)
        self.file.write_bytes(b"external\r\n")
        with self.assertRaises(workspaces.WorkspaceError) as caught:
            workspace_tools.write_text(self.file, {"text": "overwrite", "etag": original["etag"]})
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(self.file.read_bytes(), b"external\r\n")
        latest = workspace_tools.read_text(self.file)
        saved = workspace_tools.write_text(self.file, {"text": "updated\r\n", "etag": latest["etag"]})
        self.assertEqual(saved["etag"], workspace_tools.read_text(self.file)["etag"])
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o640)
        self.assertEqual(self.file.read_bytes(), b"updated\r\n")

    def test_binary_encoding_large_and_special_files_rejected(self):
        for raw in (b"binary\0data", b"\xff", b"a" * (workspace_tools.MAX_TEXT + 1)):
            self.file.write_bytes(raw)
            with self.assertRaises(workspaces.WorkspaceError):
                workspace_tools.read_text(self.file)
        link = self.root / "symlink"
        link.symlink_to(self.file)
        with self.assertRaises(workspaces.WorkspaceError):
            workspace_tools.read_text(link)
        fifo = self.root / "fifo"
        os.mkfifo(fifo)
        with self.assertRaises(workspaces.WorkspaceError):
            workspace_tools.read_text(fifo)

    def test_git_paths_renames_and_read_only_diff(self):
        def git(*args):
            return subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True)
        git("init", "-q")
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "example.txt")
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
        git("mv", "example.txt", "renamed file.txt")
        (self.root / "untracked\nfile.txt").write_text("new")
        status = workspace_tools.git_status(self.root)
        rename = next(row for row in status["changes"] if "R" in row["status"])
        self.assertEqual(rename["path"], "renamed file.txt")
        self.assertEqual(rename["original"], "example.txt")
        self.assertTrue(any(row["path"] == "untracked\nfile.txt" for row in status["changes"]))
        self.assertIn("renamed file.txt", workspace_tools.git_diff(self.root, "renamed file.txt", True)["text"])
        with self.assertRaises(workspaces.WorkspaceError):
            workspace_tools.git_diff(self.root, "../secret")
        git("checkout", "--detach", "-q")
        self.assertTrue(workspace_tools.git_status(self.root)["branch"])

    def test_history_readonly_literal_search_and_limits(self):
        with patch.object(workspace_tools, "command", return_value=(b"alpha\nneedle\nNeedle again\n", False)) as command:
            result = workspace_tools.history("cc_demo", "needle")
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["matches"][0]["line"], 2)
        self.assertEqual(command.call_args.args[0][1], "capture-pane")

    def test_activity_does_not_guess_approval_from_text_or_old_process(self):
        record = {"agent": "claude", "run": "new", "activity": {"phase": "needs_attention", "run": "old", "at": 1, "event": "PermissionRequest"}}
        with patch.object(agent_activity.agent_sessions, "same_process", return_value=True):
            self.assertEqual(agent_activity.status("one", True, record)["phase"], "online")
        with patch.object(agent_activity.agent_sessions, "same_process", return_value=False):
            self.assertEqual(agent_activity.status("one", True, record)["phase"], "online")
        self.assertEqual(agent_activity.status("one", False, record)["phase"], "offline")

    def test_codex_activity_uses_only_this_process_events_and_never_exposes_text(self):
        transcript = self.root / "fixture.jsonl"
        record = {"agent": "codex", "run": "fixture", "transcript": str(transcript), "launched_at": 100}
        transcript.write_text('\n'.join(json.dumps(row) for row in [
            {"type": "event_msg", "timestamp": "1970-01-01T00:00:50Z", "payload": {"type": "task_complete"}},
            {"type": "event_msg", "timestamp": "1970-01-01T00:03:00Z", "payload": {"type": "task_started", "message": "private-text-must-not-escape"}},
        ]) + '\n')
        with patch.object(agent_activity.agent_sessions, "same_process", return_value=True), patch.object(agent_activity.agent_sessions, "transcript_exists", return_value=True):
            status = agent_activity.status("one", True, record)
            self.assertEqual(status["phase"], "working")
            self.assertNotIn("private-text", json.dumps(status))
            transcript.write_text(json.dumps({"type": "event_msg", "timestamp": "1970-01-01T00:03:01Z", "payload": {"type": "task_complete"}}) + '\n')
            self.assertEqual(agent_activity.status("one", True, record)["phase"], "complete")
            transcript.write_text('{"type":"unknown-future-format"}\n')
            self.assertEqual(agent_activity.status("one", True, record)["phase"], "online")


if __name__ == "__main__":
    unittest.main()
