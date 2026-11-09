import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend import main, workspaces


class LayoutBindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "state.sqlite3"
        patched = patch.object(workspaces, "DB", self.db)
        patched.start()
        self.addCleanup(patched.stop)

    def put(self, revision=0, writer="page-a", sequence=1, panes=None):
        body = {"revision": revision, "panes": panes or ["one"], "active": "one"}
        if writer is not None:
            body.update(writer=writer, sequence=sequence)
        return workspaces.device_layout("desktop_demo", body, {"one", "two"})

    def test_same_token_persistent_device_binding_without_raw_secret(self):
        self.assertIsNone(workspaces.token_layout_binding("test-token-a", "desktop")["device"])
        result = workspaces.token_layout_binding("test-token-a", "desktop", {"device": "desktop_demo", "revision": 0})
        self.assertEqual(workspaces.token_layout_binding("test-token-a", "desktop"), result)
        self.assertIsNone(workspaces.token_layout_binding("test-token-a", "mobile")["device"])
        self.assertIsNone(workspaces.token_layout_binding("test-token-b", "desktop")["device"])
        self.assertNotIn(b"test-token-a", self.db.read_bytes())
        self.assertNotIn(b"test-token-b", self.db.read_bytes())
        self.assertEqual(self.db.stat().st_mode & 0o777, 0o600)

    def test_first_client_wins_initialization_and_profile_switch_is_revisioned(self):
        initial = {"device": "desktop_demo", "revision": 0}
        workspaces.token_layout_binding("token", "desktop", initial)
        with self.assertRaises(workspaces.WorkspaceError) as caught:
            workspaces.token_layout_binding("token", "desktop", {**initial, "device": "desktop_other"})
        self.assertEqual(caught.exception.status, 409)
        with self.assertRaises(workspaces.WorkspaceError) as caught:
            workspaces.token_layout_binding("token", "desktop", {"device": "desktop_other", "revision": 1})
        self.assertEqual(caught.exception.status, 404)
        workspaces.device_layout("desktop_other", {"panes": [], "revision": 0})
        changed = workspaces.token_layout_binding("token", "desktop", {"device": "desktop_other", "revision": 1})
        self.put()
        self.assertEqual(workspaces.token_layout_binding("token", "desktop"), changed)

    def test_binding_validation(self):
        for kind, body in [("watch", None), ("desktop", {"device": "mobile_demo", "revision": 0}),
                           ("desktop", {"device": "../bad", "revision": 0}), ("desktop", {"device": None, "revision": 0}),
                           ("desktop", {"device": "desktop_demo", "revision": False}),
                           ("desktop", {"device": "desktop_user_", "revision": 0}),
                           ("desktop", {"device": "desktop_" + "a" * 49, "revision": 0})]:
            with self.subTest(kind=kind, body=body), self.assertRaises(workspaces.WorkspaceError):
                workspaces.token_layout_binding("token", kind, body)

    def test_closing_checkpoint_can_supersede_own_inflight_write(self):
        self.put()
        result = self.put(sequence=2, panes=["two", "one"])
        self.assertEqual(result["revision"], 2)
        self.assertEqual(result["panes"], ["two", "one"])
        self.assertEqual(self.put(sequence=1), result)
        self.assertEqual(self.put(revision=1, sequence=2), result)
        self.assertEqual(workspaces.device_layout("desktop_demo"), result)

    def test_checkpoint_arriving_before_old_request_never_rolls_back(self):
        final = self.put(sequence=2, panes=["two", "one"])
        self.assertEqual(self.put(), final)
        self.assertEqual(final["revision"], 1)

    def test_foreign_or_legacy_writer_prevents_stale_checkpoint(self):
        for foreign in ["page-b", None]:
            with self.subTest(foreign=foreign):
                with workspaces.connection() as db:
                    db.execute("DELETE FROM device_layouts")
                self.put()
                latest = self.put(revision=1, writer=foreign, panes=["one", "two"])
                with self.assertRaises(workspaces.WorkspaceError) as caught:
                    self.put(sequence=3, panes=["two", "one"])
                self.assertEqual(caught.exception.status, 409)
                self.assertEqual(workspaces.device_layout("desktop_demo"), latest)

    def test_write_validation_and_strict_legacy_revisions(self):
        self.put(writer=None)
        with self.assertRaises(workspaces.WorkspaceError):
            self.put(writer=None)
        for writer, sequence in [("../x", 1), ("ok", True), ("ok", -1), ("ok", 9007199254740992), ("ok", None)]:
            with self.subTest(writer=writer, sequence=sequence), self.assertRaises(workspaces.WorkspaceError):
                self.put(revision=1, writer=writer, sequence=sequence)

    def test_http_auth_cookie_and_bearer_share_binding_and_no_native_actions(self):
        async def request(method, body=None, credential="cookie", kind="desktop"):
            headers = []
            if credential == "cookie":
                headers = [(b"cookie", ("cc_web_token=" + main._new_session_cookie_value()).encode())]
            elif credential == "bearer":
                headers = [(b"authorization", b"Bearer test-only-token")]
            scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
                     "scheme": "https", "path": "/api/layout-binding/" + kind, "query_string": b"", "headers": headers,
                     "server": ("test", 443), "client": ("127.0.0.1", 1234)}
            messages = []
            async def receive():
                return {"type": "http.request", "body": json.dumps(body).encode() if body is not None else b"", "more_body": False}
            async def send(message):
                messages.append(message)
            await main.app(scope, receive, send)
            start = next(m for m in messages if m["type"] == "http.response.start")
            value = json.loads(b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body"))
            return start["status"], value, dict(start["headers"])
        async def run():
            with patch.object(main.config, "AUTH_ENABLED", True), patch.object(main.config, "TOKEN", "test-only-token"), patch.object(main.tmux_mgr, "kill_session") as kill, patch.object(main.store, "list_tabs") as native:
                for method in ["GET", "PUT"]:
                    self.assertEqual((await request(method, credential="none"))[0], 401)
                status, saved, headers = await request("PUT", {"device": "desktop_demo", "revision": 0})
                self.assertEqual(status, 200)
                self.assertEqual(headers[b"cache-control"], b"private, no-store")
                self.assertEqual((await request("GET", credential="bearer"))[1], saved)
                self.assertIsNone((await request("GET", kind="mobile"))[1]["device"])
                self.assertEqual((await request("GET", kind="invalid"))[0], 400)
                kill.assert_not_called()
                native.assert_not_called()
            with patch.object(main.config, "AUTH_ENABLED", False):
                self.assertEqual((await request("GET", credential="none"))[1], {"enabled": False})
                self.assertEqual((await request("PUT", {}, credential="none"))[0], 409)
        asyncio.run(run())
