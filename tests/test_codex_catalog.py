from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from backend import codex_catalog as catalog, config, terminal_launch


class CodexCatalogTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="webcc-catalog-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.exports = self.root / "exports.jsonl"
        self.env = {"HOME": str(self.root / "home"), "CODEX_HOME": str(self.root / "account"),
                    "CC_WEB_AGENT_UPDATE_DIR": str(self.root / "updates"),
                    "CC_WEB_CODEX_MODEL_CATALOG": "auto", "CC_WEB_CODEX_CATALOG_MODE": "auto"}
        self.binary = self.native("v1", ["model-one"])

    def native(self, name, slugs):
        path = self.root / name
        path.write_text(f'''#!{sys.executable}
import json, os, sys, time
if "--bundled" in sys.argv:
    with open({str(self.exports)!r}, "a") as stream:
        stream.write(json.dumps({{"argv": sys.argv[1:], "env": dict(os.environ), "cwd": os.getcwd()}}) + "\\n")
    print(json.dumps({{"models": [{{"slug": slug}} for slug in {slugs!r}]}}))
else:
    print(json.dumps({{"args": sys.argv[1:], "env": {{k:v for k,v in os.environ.items() if k.startswith("CC_WEB_CODEX_")}}}}))
''')
        path.chmod(0o700)
        return str(path)

    def prepare(self, args=(), binary=None, env=None):
        return catalog.prepare(binary or self.binary, list(args), self.env if env is None else env)

    def models(self, env):
        return json.loads(Path(env["CC_WEB_CODEX_MODEL_CATALOG"]).read_text())["models"]

    def calls(self):
        return [json.loads(line) for line in self.exports.read_text().splitlines()] if self.exports.exists() else []

    def test_catalog_tracks_shared_symlink_and_saved_version_separately(self):
        current = self.root / "current"
        current.symlink_to(self.binary)
        first, args, env = self.prepare(["resume", "original-id"], str(current))
        self.assertEqual(first, self.binary)
        self.assertEqual(args, ["resume", "original-id"])
        second = self.native("v2", ["model-one", "model-two"])
        current.unlink()
        current.symlink_to(second)
        resolved, _, new = self.prepare(binary=str(current))
        self.assertEqual(resolved, second)
        self.assertNotEqual(new["CC_WEB_CODEX_MODEL_CATALOG"], env["CC_WEB_CODEX_MODEL_CATALOG"])
        self.assertEqual(len(self.models(new)), 2)
        _, _, saved = self.prepare(binary=self.binary)
        self.assertEqual(saved["CC_WEB_CODEX_MODEL_CATALOG"], env["CC_WEB_CODEX_MODEL_CATALOG"])
        self.assertEqual(len(self.models(saved)), 1)
        self.assertEqual(len(self.calls()), 2)

    def test_same_binary_exports_once_across_concurrent_launches(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.prepare(), range(12)))
        self.assertEqual(len({result[2]["CC_WEB_CODEX_MODEL_CATALOG"] for result in results}), 1)
        self.assertEqual(len(self.calls()), 1)

    def test_export_never_loads_account_environment_or_current_project(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "not-a-real-secret", "CODEX_HOME": "/private/account"}):
            self.prepare()
        call = self.calls()[0]
        self.assertEqual(call["argv"], ["--no-daemon", "debug", "models", "--bundled"])
        self.assertNotIn("OPENAI_API_KEY", call["env"])
        self.assertEqual(call["env"]["HOME"], call["env"]["CODEX_HOME"])
        self.assertEqual(call["env"]["HOME"], call["cwd"])
        self.assertNotEqual(call["env"]["HOME"], self.env["HOME"])

    def test_legacy_shell_and_resume_flags_migrate_without_provider_or_permission_changes(self):
        old = str(Path(self.env["CODEX_HOME"]) / "catalogs/models-current.json")
        env = {k: v for k, v in self.env.items() if k != "CC_WEB_CODEX_CATALOG_MODE"}
        env["CC_WEB_CODEX_MODEL_CATALOG"] = old
        extras = ["--sandbox", "danger-full-access", "--ask-for-approval", "never",
                  "-c", 'model_provider="user-provider"', "--model", "chosen-model"]
        for option in (["-c", "model_catalog_json=" + json.dumps(old)],
                       ["--config", "model_catalog_json = " + json.dumps(old)],
                       ["--config=model_catalog_json=" + json.dumps(old)],
                       ["-cmodel_catalog_json=" + json.dumps(old)]):
            _, args, result = self.prepare(["resume", "original-id", *option, *extras], env=env)
            self.assertEqual(args, ["resume", "original-id", *extras])
            self.assertEqual(result["CC_WEB_CODEX_CATALOG_MODE"], "auto")
            self.assertNotEqual(result["CC_WEB_CODEX_MODEL_CATALOG"], old)
        self.assertEqual(len(self.calls()), 1)

    def test_cached_generated_flag_is_replaced_on_upgrade_not_replayed_from_history(self):
        _, _, env = self.prepare()
        next_binary = self.native("next", ["model-new"])
        args = ["resume", "original-id", "-c", "model_catalog_json=" + json.dumps(env["CC_WEB_CODEX_MODEL_CATALOG"])]
        _, clean, new = self.prepare(args, binary=next_binary, env=env)
        self.assertEqual(clean, ["resume", "original-id"])
        self.assertEqual(self.models(new), [{"slug": "model-new"}])

    def test_explicit_custom_catalogs_and_native_optout_are_preserved(self):
        legacy = str(Path(self.env["CODEX_HOME"]) / "catalogs/models-current.json")
        for value, mode in (("/user/custom.json", "custom"), (legacy, "custom"), ("", "native")):
            env = {**self.env, "CC_WEB_CODEX_MODEL_CATALOG": value, "CC_WEB_CODEX_CATALOG_MODE": mode}
            _, args, result = self.prepare(["resume", "original-id"], env=env)
            self.assertEqual(args, ["resume", "original-id"])
            self.assertEqual(result["CC_WEB_CODEX_MODEL_CATALOG"], value)
        self.assertEqual(self.calls(), [])

    def test_explicit_cli_custom_catalog_wins_and_literal_prompt_is_untouched(self):
        for value in ('"/user/custom.json"', "'/user/custom.json'"):
            args = ["resume", "original-id", "-c", "model_catalog_json=" + value]
            _, clean, env = self.prepare(args)
            self.assertEqual(clean, args)
            self.assertEqual(env["CC_WEB_CODEX_MODEL_CATALOG"], "")
        self.assertEqual(self.calls(), [])
        args = ["--", "-c", 'model_catalog_json="literal prompt"']
        self.assertEqual(self.prepare(args)[1], args)

    def test_native_mode_removes_known_auto_generated_flags_only(self):
        env = {**self.env, "CC_WEB_CODEX_MODEL_CATALOG": "", "CC_WEB_CODEX_CATALOG_MODE": "native"}
        args = ["resume", "id", "-c", "model_catalog_json=" + json.dumps(str(Path(env["CODEX_HOME"]) / "catalogs/models-current.json"))]
        self.assertEqual(self.prepare(args, env=env)[1], ["resume", "id"])
        self.assertEqual(self.calls(), [])

    def test_corrupt_or_symlink_cache_is_rebuilt_without_touching_other_files(self):
        _, _, env = self.prepare()
        target = Path(env["CC_WEB_CODEX_MODEL_CATALOG"])
        target.write_text('{"models": [{"slug": "corrupt"}]}')
        self.prepare()
        self.assertEqual(self.models(env), [{"slug": "model-one"}])
        victim = self.root / "untouched"
        victim.write_text("private data")
        target.unlink()
        target.symlink_to(victim)
        self.prepare()
        self.assertFalse(target.is_symlink())
        self.assertEqual(victim.read_text(), "private data")
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(target.parent.stat().st_mode & 0o777, 0o700)

    def test_failed_export_uses_native_discovery_and_backoff_not_a_stale_catalog(self):
        for failure in (ValueError("private-path"), subprocess.TimeoutExpired("private-command", 8)):
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as directory:
                env = {**self.env, "CC_WEB_AGENT_UPDATE_DIR": directory}
                stderr = io.StringIO()
                with patch.object(catalog, "_export", side_effect=failure) as export, redirect_stderr(stderr):
                    self.assertEqual(self.prepare(env=env)[2]["CC_WEB_CODEX_MODEL_CATALOG"], "")
                    self.prepare(env=env)
                    export.assert_called_once()
                self.assertNotIn("private-", stderr.getvalue())

    def test_empty_invalid_or_oversize_catalog_is_not_activated(self):
        for value in (b'{}', b'{"models": []}', b'{"models": [null]}', b'{"models": [{"slug": "a"}, {"slug": "a"}]}', b'x' * 1025):
            with self.subTest(value=value[:20]), tempfile.TemporaryDirectory() as directory:
                def export(binary, path):
                    Path(path).write_bytes(value)
                with patch.object(catalog, "MAX_BYTES", 1024), patch.object(catalog, "_export", side_effect=export), redirect_stderr(io.StringIO()):
                    result = self.prepare(env={**self.env, "CC_WEB_AGENT_UPDATE_DIR": directory})
                self.assertEqual(result[2]["CC_WEB_CODEX_MODEL_CATALOG"], "")

    def test_busy_export_lock_does_not_stall_other_terminal_launches(self):
        identity = catalog._identity(self.binary)
        key = catalog.hashlib.sha256(json.dumps(identity).encode()).hexdigest()
        root = catalog.sessions.runtime_dir(catalog._root(self.env))
        with catalog.sessions.lock(key, "catalog", root), patch.object(catalog, "LOCK_SECONDS", .03):
            started = time.monotonic()
            self.assertEqual(self.prepare()[2]["CC_WEB_CODEX_MODEL_CATALOG"], "")
            self.assertLess(time.monotonic() - started, .5)
        self.assertEqual(self.calls(), [])

    def test_binary_change_during_export_never_pairs_wrong_program_and_catalog(self):
        def replace(binary, output):
            Path(binary).write_text("changed program")
            Path(output).write_text('{"models": [{"slug": "bad-pair"}]}')
        with patch.object(catalog, "_export", side_effect=replace), redirect_stderr(io.StringIO()):
            with self.assertRaises(RuntimeError):
                self.prepare()

    def test_guarded_launcher_migrates_an_already_open_legacy_shell(self):
        env = {**os.environ, **self.env, "CC_WEB_REAL_CODEX": self.binary, "CC_WEB_SHARED_CODEX": self.binary,
               "CC_WEB_SESSION_ID": "", "CC_WEB_RESTART_PLAN": "", "CC_WEB_CODEX_STATUS_ITEMS": "[]"}
        env.pop("CC_WEB_CODEX_CATALOG_MODE", None)
        old = str(Path(self.env["CODEX_HOME"]) / "catalogs/models-current.json")
        env["CC_WEB_CODEX_MODEL_CATALOG"] = old
        extra = ["resume", "same-session", "-c", "model_catalog_json=" + json.dumps(old),
                 "--sandbox", "workspace-write", "--ask-for-approval", "on-request"]
        command = [sys.executable, str(Path(terminal_launch.__file__).resolve()), "codex", *extra]
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=12)
        self.assertEqual(result.returncode, 0, result.stderr)
        call = json.loads(result.stdout)
        self.assertIn("--no-daemon", call["args"])
        self.assertNotIn("model_catalog_json=" + json.dumps(old), call["args"])
        self.assertEqual(call["args"][-6:], ["resume", "same-session", "--sandbox", "workspace-write", "--ask-for-approval", "on-request"])
        self.assertEqual(len(self.models(call["env"])), 1)
        again = subprocess.run(command, env=env, capture_output=True, text=True, timeout=12)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(json.loads(again.stdout)["args"], call["args"])
        self.assertEqual(len(self.calls()), 1)

    def test_auto_policy_is_not_sent_as_a_literal_filename(self):
        args = terminal_launch.guarded_arguments("codex", ["resume", "id"], self.env)
        self.assertFalse(any("model_catalog_json" in arg for arg in args))
        with patch.object(config, "CODEX_MODEL_CATALOG", "auto"), patch.object(config, "TERMINAL_LAUNCHER_DIR", self.root / "launchers"):
            env = terminal_launch.session_environment()
        self.assertEqual(env["CC_WEB_CODEX_CATALOG_MODE"], "auto")
        self.assertEqual(env["CC_WEB_CODEX_MODEL_CATALOG"], "auto")


if __name__ == "__main__":
    unittest.main()
