import asyncio
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from backend import agent_sessions as sessions, config, main, terminal_permissions as permissions, terminal_restart as restart


class PermissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="webcc-permission-test-")
        self.addCleanup(self.temp.cleanup)
        override = patch.object(config, "AGENT_RUNTIME_DIR", Path(self.temp.name))
        override.start()
        self.addCleanup(override.stop)

    def record(self, agent="codex", args=None):
        return {"agent": agent, "session_id": str(uuid.uuid4()), "cwd": self.temp.name, "args": args or []}

    def test_only_whitelisted_choices_are_accepted(self):
        for agent, body in [("shell", {}), ("opencode", {"mode": "allow"}), ("codex", []),
                            ("codex", {"approval": "never", "sandbox": "$(id)"}),
                            ("claude", {"mode": "default", "args": ["--evil"]}),
                            ("claude", {"mode": []})]:
            with self.subTest(agent=agent, body=body), self.assertRaises(permissions.PermissionError):
                permissions.validate(agent, body)

    def test_codex_removes_conflicting_short_long_inline_and_preset_flags(self):
        record = self.record(args=["--yolo", "--full-auto", "--approve-for-me", "--not-so-yolo", "-s", "danger-full-access", "--ask-for-approval=never",
                                   "-c", 'model_provider="current"', "--config=approval_policy=\"never\"", "-c", 'sandbox_mode="danger-full-access"',
                                   "-m", "demo-model", "--add-dir", "/workspace/extra"])
        choice = {"approval": "on-request", "sandbox": "workspace-write"}
        rewritten = permissions.rewrite(record, choice)
        args = restart.resume_arguments(rewritten)
        self.assertEqual(args[:2], ["resume", record["session_id"]])
        for removed in ("--yolo", "--full-auto", "--approve-for-me", "--not-so-yolo", "danger-full-access", "never"):
            self.assertNotIn(removed, args)
        self.assertIn('model_provider="current"', args)
        self.assertIn("demo-model", args)
        self.assertIn("/workspace/extra", args)
        self.assertEqual(permissions.current(rewritten)["values"], choice)
        self.assertIn("--yolo", record["args"])

    def test_option_like_values_and_prompt_delimiters_are_not_rewritten(self):
        record = self.record(args=["-m", "--yolo", "--", "prompt", "--sandbox", "danger-full-access"])
        updated = permissions.rewrite(record, {"approval": "never", "sandbox": "read-only"})
        self.assertEqual(updated["args"][:2], ["-m", "--yolo"])
        self.assertEqual(updated["args"][-4:], ["--", "prompt", "--sandbox", "danger-full-access"])
        self.assertIn("read-only", restart.resume_arguments(updated))

    def test_unknown_native_defaults_are_not_mislabelled_as_safe(self):
        self.assertEqual(permissions.current(self.record())["values"], {})
        self.assertIn("未确认", permissions.current(self.record())["label"])

    def test_custom_permission_profiles_fail_closed(self):
        record = self.record(args=["-c", 'permissions.default="unrestricted"'])
        with self.assertRaises(permissions.PermissionError):
            permissions.rewrite(record, {"approval": "never", "sandbox": "read-only"})

    def test_claude_modes_replace_bypass_but_preserve_tool_rules_and_settings(self):
        record = self.record("claude", ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--permission-mode=bypassPermissions",
                                        "--allowedTools", "Read", "--settings", "/workspace/settings.json"])
        updated = permissions.rewrite(record, {"mode": "dontAsk"})
        args = restart.resume_arguments(updated)
        self.assertNotIn("--dangerously-skip-permissions", args)
        self.assertNotIn("--allow-dangerously-skip-permissions", args)
        self.assertIn("Read", args)
        self.assertIn("/workspace/settings.json", args)
        self.assertEqual(args[-2:], ["--resume", record["session_id"]])
        self.assertEqual(permissions.current(updated)["values"], {"mode": "dontAsk"})

    def test_restricted_claude_cannot_be_elevated(self):
        with self.assertRaises(permissions.PermissionError):
            permissions.rewrite(self.record("claude", ["--restricted"]), {"mode": "bypassPermissions"})

    def test_native_hook_overrides_old_startup_mode_and_invalidates_preview(self):
        record = self.record("claude", ["--permission-mode", "plan"])
        token = restart._expected("fixture", None, record)
        record["permission_mode"] = "acceptEdits"
        self.assertEqual(permissions.current(record)["values"], {"mode": "acceptEdits"})
        self.assertNotEqual(token, restart._expected("fixture", None, record))
        record["permission_mode"] = "manual"
        self.assertEqual(permissions.current(record)["values"], {"mode": "default"})

    def test_unsupported_values_are_refused(self):
        with self.assertRaises(permissions.PermissionError):
            permissions.check_values("claude", {"mode": "dontAsk"}, "--permission-mode [default, plan]")

    def test_capabilities_are_read_from_the_specific_option_not_unrelated_prose(self):
        help_text = "  --permission-mode <mode>\n    choices: default, plan\n  --something-else <value>\n    dontAsk never"
        with self.assertRaises(permissions.PermissionError):
            permissions.check_values("claude", {"mode": "dontAsk"}, help_text)
        permissions.check_values("claude", {"mode": "plan"}, help_text)
        permissions.check_values("claude", {"mode": "default"}, "  --permission-mode <mode>\n    choices: manual, plan")

    def test_danger_confirmation_required_even_for_exited_agent(self):
        record = self.record()
        sessions.save("fixture", record)
        preview = {"ready": True, "running": False, "expected": "challenge"}
        with patch.object(restart, "_inspect", return_value=preview), patch.object(restart, "_existing_pane", return_value=None), patch.object(restart, "_send") as send:
            for confirm in (None, False, "true"):
                with self.assertRaises(restart.RestartError):
                    restart.restart("fixture", {}, {"requestId": str(uuid.uuid4()), "expected": "challenge", "confirmed": True,
                        "permissions": {"approval": "never", "sandbox": "danger-full-access"}, "confirmDangerous": confirm})
            send.assert_not_called()

    def test_replayed_request_cannot_change_its_permission_payload(self):
        request_id = str(uuid.uuid4())
        sessions.save("fixture", {"requestId": request_id, "permissions": {"mode": "plan"}, "result": {"resumed": True}}, suffix=".operation.json")
        with self.assertRaises(restart.RestartError):
            restart.restart("fixture", {}, {"requestId": request_id, "permissions": {"mode": "bypassPermissions"}})

    def test_permission_endpoint_requires_an_existing_tab_and_never_restarts(self):
        with patch.object(main.store, "get_tab", return_value=None), patch.object(restart, "_send") as send:
            with self.assertRaises(HTTPException) as result:
                main.inspect_permissions("unknown", None)
            self.assertEqual(result.exception.status_code, 404)
            send.assert_not_called()

    def test_permission_routes_require_authentication(self):
        routes = [route for route in main.app.routes if getattr(route, "path", "") in {"/api/sessions/{sid}/permissions", "/api/sessions/{sid}/restart"}]
        self.assertTrue(routes)
        for route in routes:
            self.assertIn(main.require_auth, [dependency.call for dependency in route.dependant.dependencies])

    def test_restart_endpoint_rejects_non_object_permission_payload(self):
        request = Mock(json=AsyncMock(return_value=[]))
        with patch.object(main.store, "get_tab", return_value={"id": "fixture"}):
            with self.assertRaises(HTTPException) as result:
                asyncio.run(main.restart_session("fixture", request, None))
            self.assertEqual(result.exception.status_code, 400)
