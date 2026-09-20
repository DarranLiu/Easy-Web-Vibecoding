import json
import shlex
import unittest
from unittest.mock import patch

from backend import main


class CodexContractTests(unittest.TestCase):
    def test_codex_launch_uses_current_local_model_catalog(self):
        catalog = "/tmp/codex catalogs/models-current.json"
        expected = shlex.join([
            main.config.CODEX_BIN,
            "-c",
            f"model_catalog_json={json.dumps(catalog)}",
            "-c",
            'tui.status_line=["weekly-limit","context-remaining"]',
        ])

        with patch.object(main.config, "CODEX_MODEL_CATALOG", catalog), patch.object(
            main.config, "CODEX_STATUS_LINE", ["weekly-limit", "context-remaining"]
        ):
            self.assertEqual(main._launch_cmd("codex", "new"), expected)

    def test_codex_launch_falls_back_when_catalog_is_unavailable(self):
        with patch.object(main.config, "CODEX_MODEL_CATALOG", ""), patch.object(
            main.config, "CODEX_STATUS_LINE", []
        ):
            self.assertEqual(
                main._launch_cmd("codex", "new"),
                shlex.join([main.config.CODEX_BIN]),
            )

    def test_web_codex_status_leaves_quota_windows_to_multiline_shelf(self):
        self.assertEqual(
            main.config.CODEX_STATUS_LINE,
            ["model-with-reasoning", "run-state", "context-remaining"],
        )


if __name__ == "__main__":
    unittest.main()
