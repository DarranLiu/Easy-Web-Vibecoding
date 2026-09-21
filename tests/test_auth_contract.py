import unittest
from unittest.mock import patch

from fastapi import HTTPException

from backend import main


class FakeRequest:
    def __init__(self, headers=None, cookies=None):
        self.headers = headers or {}
        self.cookies = cookies or {}


class AuthContractTests(unittest.TestCase):
    def test_bearer_auth_uses_the_configured_master_token(self):
        request = FakeRequest(headers={"authorization": f"Bearer {main.config.TOKEN}"})

        self.assertEqual(main._extract_bearer_token(request), main.config.TOKEN)
        self.assertTrue(main.require_auth(request))

    def test_cookie_is_a_server_issued_proof_not_the_master_token(self):
        cookie = main._new_session_cookie_value()

        self.assertNotEqual(cookie, main.config.TOKEN)
        self.assertTrue(main._session_cookie_matches(cookie))
        self.assertTrue(main.require_auth(FakeRequest(cookies={main.AUTH_COOKIE: cookie})))
        self.assertFalse(main.check_ws_token(main.config.TOKEN))

    def test_session_cookie_rejects_tampering_and_expiry(self):
        with patch.object(main.time, "time", return_value=1_800_000_000):
            cookie = main._new_session_cookie_value()
            self.assertTrue(main.check_ws_token(cookie))
            replacement = "0" if cookie[-1] != "0" else "1"
            self.assertFalse(main.check_ws_token(cookie[:-1] + replacement))

        with patch.object(main.time, "time", return_value=1_800_000_000 + main.SESSION_MAX_AGE + 1):
            self.assertFalse(main.check_ws_token(cookie))

    def test_missing_or_invalid_auth_is_rejected(self):
        requests = (
            FakeRequest(),
            FakeRequest(headers={"authorization": "Bearer wrong-token"}),
            FakeRequest(cookies={main.AUTH_COOKIE: "invalid"}),
        )
        for request in requests:
            with self.assertRaises(HTTPException) as raised:
                main.require_auth(request)
            self.assertEqual(raised.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main()
