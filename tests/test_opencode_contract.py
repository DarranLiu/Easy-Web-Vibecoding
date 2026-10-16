from pathlib import Path
import unittest

from backend import main


ROOT = Path(__file__).resolve().parents[1]
APP_JS = (ROOT / "frontend" / "app.js").read_text()
INDEX_HTML = (ROOT / "frontend" / "index.html").read_text()


class OpenCodeContractTests(unittest.TestCase):
    def test_backend_exposes_and_launches_opencode(self):
        self.assertTrue(hasattr(main.config, "OPENCODE_BIN"))
        self.assertTrue(hasattr(main.config, "OPENCODE_OK"))
        self.assertTrue(main.config.OPENCODE_OK)
        command = main._launch_cmd("opencode", "new")
        self.assertIn('alias opencode=_cc_web_opencode', command)
        self.assertTrue(command.endswith('_cc_web_opencode --port 0 --hostname 127.0.0.1'))
        with self.assertRaises(ValueError):
            main._launch_cmd("unknown-agent", "new")

    def test_frontend_offers_opencode_when_available(self):
        self.assertIn('id="mode-opencode"', INDEX_HTML)
        self.assertIn('data-type="opencode"', INDEX_HTML)
        self.assertIn('state.types.opencode === true', APP_JS)
        self.assertIn('ty === "opencode" ? "OpenCode"', APP_JS)


if __name__ == "__main__":
    unittest.main()
