from pathlib import Path
import json
import unittest


ROOT = Path(__file__).resolve().parents[1]
APP_JS = (ROOT / "frontend" / "app.js").read_text()
INDEX_HTML = (ROOT / "frontend" / "index.html").read_text()
STYLE_CSS = (ROOT / "frontend" / "style.css").read_text()
MANIFEST = json.loads((ROOT / "frontend" / "manifest.webmanifest").read_text())


class FluentUiContractTests(unittest.TestCase):
    def test_versioned_assets_and_fluent_identity_are_present(self):
        self.assertIn('/style.css?v=1', INDEX_HTML)
        self.assertIn('/app.js?v=1', INDEX_HTML)
        self.assertIn('class="app-brand"', INDEX_HTML)
        self.assertNotIn('class="traffic"', INDEX_HTML)
        self.assertIn('"Segoe UI Variable Text"', STYLE_CSS)
        self.assertIn("--accent: #0f6cbd", STYLE_CSS)

    def test_responsive_and_accessibility_fallbacks_are_present(self):
        self.assertIn("@media (forced-colors: active)", STYLE_CSS)
        self.assertIn("@media (prefers-reduced-motion: reduce)", STYLE_CSS)
        self.assertIn('aria-modal="true"', INDEX_HTML)
        self.assertIn('aria-selected="true"', INDEX_HTML)
        self.assertIn("keyboardClickable", APP_JS)
        self.assertIn("aria-pressed", APP_JS)

    def test_interaction_polish_and_installable_metadata_are_present(self):
        self.assertIn("--motion-fast: 80ms", STYLE_CSS)
        self.assertIn("prefers-reduced-motion: reduce", STYLE_CSS)
        self.assertIn('id="tooltip"', INDEX_HTML)
        self.assertIn("function openLayer", APP_JS)
        self.assertIn("function closeLayer", APP_JS)
        self.assertIn("sessionLaunchBusy", APP_JS)
        self.assertEqual(MANIFEST["display"], "standalone")
        self.assertEqual(MANIFEST["name"], "CC Terminal")

    def test_codex_quota_shelf_is_compact_and_active_pane_only(self):
        self.assertIn('class="codex-usage hidden"', APP_JS)
        self.assertIn("function refreshCodexUsage", APP_JS)
        self.assertIn(".codex-usage-row", STYLE_CSS)
        self.assertIn("@container (max-width: 220px)", STYLE_CSS)
        self.assertIn("p === active", APP_JS)
        self.assertIn("10 * 60 * 1000", APP_JS)
        self.assertIn("nextRefreshAt", APP_JS)
        self.assertIn("scheduleCodexUsageRefresh", APP_JS)
        self.assertNotIn("CODEX_USAGE_MAX_AGE", APP_JS)
        self.assertNotIn("setInterval(() => refreshCodexUsage", APP_JS)
        self.assertIn('api("/api/codex/usage"', APP_JS)
        self.assertNotIn("/api/codex/usage?", APP_JS)
        self.assertNotIn("codex-usage-name", APP_JS)
        self.assertNotIn("codex-usage-window", APP_JS)


if __name__ == "__main__":
    unittest.main()
