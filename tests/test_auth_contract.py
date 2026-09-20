import unittest

from backend import main


class FakeRequest:
    def __init__(self, headers=None, query_params=None, cookies=None):
        self.headers = headers or {}
        self.query_params = query_params or {}
        self.cookies = cookies or {}


class AuthContractTests(unittest.TestCase):
    def test_extract_token_accepts_http_only_cookie(self):
        request = FakeRequest(cookies={"cc_web_token": "from-cookie"})

        self.assertEqual(main._extract_token(request), "from-cookie")

    def test_extract_token_prefers_authorization_then_cookie(self):
        request = FakeRequest(
            headers={"authorization": "Bearer from-header"},
            cookies={"cc_web_token": "from-cookie"},
        )

        self.assertEqual(main._extract_token(request), "from-header")

        request.headers = {}
        self.assertEqual(main._extract_token(request), "from-cookie")

        request.cookies = {}
        self.assertEqual(main._extract_token(request), "")

    def test_websocket_auth_accepts_cookie_token_without_query_token(self):
        self.assertTrue(main.check_ws_token(main.config.TOKEN))
        self.assertFalse(main.check_ws_token("wrong-token"))


if __name__ == "__main__":
    unittest.main()
