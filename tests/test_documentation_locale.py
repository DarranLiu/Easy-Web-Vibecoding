import unittest
from pathlib import Path


SCREENSHOTS = (
    "codex-usage.png",
    "connections.png",
    "copy-text.png",
    "desktop-split.png",
    "file-preview.png",
    "files.png",
    "mobile-terminal.png",
    "new-terminal.png",
    "resources-gpu.png",
    "resources-storage.png",
    "send-image.png",
)


class DocumentationLocaleTests(unittest.TestCase):
    def test_readmes_use_their_matching_screenshot_locale(self):
        english = Path("README.md").read_text(encoding="utf-8")
        chinese = Path("README.zh-CN.md").read_text(encoding="utf-8")

        for name in SCREENSHOTS:
            english_path = Path("docs/images/en") / name
            chinese_path = Path("docs/images") / name

            self.assertTrue(english_path.is_file(), english_path)
            self.assertTrue(chinese_path.is_file(), chinese_path)
            self.assertIn(english_path.as_posix(), english)
            self.assertNotIn(english_path.as_posix(), chinese)
            self.assertIn(chinese_path.as_posix(), chinese)
            self.assertNotEqual(english_path.read_bytes(), chinese_path.read_bytes(), name)


if __name__ == "__main__":
    unittest.main()
