from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
APP_JS = (ROOT / "frontend" / "app.js").read_text()
INDEX_HTML = (ROOT / "frontend" / "index.html").read_text()
STYLE_CSS = (ROOT / "frontend" / "style.css").read_text()


class FrontendContractTests(unittest.TestCase):
    def test_frontend_does_not_put_auth_token_in_urls(self):
        self.assertNotIn("token=", APP_JS)

    def test_login_uses_cookie_session_endpoint_without_reload(self):
        self.assertIn('/api/login', APP_JS)
        self.assertIn("credentials: \"same-origin\"", APP_JS)
        self.assertNotIn("location.reload()", APP_JS)

    def test_stop_action_requires_confirmation(self):
        self.assertIn("requestStop", APP_JS)
        stop_handler = re.search(r"btn-stop.*?onclick\s*=\s*\(\)\s*=>\s*\{(?P<body>.*?)\};", APP_JS, re.S)
        self.assertIsNotNone(stop_handler)
        self.assertIn("requestStop", stop_handler.group("body"))

    def test_directory_picker_has_search_and_clickable_segments(self):
        self.assertIn('id="dir-search"', INDEX_HTML)
        self.assertIn("renderCrumbs", APP_JS)
        self.assertIn("filterDirEntries", APP_JS)

    def test_login_overlay_covers_entire_viewport(self):
        login_rule = re.search(r"\.login\s*\{(?P<body>.*?)\n\}", STYLE_CSS, re.S)
        self.assertIsNotNone(login_rule)
        body = login_rule.group("body")
        self.assertIn("min-height: 100dvh", body)
        self.assertIn("overflow: hidden", body)

    def test_sidebar_uses_toolbar_not_full_width_web_buttons(self):
        self.assertIn("sidebar-toolbar", INDEX_HTML)
        self.assertIn(".toolbar-btn", STYLE_CSS)

    def test_ios_density_font_stack_and_terminal_default_size(self):
        self.assertIn('"SF Pro Display"', STYLE_CSS)
        self.assertIn('"PingFang SC"', STYLE_CSS)
        self.assertRegex(STYLE_CSS, r"body\s*\{[^}]*font-size:\s*12\.5px")
        self.assertIn("n = mqMobile.matches ? 11 : 12", APP_JS)

    def test_terminal_wheel_scrolls_terminal_history_not_app_mouse_history(self):
        self.assertIn("attachTerminalWheelHandler", APP_JS)
        self.assertIn("attachCustomWheelEventHandler", APP_JS)
        self.assertIn('type: "scroll"', APP_JS)
        self.assertIn("tmux copy-mode", APP_JS)


if __name__ == "__main__":
    unittest.main()
