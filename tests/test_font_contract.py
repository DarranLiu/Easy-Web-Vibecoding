from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
APP_JS = (ROOT / "frontend" / "app.js").read_text()
INDEX_HTML = (ROOT / "frontend" / "index.html").read_text()
STYLE_CSS = (ROOT / "frontend" / "style.css").read_text()
FONT_DIR = ROOT / "frontend" / "vendor" / "fonts"


class FontContractTests(unittest.TestCase):
    def test_terminal_fonts_are_self_hosted(self):
        self.assertGreater((FONT_DIR / "DejaVuSansMono.ttf").stat().st_size, 100_000)
        self.assertGreater((FONT_DIR / "DejaVuSans.ttf").stat().st_size, 100_000)
        self.assertTrue((FONT_DIR / "DejaVu-LICENSE.txt").is_file())
        self.assertIn('font-family: "CC Terminal Mono"', STYLE_CSS)
        self.assertIn('font-family: "CC Terminal Symbols"', STYLE_CSS)
        self.assertIn('/vendor/fonts/DejaVuSansMono.ttf?v=1', INDEX_HTML)

    def test_xterm_uses_cross_platform_font_fallbacks(self):
        self.assertIn("TERMINAL_FONT_FAMILY", APP_JS)
        self.assertIn('"Cascadia Mono"', APP_JS)
        self.assertIn('"Segoe UI Symbol"', APP_JS)
        self.assertIn("customGlyphs: true", APP_JS)
        self.assertIn("rescaleOverlappingGlyphs: true", APP_JS)


if __name__ == "__main__":
    unittest.main()
