import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import codex_usage


class CodexUsageTests(unittest.TestCase):
    def test_normalizes_only_default_codex_window_without_account_metadata(self):
        raw = {
            "rateLimits": {
                "limitId": "codex",
                "primary": {"usedPercent": 25, "windowDurationMins": 10080, "resetsAt": 1789293887},
            },
            "rateLimitsByLimitId": {
                "codex": {
                    "limitId": "codex",
                    "primary": {"usedPercent": 25, "windowDurationMins": 10080, "resetsAt": 1789293887},
                },
                "spark": {
                    "limitId": "spark",
                    "limitName": "Codex Spark",
                    "primary": {"usedPercent": 10.5, "windowDurationMins": 300, "resetsAt": 1788770485},
                    "secondary": {"usedPercent": 2, "windowDurationMins": 10080, "resetsAt": 1789357285},
                },
            },
            "accountId": "must-not-leak",
        }

        result = codex_usage._normalize_rate_limits(raw)

        self.assertEqual(result["window"]["remainingPercent"], 75.0)
        self.assertEqual(result["window"]["windowDurationMins"], 10080)
        self.assertNotIn("groups", result)
        self.assertNotIn("accountId", result)

    def test_rejects_response_without_usable_windows(self):
        with self.assertRaises(codex_usage.CodexUsageError):
            codex_usage._normalize_rate_limits({"rateLimits": {"limitId": "codex"}})

    def test_shared_cache_prevents_repeated_codex_queries(self):
        raw = {
            "rateLimits": {
                "limitId": "codex",
                "primary": {"usedPercent": 25, "windowDurationMins": 10080, "resetsAt": 1789293887},
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "usage.json"
            lock = Path(directory) / "usage.lock"
            with patch.object(codex_usage, "_CACHE_PATH", cache), patch.object(
                codex_usage, "_LOCK_PATH", lock
            ), patch.object(codex_usage, "_query_rate_limits", return_value=raw) as query, patch.object(
                codex_usage.time, "time", side_effect=[1000, 1001, 1002, 1500]
            ):
                first = codex_usage.get_usage("codex")
                second = codex_usage.get_usage("codex")

        self.assertEqual(first["window"], second["window"])
        self.assertEqual(first["nextRefreshAt"], 1602)
        self.assertEqual(second["nextRefreshAt"], 1602)
        self.assertEqual(query.call_count, 1)


if __name__ == "__main__":
    unittest.main()
