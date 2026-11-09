import json
import unittest
from unittest.mock import patch

from starlette.requests import Request
from starlette.responses import Response
from fastapi import HTTPException

from backend import main
from backend.browser_security import BrowserSecurityMiddleware, same_origin


def scope(kind="http", path="/api/config", origin=None, host="terminal.example:8443", scheme="https", peer="192.0.2.10", extra=None):
    headers = {"host": host, **(extra or {})}
    if origin is not None:
        headers["origin"] = origin
    return {"type": kind, "path": path, "scheme": scheme, "method": "GET", "query_string": b"",
            "client": (peer, 1234), "server": ("terminal.example", 8443),
            "headers": [(key.encode(), value.encode()) for key, value in headers.items()]}


class OriginTests(unittest.TestCase):
    def test_matching_browser_origins_and_default_ports(self):
        for kind, scheme in (("http", "https"), ("websocket", "wss")):
            self.assertTrue(same_origin(scope(kind=kind, scheme=scheme, origin="https://terminal.example:8443")))
        self.assertTrue(same_origin(scope(origin="https://terminal.example:443", host="terminal.example")))
        self.assertTrue(same_origin(scope(origin="http://localhost", host="localhost:80", scheme="http")))
        self.assertTrue(same_origin(scope(origin="http://[::1]:9000", host="[::1]:9000", scheme="http")))

    def test_sibling_subdomain_foreign_port_scheme_and_opaque_origin_rejected(self):
        for origin in ("https://evil.example:8443", "https://sub.terminal.example:8443", "http://terminal.example:8443",
                       "https://terminal.example", "null", "file://", "https://user@terminal.example:8443",
                       "https://terminal.example:bad", "https://terminal.example:8443/extra", "https://terminal.example:8443?x=1"):
            with self.subTest(origin=origin):
                self.assertFalse(same_origin(scope(origin=origin)))

    def test_forwarded_scheme_only_from_loopback_and_host_not_overridden(self):
        self.assertTrue(same_origin(scope(scheme="http", peer="127.0.0.1", origin="https://terminal.example:8443", extra={"x-forwarded-proto": "https"})))
        self.assertFalse(same_origin(scope(scheme="http", origin="https://terminal.example:8443", extra={"x-forwarded-proto": "https"})))
        self.assertFalse(same_origin(scope(origin="https://evil.example", extra={"x-forwarded-host": "evil.example"})))

    def test_non_browser_without_origin_and_fetch_metadata(self):
        self.assertTrue(same_origin(scope()))
        for site in ("same-origin", "none"):
            self.assertTrue(same_origin(scope(extra={"sec-fetch-site": site})))
        for site in ("same-site", "cross-site"):
            self.assertFalse(same_origin(scope(extra={"sec-fetch-site": site})))


class MiddlewareTests(unittest.IsolatedAsyncioTestCase):
    async def invoke(self, request_scope, response_headers=None):
        self.called, sent = False, []
        async def app(s, receive, send):
            self.called = True
            if s["type"] == "http":
                await send({"type": "http.response.start", "status": 200, "headers": response_headers or []})
                await send({"type": "http.response.body", "body": b"ok"})
        async def receive():
            return {"type": "http.request", "body": b""}
        async def send(message):
            sent.append(message)
        await BrowserSecurityMiddleware(app)(request_scope, receive, send)
        return sent

    async def test_foreign_websocket_denied_before_attach(self):
        sent = await self.invoke(scope(kind="websocket", path="/ws/term/demo01", origin="https://evil.example"))
        self.assertFalse(self.called)
        self.assertEqual(sent, [{"type": "websocket.close", "code": 4403}])

    async def test_same_origin_websocket_is_passed_to_authentication(self):
        await self.invoke(scope(kind="websocket", path="/ws/term/demo01", scheme="wss", origin="https://terminal.example:8443"))
        self.assertTrue(self.called)

    async def test_foreign_mutation_and_login_are_denied_before_endpoint(self):
        for path in ("/api/login", "/api/sessions", "/api/layouts/desktop_demo", "/api/fs/edit"):
            request = scope(path=path, origin="https://evil.example"); request["method"] = "POST"
            sent = await self.invoke(request)
            self.assertFalse(self.called)
            self.assertEqual(sent[0]["status"], 403)

    async def test_page_headers_prevent_framing_without_blocking_file_preview(self):
        sent = await self.invoke(scope(path="/"))
        headers = dict(sent[0]["headers"])
        self.assertEqual(headers[b"x-frame-options"], b"DENY")
        self.assertIn(b"frame-ancestors 'none'", headers[b"content-security-policy"])
        self.assertEqual(headers[b"referrer-policy"], b"no-referrer")
        sent = await self.invoke(scope(path="/api/fs/raw"), [(b"content-security-policy", b"sandbox; default-src 'none'")])
        headers = dict(sent[0]["headers"])
        self.assertEqual(headers[b"content-security-policy"], b"sandbox; default-src 'none'")
        self.assertNotIn(b"x-frame-options", headers)
        self.assertEqual(headers[b"cache-control"], b"private, no-store")

    async def test_auth_is_still_required_when_origin_is_valid(self):
        request = Request(scope(origin="https://terminal.example:8443"))
        with patch.object(main.config, "AUTH_ENABLED", True), patch.object(main.config, "TOKEN", "synthetic-secret"):
            with self.assertRaises(HTTPException) as raised:
                main.require_auth(request)
        self.assertEqual(raised.exception.status_code, 401)

    async def test_malformed_login_body_is_a_client_error_not_a_server_crash(self):
        for value in ([], None, "text", {"token": 123}, {"token": []}, {}):
            async def receive():
                return {"type": "http.request", "body": json.dumps(value).encode(), "more_body": False}
            with patch.object(main.config, "AUTH_ENABLED", True):
                with self.assertRaises(HTTPException) as raised:
                    await main.login(Request(scope(path="/api/login"), receive), Response())
            self.assertEqual(raised.exception.status_code, 400)
