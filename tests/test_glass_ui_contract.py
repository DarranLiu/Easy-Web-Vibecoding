from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
HTML = (FRONTEND / "index.html").read_text()
CSS = (FRONTEND / "glass.css").read_text()
JS = (FRONTEND / "app.js").read_text()


class GlassUiContractTests(unittest.TestCase):
    def test_glass_layer_is_separate_and_versioned(self):
        self.assertRegex(HTML, r'/glass\.css\?v=\d+')
        self.assertLess(HTML.index('/style.css?v='), HTML.index('/glass.css?v='))
        self.assertIn('[data-theme="dark"]', CSS)
        self.assertIn('[data-theme="light"]', CSS)
        self.assertIn('letter-spacing: 0', CSS)

    def test_assets_are_local_and_include_their_licenses(self):
        self.assertIn('/vendor/lucide.min.js?v=1.49.0', HTML)
        self.assertLess(HTML.index('/vendor/lucide.min.js'), HTML.index('/app.js?v='))
        self.assertLess(HTML.index('/app.js?v='), HTML.index('/updates.js?v='))
        self.assertGreater((FRONTEND / 'vendor/lucide.min.js').stat().st_size, 10000)
        self.assertIn('ISC License', (FRONTEND / 'vendor/lucide-LICENSE.txt').read_text())
        self.assertGreater((FRONTEND / 'vendor/fonts/InterVariable-latin.woff2').stat().st_size, 10000)
        self.assertIn('SIL OPEN FONT LICENSE', (FRONTEND / 'vendor/fonts/Inter-LICENSE.txt').read_text())
        self.assertGreater((FRONTEND / 'vendor/fonts/JetBrainsMonoVariable-latin.woff2').stat().st_size, 10000)
        self.assertIn('SIL OPEN FONT LICENSE', (FRONTEND / 'vendor/fonts/JetBrainsMono-LICENSE.txt').read_text())
        self.assertNotRegex(CSS, r'url\([\s\x22\x27]*https?://')
        self.assertNotRegex(HTML, r'(?:src|href)="https?://')

    def test_terminal_padding_and_drag_handle_updates_are_safe(self):
        self.assertRegex(CSS, r'\.pane-host\s*\{[^}]*box-sizing:\s*content-box')
        refit = re.search(r'function refitAll\(\)\s*\{(.*?)\n\}', JS, re.S).group(1)
        self.assertIn('renderGutters()', refit)
        self.assertIn('!document.body.classList.contains("gutter-dragging")', refit)

    def test_accessibility_and_rendering_fallbacks_are_retained(self):
        for feature in ['forced-colors: active', 'prefers-reduced-motion: reduce',
                        'prefers-reduced-transparency: reduce', '@supports not', 'any-pointer: coarse']:
            self.assertIn(feature, CSS)
        self.assertIn('"aria-hidden": "true"', JS)
        self.assertIn('if (!svg) return;', JS)
        self.assertIn('TERMINAL_FONT_FAMILY', JS)
        self.assertIn('minimumContrastRatio: 4.5', JS)


if __name__ == '__main__':
    unittest.main()
