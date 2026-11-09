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

    def test_move_is_atomic_and_does_not_change_screen_layout_or_directory(self):
        target = workspaces.create("Target", "/another", [])
        saved = workspaces.device_layout("desktop", {"panes": ["one", "two"], "active": "one", "revision": 0}, self.known)
        moved = workspaces.move_session(self.space["id"], {"sid": "one", "target": target["id"], "revision": 1, "targetRevision": 1}, self.known)
        self.assertEqual(moved["source"]["members"], ["two"])
        self.assertEqual(moved["target"]["members"], ["one"])
        self.assertEqual(moved["source"]["cwd"], str(self.root))
        self.assertEqual(moved["target"]["cwd"], "/another")
        self.assertEqual(workspaces.device_layout("desktop"), saved)

    def test_move_rejects_stale_revisions_without_partial_writes(self):
        target = workspaces.create("Target", str(self.root), [])
        for revisions in [(0, 1), (1, 0)]:
            with self.assertRaises(workspaces.WorkspaceError):
                workspaces.move_session(self.space["id"], {"sid": "one", "target": target["id"], "revision": revisions[0], "targetRevision": revisions[1]}, self.known)
            rows = {item["id"]: item for item in workspaces.listing()}
            self.assertEqual(rows[self.space["id"]]["members"], ["one", "two"])
            self.assertEqual(rows[target["id"]]["members"], [])

    def test_move_unassigned_and_existing_target_member(self):
        target = workspaces.create("Target", str(self.root), ["one"])
        moved = workspaces.move_session(self.space["id"], {"sid": "one", "target": target["id"], "revision": 1, "targetRevision": 1}, self.known)
        self.assertEqual(moved["target"]["members"], ["one"])
        with self.assertRaises(workspaces.WorkspaceError):
            workspaces.move_session("_unassigned", {"sid": "one", "target": target["id"], "targetRevision": 2}, self.known)
        moved = workspaces.move_session("_unassigned", {"sid": "three", "target": target["id"], "targetRevision": 2}, {*self.known, "three"})
        self.assertIsNone(moved["source"])
        self.assertEqual(moved["target"]["members"], ["one", "three"])

    def test_move_missing_session_and_full_target_leave_source_untouched(self):
        target = workspaces.create("Target", str(self.root), ["member" + str(i) for i in range(128)])
        for sid in ["missing", "one"]:
            with self.assertRaises(workspaces.WorkspaceError):
                workspaces.move_session(self.space["id"], {"sid": sid, "target": target["id"], "revision": 1, "targetRevision": 1}, self.known)
        rows = {item["id"]: item for item in workspaces.listing()}
        self.assertEqual(rows[self.space["id"]]["revision"], 1)
        self.assertEqual(rows[target["id"]]["revision"], 1)

    def test_activity_order_is_persistent_pinned_first_and_revision_independent(self):
        second = workspaces.create("Second", str(self.root), [])
        pinned = workspaces.create("Pinned", str(self.root), [])
        workspaces.update(pinned["id"], {"revision": 1, "pinned": True}, self.known)
        with patch.object(time, "time", return_value=100):
            workspaces.activate(self.space["id"])
        with patch.object(time, "time", return_value=200):
            workspaces.activate(second["id"])
        rows = workspaces.listing()
        self.assertEqual([row["id"] for row in rows], [pinned["id"], second["id"], self.space["id"]])
        self.assertEqual(rows[1]["lastUsed"], 200)
        self.assertEqual(rows[1]["revision"], 1)
        self.assertEqual(workspaces.device_layout("desktop")["revision"], 0)
        with patch.object(time, "time", return_value=50):
            workspaces.activate(second["id"])
        self.assertEqual(workspaces.listing()[1]["lastUsed"], 200)
        workspaces.delete(second["id"], 1)
        with workspaces.connection() as db:
            self.assertFalse(db.execute("SELECT 1 FROM workspace_usage WHERE workspace=?", (second["id"],)).fetchone())
        with self.assertRaises(workspaces.WorkspaceError) as caught:
            workspaces.activate("missing")
        self.assertEqual(caught.exception.status, 404)

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
        self.assertEqual(workspaces.device_layout("desktop_demo", saved, {"unassigned"})["revision"], 2)
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

    def screen_layout(self):
        return {"revision": 0, "screenSchema": 1, "activeScreen": "screen2", "screens": [
            {"id": "screen1", "name": "Screen 1", "panes": ["one", None, "two"], "active": "two", "maximized": 2},
            {"id": "screen2", "name": "Screen 2", "panes": ["two"], "active": "two", "direction": "col", "ratios": {"rows": [1, 2]}},
        ]}

    def test_screens_roundtrip_profiles_focus_ratios_and_legacy_projection(self):
        saved = workspaces.device_layout("desktop_user_demo", self.screen_layout(), self.known)
        self.assertEqual(workspaces.device_layout("desktop_user_demo"), saved)
        self.assertEqual(saved["panes"], ["two"])
        self.assertEqual(saved["screens"][0]["panes"], ["one", None])
        self.assertIsNone(saved["screens"][0]["maximized"])
        self.assertEqual(saved["screens"][1]["ratios"], {"rows": [1, 2]})
        self.assertEqual(workspaces.device_layout("mobile_user_demo")["revision"], 0)
        self.assertEqual(workspaces.device_layout("desktop_user_other")["revision"], 0)
        legacy = workspaces.device_layout("desktop_user_demo", {"revision": 1, "panes": ["one"], "active": "one"}, self.known)
        self.assertEqual(legacy["screens"][0]["panes"], [None])
        self.assertIsNone(legacy["screens"][0]["active"])
        self.assertEqual(legacy["screens"][1]["panes"], ["one"])
        with self.assertRaises(workspaces.WorkspaceError) as caught:
            workspaces.device_layout("desktop_user_demo", {**saved, "revision": 1}, self.known)
        self.assertEqual(caught.exception.status, 409)
        selected = {**legacy, "activeScreen": "screen1"}
        workspaces.device_layout("desktop_user_demo", selected, self.known)
        resized = workspaces.device_layout("desktop_user_demo", {"revision": 3, "panes": ["two"], "active": "two"}, self.known)
        self.assertIsNone(resized["screens"][0]["maximized"])

    def test_screen_order_roundtrip_keeps_id_focus_geometry_and_other_profiles(self):
        before = workspaces.device_layout("desktop_order", self.screen_layout(), self.known)
        mobile = workspaces.device_layout("mobile_order", self.screen_layout(), self.known)
        body = {**before, "screens": list(reversed(before["screens"]))}
        saved = workspaces.device_layout("desktop_order", body, self.known)
        self.assertEqual([item["id"] for item in saved["screens"]], ["screen2", "screen1"])
        self.assertEqual(saved["screens"], list(reversed(before["screens"])))
        self.assertEqual(saved["activeScreen"], before["activeScreen"])
        for key in ("panes", "active", "maximized", "ratios", "direction"):
            self.assertEqual(saved.get(key), before.get(key))
        self.assertEqual(workspaces.device_layout("desktop_order"), saved)
        self.assertEqual(workspaces.device_layout("mobile_order"), mobile)
        with self.assertRaises(workspaces.WorkspaceError) as caught:
            workspaces.device_layout("desktop_order", body, self.known)
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(workspaces.device_layout("desktop_order"), saved)

    def test_screen_validation_is_atomic_and_bounds_all_screens(self):
        value = self.screen_layout()
        bad = [
            {**value, "screenSchema": True}, {**value, "screenSchema": 2},
            {**value, "activeScreen": "missing"}, {**value, "screens": []},
            {**value, "screens": value["screens"] * 9},
            {**value, "screens": [value["screens"][0], value["screens"][0]]},
        ]
        for fields in ({"name": ""}, {"name": "x\n"}, {"id": "../evil"}, {"panes": ["one"] * 5},
                       {"panes": ["unknown"]}, {"panes": ["two", "two"]}, {"active": "missing"},
                       {"maximized": True}, {"maximized": -1}, {"maximized": 3},
                       {"ratios": {"rows": [float("nan")]}}):
            bad.append({**value, "screens": [{**value["screens"][0], **fields}, value["screens"][1]]})
        for body in bad:
            with self.subTest(body=body), self.assertRaises(workspaces.WorkspaceError):
                workspaces.device_layout("desktop", body, self.known)
            self.assertEqual(workspaces.device_layout("desktop")["revision"], 0)

    def test_deleted_terminal_reference_survives_but_new_unknown_id_is_rejected(self):
        saved = workspaces.device_layout("desktop", self.screen_layout(), self.known)
        saved["activeScreen"] = "screen1"
        again = workspaces.device_layout("desktop", saved, {"two"})
        self.assertEqual(again["panes"], ["one", None])
        bad = {**again, "screens": [{**again["screens"][0], "panes": ["missing"], "active": "missing"}]}
        with self.assertRaises(workspaces.WorkspaceError):
            workspaces.device_layout("desktop", bad, {"two"})
        self.assertEqual(workspaces.device_layout("desktop")["revision"], 2)

    def test_saved_layout_catalog_is_scoped_read_only_and_summary_only(self):
        value = self.screen_layout()
        saved = workspaces.device_layout("desktop_demo", value, self.known)
        workspaces.device_layout("mobile_user_demo", value, self.known)
        rows = workspaces.saved_layouts("desktop")
        self.assertEqual(rows, [{"device": "desktop_demo", "screenNames": ["Screen 1", "Screen 2"], "screenCount": 2, "paneCount": 3}])
        self.assertEqual(workspaces.device_layout("desktop_demo"), saved)
        self.assertEqual(len(workspaces.saved_layouts("mobile")), 1)
        self.assertNotIn('"panes"', json.dumps(rows))
        with self.assertRaises(workspaces.WorkspaceError):
            workspaces.saved_layouts("unknown")

    def test_saved_layout_catalog_skips_corrupt_rows_without_losing_healthy_layouts(self):
        workspaces.device_layout("desktop_demo", self.screen_layout(), self.known)
        with workspaces.connection() as db:
            db.execute("INSERT INTO device_layouts VALUES(?,?,?)", ("desktop_bad", "{invalid", 1))
        self.assertEqual(len(workspaces.saved_layouts("desktop")), 1)

    def test_exclusive_screens_read_old_duplicates_without_mutating_storage(self):
        original = self.screen_layout()
        with workspaces.connection() as db:
            db.execute("INSERT INTO device_layouts VALUES(?,?,?)", ("desktop_old", json.dumps(original), 7))
        saved = workspaces.device_layout("desktop_old")
        self.assertEqual(saved["screens"][0]["panes"], ["one", None])
        self.assertEqual(saved["screens"][1]["panes"], ["two"])
        self.assertEqual(saved["revision"], 7)
        with workspaces.connection() as db:
            row = db.execute("SELECT body,revision FROM device_layouts WHERE device=?", ("desktop_old",)).fetchone()
            self.assertEqual(json.loads(row["body"]), original)
            self.assertEqual(row["revision"], 7)
        self.assertEqual(workspaces.saved_layouts()[0]["paneCount"], 3)
        workspaces.device_layout("desktop_old", saved, self.known)
        with workspaces.connection() as db:
            value = json.loads(db.execute("SELECT body FROM device_layouts WHERE device=?", ("desktop_old",)).fetchone()[0])
            self.assertEqual(value["screens"], saved["screens"])

    def test_exclusive_screens_preserve_focus_maximized_slot_and_unaffected_ratios(self):
        value = self.screen_layout()
        value["screens"][0].update(panes=["two", None, "one"], active="one", maximized=2, ratios={"cols": [1, 3]})
        value["screens"].append({"id": "screen3", "name": "Third", "panes": ["one", None], "active": "one", "maximized": 0})
        saved = workspaces.device_layout("desktop", value, self.known)
        self.assertEqual(saved["screens"][0]["panes"], [None, "one"])
        self.assertEqual(saved["screens"][0]["active"], "one")
        self.assertEqual(saved["screens"][0]["maximized"], 1)
        self.assertEqual(saved["screens"][0]["ratios"], {})
        self.assertEqual(saved["screens"][1]["ratios"], {"rows": [1, 2]})
        self.assertEqual(saved["screens"][2]["panes"], [None])
        self.assertIsNone(saved["screens"][2]["maximized"])
        self.assertIsNone(saved["screens"][2]["active"])

    def test_exclusive_screens_apply_to_old_full_writes_but_not_other_device_profiles(self):
        body = self.screen_layout()
        first = workspaces.device_layout("desktop", body, self.known)
        second = workspaces.device_layout("mobile", body, self.known)
        self.assertEqual(first["screens"], second["screens"])
        body["revision"] = 1
        body["activeScreen"] = "screen1"
        moved = workspaces.device_layout("desktop", body, self.known)
        self.assertEqual(moved["screens"][0]["panes"], ["one", None, "two"])
        self.assertEqual(moved["screens"][1]["panes"], [])
        self.assertIsNone(moved["screens"][1]["active"])
        self.assertEqual(workspaces.device_layout("mobile"), second)
        with self.assertRaises(workspaces.WorkspaceError) as caught:
            workspaces.device_layout("desktop", body, self.known)
        self.assertEqual(caught.exception.status, 409)

    def test_screens_http_contract_auth_validation_and_no_native_actions(self):
        async def request(method, body=None, authenticated=True):
            headers = [(b"authorization", ("Bearer " + main.config.TOKEN).encode())] if authenticated else []
            scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
                     "scheme": "http", "path": "/api/layouts/desktop_user_demo", "query_string": b"", "headers": headers,
                     "server": ("test", 80), "client": ("127.0.0.1", 1234)}
            messages = []
            async def receive():
                return {"type": "http.request", "body": json.dumps(body).encode() if body is not None else b"", "more_body": False}
            async def send(message):
                messages.append(message)
            await main.app(scope, receive, send)
            status = next(message["status"] for message in messages if message["type"] == "http.response.start")
            return status, json.loads(b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body"))
        async def run():
            with patch.object(main.config, "AUTH_ENABLED", True), patch.object(main.store, "list_tabs", return_value=[{"id": sid} for sid in self.known]), patch.object(subprocess, "Popen") as native:
                self.assertEqual((await request("PUT", self.screen_layout(), False))[0], 401)
                status, saved = await request("PUT", self.screen_layout())
                self.assertEqual(status, 200)
                self.assertEqual(saved["activeScreen"], "screen2")
                self.assertEqual(await request("GET"), (200, saved))
                self.assertEqual((await request("PUT", self.screen_layout()))[0], 409)
                self.assertEqual((await request("PUT", {"revision": 1, "screenSchema": 1, "screens": []}))[0], 400)
                native.assert_not_called()
        asyncio.run(run())

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
                self.assertEqual(await request("GET", "/api/layouts"), 401)
                self.assertEqual(await request("PUT", "/api/layouts/desktop_demo"), 401)
                self.assertEqual(await request("GET", "/api/git/status?path=" + str(self.root)), 401)
                self.assertEqual(await request("GET", "/api/fs/edit?path=" + str(self.root)), 401)
                self.assertEqual(await request("POST", "/api/workspaces/" + self.space["id"] + "/activate"), 401)
                self.assertEqual(await request("GET", "/api/sessions/legacy/recovery"), 401)
                self.assertEqual(await request("POST", "/api/sessions/legacy/recovery/bind"), 401)
                with patch.object(main.store, "list_tabs", return_value=[]), patch.object(main.tmux_mgr, "kill_session") as kill:
                    self.assertEqual(await request("GET", "/api/workspaces", True), 200)
                    self.assertEqual(await request("POST", "/api/workspaces/" + self.space["id"] + "/activate", True), 200)
                    self.assertEqual(await request("GET", "/api/layouts/desktop_demo", True), 200)
                    self.assertEqual(await request("GET", "/api/layouts?kind=desktop", True), 200)
                    self.assertEqual(await request("GET", "/api/layouts?kind=invalid", True), 400)
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
