import asyncio
from contextlib import ExitStack
import hashlib
import fcntl
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
import uuid
import urllib.error
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from backend import agent_updates as updates, agent_sessions as sessions
from backend import config, main, store, terminal_launch, terminal_restart
from backend import shared_install as shared


def binary_text(agent, version="1.2.3", compatible=True):
    prefix = "codex-cli " if agent == "codex" else ""
    flags = "--no-daemon --no-alt-screen --config -c -C --resume --settings --session --port --hostname"
    if not compatible:
        flags = "--help"
    return (f"#!{sys.executable}\nimport sys\n"
            f"print({(prefix + version)!r} if '--version' in sys.argv else {flags!r})\n")


class AgentUpdateTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix="webcc-update-test-")))
        for name, path in (("AGENT_UPDATE_DIR", self.root / "updates"), ("AGENT_RUNTIME_DIR", self.root / "sessions"),
                           ("TERMINAL_LAUNCHER_DIR", self.root / "launchers")):
            self.stack.enter_context(patch.object(config, name, path))
        for agent in updates.AGENTS:
            path = self.root / agent
            path.write_text(binary_text(agent))
            path.chmod(0o700)
            self.stack.enter_context(patch.object(config, agent.upper() + "_BIN", str(path)))
        self.catalog = {"version": "1.2.4", "checkedAt": time.time(), "attemptedAt": time.time(),
                        "checkId": str(uuid.uuid4()), "size": 100, "sha256": "0" * 64,
                        "url": "https://github.com/openai/codex/releases/download/rust-v1.2.4/package.tar.gz",
                        "archive": True, "executable": "bin/codex"}
        updates._save("codex", self.catalog, ".catalog.json")

    def body(self, **values):
        return {"requestId": str(uuid.uuid4()), "mode": "update", "confirmed": True,
                "version": self.catalog["version"], "checkId": self.catalog["checkId"], **values}

    def artifact(self, agent="codex", version="1.2.4", compatible=True):
        root = updates._root() / "releases" / (agent + "-" + uuid.uuid4().hex)
        root.mkdir(parents=True)
        binary = root / agent
        binary.write_text(binary_text(agent, version, compatible))
        binary.chmod(0o700)
        return {"path": str(binary), "version": version, "sha256": "0" * 64}

    def wait_job(self, agent="codex"):
        for _ in range(100):
            job = updates._job(agent)
            if job.get("phase") not in updates.BUSY_PHASES:
                return job
            time.sleep(.03)
        self.fail("Update worker did not finish")

    def test_numeric_versions_and_unknown_never_claim_latest(self):
        self.assertEqual(updates._comparison("1.9.9", "1.10.0"), "outdated")
        self.assertEqual(updates._comparison("1.10.0", "1.9.9"), "newer")
        self.assertEqual(updates._comparison("1.10.0", "1.10.0"), "latest")
        for value in (None, "garbage", "1.2.3-beta.1", "01.2.3"):
            self.assertEqual(updates._comparison(value, "1.2.3"), "unknown")

    def test_offline_probes_hide_account_environment(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "fake-not-a-real-key", "ANTHROPIC_API_KEY": "fake"}):
            env = updates._probe_env(str(self.root))
            self.assertNotIn("OPENAI_API_KEY", env)
            self.assertNotIn("ANTHROPIC_API_KEY", env)
            self.assertEqual(env["CODEX_HOME"], str(self.root))
            self.assertEqual(updates.installed_version("codex", str(self.root / "codex")), "1.2.3")

    def test_latest_checks_coalesce_and_do_not_expose_download_metadata(self):
        with patch.object(updates, "official_release", return_value=self.catalog) as fetch:
            updates.check_latest("codex")
            fetch.assert_not_called()
            updates._save("codex", {}, ".catalog.json")
            updates.check_latest("codex")
            updates.check_latest("codex")
            self.assertEqual(fetch.call_count, 1)
        with patch.object(updates, "running_version", return_value={"agent": "codex", "version": "1.2.2"}), \
             patch.object(store, "get_tab", return_value={"id": "fixture"}), \
             patch.object(terminal_restart, "inspect", return_value={"ready": False}):
            data = updates.overview("fixture")
            row = data["agents"][0]
            self.assertEqual(row["running"], "1.2.2")
            self.assertEqual(row["installed"], "1.2.3")
            self.assertEqual(row["runningStatus"], "outdated")
            self.assertNotIn("url", json.dumps(data))
            self.assertNotIn(str(self.root), json.dumps(data))

    def test_failed_latest_check_does_not_keep_a_false_latest_claim(self):
        updates._save("codex", {**self.catalog, "attemptedAt": 0}, ".catalog.json")
        with patch.object(updates, "official_release", side_effect=OSError("private-path-secret")):
            catalog = updates.check_latest("codex")
        self.assertNotIn("version", catalog)
        self.assertNotIn("private-path-secret", catalog["error"])

    def test_old_failed_download_is_marked_superseded_not_as_current_install_failure(self):
        updates._save("codex", {"phase": "failed", "version": "1.2.3", "installed": False,
                               "message": "Old download failed"}, ".job.json")
        self.assertTrue(updates.overview()["agents"][0]["jobSuperseded"])
        updates._save("codex", {"phase": "failed", "version": "1.2.4", "installed": False}, ".job.json")
        self.assertFalse(updates.overview()["agents"][0]["jobSuperseded"])
        updates._save("codex", {"phase": "failed", "version": "1.2.3", "installed": True}, ".job.json")
        self.assertFalse(updates.overview()["agents"][0]["jobSuperseded"])

    def test_unavailable_resume_preview_retains_agent_for_recovery_controls(self):
        with patch.object(updates, "running_version", return_value={"agent": "codex", "version": "1.2.3"}), \
             patch.object(store, "get_tab", return_value={"id": "fixture", "type": "shell"}), \
             patch.object(terminal_restart, "inspect", side_effect=terminal_restart.RestartError("Still exiting")):
            preview = updates.overview("fixture")["resume"]
        self.assertEqual(preview, {"ready": False, "agent": "codex", "reason": "Still exiting"})

    def test_official_github_metadata_requires_stable_complete_hash(self):
        name = "codex-package-x86_64-unknown-linux-musl.tar.gz"
        data = {"tag_name": "rust-v1.2.4", "assets": [{"name": name, "size": 10,
                "digest": "sha256:" + "a" * 64,
                "browser_download_url": "https://github.com/openai/codex/releases/download/rust-v1.2.4/" + name}]}
        with patch.object(updates, "_platform", return_value=(name, "bin/codex")), patch.object(updates, "_text", return_value=json.dumps(data)):
            self.assertEqual(updates.official_release("codex")["version"], "1.2.4")
            data["assets"][0]["digest"] = None
        with patch.object(updates, "_platform", return_value=(name, "bin/codex")), patch.object(updates, "_text", return_value=json.dumps(data)):
            with self.assertRaises(updates.UpdateError):
                updates.official_release("codex")
        data["prerelease"] = True
        with patch.object(updates, "_platform", return_value=(name, "bin/codex")), patch.object(updates, "_text", return_value=json.dumps(data)):
            with self.assertRaises(updates.UpdateError):
                updates.official_release("codex")

    def test_official_claude_manifest_requires_matching_version(self):
        manifest = {"version": "2.1.2", "platforms": {"linux-x64": {"checksum": "a" * 64, "size": 10}}}
        with patch.object(updates, "_platform", return_value=("linux-x64", "claude")), \
             patch.object(updates, "_text", side_effect=["2.1.2", json.dumps(manifest)]):
            release = updates.official_release("claude")
            self.assertFalse(release["archive"])
            self.assertTrue(release["url"].endswith("/2.1.2/linux-x64/claude"))
        manifest["version"] = "2.1.1"
        with patch.object(updates, "_platform", return_value=("linux-x64", "claude")), \
             patch.object(updates, "_text", side_effect=["2.1.2", json.dumps(manifest)]):
            with self.assertRaises(updates.UpdateError):
                updates.official_release("claude")

    def test_untrusted_urls_and_redirects_are_refused(self):
        for url in ("http://github.com/file", "https://localhost/file", "https://github.com:8080/file",
                    "https://github.com.evil.invalid/file", "https://token@github.com/file"):
            with self.assertRaises(updates.UpdateError):
                updates._url(url)

    def test_bad_requests_and_expired_checks_never_start_a_worker(self):
        for body in ([], {}, self.body(confirmed=False), self.body(requestId="bad"), self.body(checkId="stale")):
            with self.subTest(body=body), patch.object(updates.threading, "Thread") as worker:
                with self.assertRaises(updates.UpdateError):
                    updates.start_update("codex", body)
                worker.assert_not_called()

    def test_install_is_shared_idempotent_and_does_not_restart(self):
        entry = self.artifact()
        body = self.body()
        with patch.object(updates, "_stage", return_value=entry), patch.object(terminal_restart, "restart") as restart:
            updates.start_update("codex", body)
            job = self.wait_job()
            self.assertEqual(job["phase"], "done")
            self.assertTrue(job["installed"])
            self.assertFalse(job["resumed"])
            repeat = updates.start_update("codex", body)
            self.assertEqual(repeat["requestId"], body["requestId"])
            restart.assert_not_called()
        self.assertEqual(updates.selected_binary("codex", str(self.root / "codex")), str(self.root / "codex"))
        self.assertEqual(updates.installed_version("codex", str(self.root / "codex")), "1.2.4")
        self.assertEqual(subprocess.check_output([str(self.root / "codex"), "--version"], text=True).strip(), "codex-cli 1.2.4")
        self.assertEqual(updates._root().stat().st_mode & 0o777, 0o700)
        self.assertEqual((updates._root() / "codex.active.json").stat().st_mode & 0o777, 0o600)

    def test_update_lock_is_shared_and_duplicates_return_the_same_job(self):
        body = self.body()
        with sessions.lock("codex", "update", root=updates._root(), blocking=False):
            updates._save("codex", {"requestId": body["requestId"], "phase": "downloading", "signature": updates._signature("codex", body)}, ".job.json")
            self.assertEqual(updates.start_update("codex", body)["requestId"], body["requestId"])
            with self.assertRaises(updates.UpdateError):
                updates.start_update("codex", self.body())
            self.assertEqual(updates._job("codex")["phase"], "downloading")
        self.assertEqual(updates._job("codex")["phase"], "interrupted")

    def test_missing_flags_or_download_failure_keep_original_install(self):
        for failure in (updates.UpdateError("下载失败"), None):
            updates._save("codex", {}, ".job.json")
            entry = self.artifact(compatible=False)
            with patch.object(updates, "_stage", side_effect=failure, return_value=entry), \
                 patch.object(terminal_restart, "restart") as restart:
                updates.start_update("codex", self.body())
                self.assertEqual(self.wait_job()["phase"], "failed")
                self.assertFalse(updates._load("codex", ".active.json"))
                restart.assert_not_called()

    def test_changed_conversation_during_download_cancels_before_activation(self):
        preview = {"ready": True, "agent": "codex", "expected": "original"}
        body = self.body(mode="update-restart", sid="fixture", expected="original")
        entry = self.artifact()
        with patch.object(store, "get_tab", return_value={"id": "fixture"}), \
             patch.object(terminal_restart, "inspect", side_effect=[preview, {**preview, "expected": "changed"}]), \
             patch.object(updates, "_stage", return_value=entry), patch.object(terminal_restart, "restart") as restart:
            updates.start_update("codex", body)
            self.assertEqual(self.wait_job()["phase"], "failed")
            self.assertFalse(updates._load("codex", ".active.json"))
            restart.assert_not_called()

    def test_update_and_restore_keeps_captured_target_and_exact_challenge(self):
        preview = {"ready": True, "agent": "codex", "expected": "original"}
        body = self.body(mode="update-restart", sid="fixture", expected="original")
        entry = self.artifact()
        with patch.object(store, "get_tab", return_value={"id": "fixture"}), \
             patch.object(terminal_restart, "inspect", return_value=preview), \
             patch.object(updates, "_stage", return_value=entry), patch.object(updates, "_validate"), \
             patch.object(terminal_restart, "restart", return_value={"id": "fixture", "resumed": True}) as restart:
            updates.start_update("codex", body)
            job = self.wait_job()
            self.assertTrue(job["resumed"])
            self.assertEqual(restart.call_args.args[0], "fixture")
            self.assertEqual(restart.call_args.args[2]["expected"], "original")
            self.assertEqual(restart.call_count, 1)

    def test_restore_failure_distinguishes_installed_from_resumed(self):
        preview = {"ready": True, "agent": "codex", "expected": "original"}
        entry = self.artifact()
        with patch.object(store, "get_tab", return_value={"id": "fixture"}), \
             patch.object(terminal_restart, "inspect", return_value=preview), \
             patch.object(updates, "_stage", return_value=entry), patch.object(updates, "_validate"), \
             patch.object(terminal_restart, "restart", side_effect=terminal_restart.RestartError("退出未完成")):
            updates.start_update("codex", self.body(mode="update-restart", sid="fixture", expected="original"))
            job = self.wait_job()
            self.assertEqual(job["phase"], "failed")
            self.assertTrue(job["installed"])
            self.assertFalse(job["resumed"])

    def test_rollback_does_not_touch_running_tasks(self):
        entry = self.artifact()
        with patch.object(updates, "_stage", return_value=entry):
            updates.start_update("codex", self.body())
            self.assertEqual(self.wait_job()["phase"], "done")
        with patch.object(terminal_restart, "restart") as restart:
            updates.rollback("codex", {"confirmed": True, "version": "1.2.4", "selectionId": updates.selection_id(updates._load("codex", ".active.json"))})
            restart.assert_not_called()
        self.assertEqual(updates.selected_binary("codex", str(self.root / "codex")), str(self.root / "codex"))
        self.assertEqual(updates._load("codex", ".active.json")["previous"]["version"], "1.2.4")
        self.assertEqual(updates.installed_version("codex", str(self.root / "codex")), "1.2.3")

    def test_rollback_can_recover_broken_current_artifact_and_rejects_stale_selection(self):
        entry = self.artifact()
        with patch.object(updates, "_stage", return_value=entry):
            updates.start_update("codex", self.body())
            self.assertEqual(self.wait_job()["phase"], "done")
        selection = updates.selection_id(updates._load("codex", ".active.json"))
        Path(entry["path"]).unlink()
        overview = updates.overview()
        self.assertIsNone(overview["agents"][0]["installed"])
        self.assertTrue(overview["agents"][0]["canRollback"])
        updates.rollback("codex", {"confirmed": True, "selectionId": selection})
        with self.assertRaises(updates.UpdateError):
            updates.rollback("codex", {"confirmed": True, "selectionId": selection})

    def test_persisted_request_id_cannot_be_reused_for_another_action(self):
        body = self.body()
        entry = self.artifact()
        with patch.object(updates, "_stage", return_value=entry):
            updates.start_update("codex", body)
            self.wait_job()
        updates._save("codex", {}, ".job.json")
        self.assertEqual(updates.start_update("codex", body)["requestId"], body["requestId"])
        with self.assertRaises(updates.UpdateError):
            updates.start_update("codex", {**body, "mode": "update-restart", "sid": "another"})

    def test_host_upgrade_during_download_cancels_web_activation(self):
        entry = self.artifact()
        def stage(*args):
            (self.root / "codex").write_text(binary_text("codex", "1.2.5"))
            return entry
        with patch.object(updates, "_stage", side_effect=stage):
            updates.start_update("codex", self.body())
            job = self.wait_job()
        self.assertEqual(job["phase"], "failed")
        self.assertFalse(updates._load("codex", ".active.json"))

    def test_legacy_metadata_is_not_a_second_executable_selector(self):
        (updates._root() / "codex.active.json").write_text("{")
        self.assertEqual(updates.selected_binary("codex", str(self.root / "codex")), str(self.root / "codex"))

    def test_old_managed_metadata_cannot_override_shared_entry(self):
        updates._save("codex", {"path": str(self.root / "outside"), "version": "1.2.4"}, ".active.json")
        self.assertEqual(updates.selected_binary("codex", str(self.root / "codex")), str(self.root / "codex"))
        with self.assertRaises(updates.UpdateError):
            updates.selected_binary("codex", str(self.root / "missing"))

    def test_old_web_shell_reads_new_selection_without_pinning_or_restarting(self):
        env = {**os.environ, **terminal_launch.session_environment()}
        # A legacy parent shell can retain a different HOME and no new env var.
        env.pop("CC_WEB_AGENT_UPDATE_DIR")
        env["HOME"] = str(self.root / "another-home")
        self.assertEqual(subprocess.check_output([str(config.TERMINAL_LAUNCHER_DIR / "codex"), "--version"], env=env, text=True).strip(), "codex-cli 1.2.3")
        entry = self.artifact()
        with patch.object(updates, "_stage", return_value=entry):
            updates.start_update("codex", self.body())
            self.assertEqual(self.wait_job()["phase"], "done")
        self.assertEqual(subprocess.check_output([str(config.TERMINAL_LAUNCHER_DIR / "codex"), "--version"], env=env, text=True).strip(), "codex-cli 1.2.4")
        updates.rollback("codex", {"confirmed": True, "version": "1.2.4", "selectionId": updates.selection_id(updates._load("codex", ".active.json"))})
        self.assertEqual(subprocess.check_output([str(config.TERMINAL_LAUNCHER_DIR / "codex"), "--version"], env=env, text=True).strip(), "codex-cli 1.2.3")

    def native_codex(self):
        root = self.root / "native" / "standalone"
        old = root / "releases" / "1.2.3-x86_64-unknown-linux-musl"
        (old / "bin").mkdir(parents=True)
        shutil.copy2(self.root / "codex", old / "bin/codex")
        (root / "current").symlink_to(old)
        (root / "auto-update-version").write_text(old.name + "\n")
        (self.root / "codex").unlink()
        (self.root / "codex").symlink_to(root / "current/bin/codex")
        source = updates._root() / "releases" / ("bundle-" + uuid.uuid4().hex)
        (source / "bin").mkdir(parents=True)
        binary = source / "bin/codex"
        binary.write_text(binary_text("codex", "1.2.4"))
        binary.chmod(0o700)
        entry = {"path": str(binary), "version": "1.2.4", "sha256": "0" * 64}
        self.catalog["url"] = "https://github.com/openai/codex/releases/download/rust-v1.2.4/codex-package-x86_64-unknown-linux-musl.tar.gz"
        updates._save("codex", self.catalog, ".catalog.json")
        return root, old, entry

    def test_native_codex_update_and_rollback_preserve_layout_channel_and_old_files(self):
        root, old, entry = self.native_codex()
        old_content = (old / "bin/codex").read_bytes()
        link = os.readlink(self.root / "codex")
        with patch.object(updates, "_stage", return_value=entry):
            updates.start_update("codex", self.body())
            self.assertEqual(self.wait_job()["phase"], "done")
        selected = root / "releases/1.2.4-x86_64-unknown-linux-musl"
        self.assertEqual((root / "current").resolve(), selected)
        self.assertEqual(os.readlink(self.root / "codex"), link)
        self.assertEqual((old / "bin/codex").read_bytes(), old_content)
        self.assertEqual((root / "auto-update-version").read_text().strip(), selected.name)
        self.assertEqual(updates.overview()["agents"][0]["installed"], "1.2.4")
        self.assertTrue(updates.overview()["agents"][0]["canRollback"])
        active = updates._load("codex", ".active.json")
        updates.rollback("codex", {"confirmed": True, "selectionId": updates.selection_id(active)})
        self.assertEqual((root / "current").resolve(), old)
        self.assertEqual((root / "auto-update-version").read_text().strip(), old.name)
        self.assertTrue((selected / "bin/codex").exists())

    def test_native_codex_installer_lock_prevents_competing_activation(self):
        root, old, entry = self.native_codex()
        with (root / "install.lock").open("wb") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(updates, "_stage", return_value=entry):
                updates.start_update("codex", self.body())
                self.assertEqual(self.wait_job()["phase"], "failed")
        self.assertEqual((root / "current").resolve(), old)
        self.assertFalse(updates._load("codex", ".active.json"))

    def test_existing_native_release_is_never_overwritten(self):
        root, old, entry = self.native_codex()
        target = root / "releases/1.2.4-x86_64-unknown-linux-musl/bin"
        target.mkdir(parents=True)
        (target / "codex").write_text("existing-program")
        with patch.object(updates, "_stage", return_value=entry):
            updates.start_update("codex", self.body())
            self.assertEqual(self.wait_job()["phase"], "failed")
        self.assertEqual((root / "current").resolve(), old)
        self.assertEqual((target / "codex").read_text(), "existing-program")

    def test_external_upgrade_is_followed_and_disables_stale_web_rollback(self):
        entry = self.artifact()
        with patch.object(updates, "_stage", return_value=entry):
            updates.start_update("codex", self.body())
            self.assertEqual(self.wait_job()["phase"], "done")
        selection = updates.selection_id(updates._load("codex", ".active.json"))
        (self.root / "codex").unlink()
        (self.root / "codex").write_text(binary_text("codex", "1.2.5"))
        (self.root / "codex").chmod(0o700)
        row = updates.overview()["agents"][0]
        self.assertEqual(row["installed"], "1.2.5")
        self.assertFalse(row["canRollback"])
        with self.assertRaises(updates.UpdateError):
            updates.rollback("codex", {"confirmed": True, "selectionId": selection})
        self.assertEqual(updates.installed_version("codex", str(self.root / "codex")), "1.2.5")

    def test_changed_configured_entry_cannot_roll_back_another_install(self):
        entry = self.artifact()
        with patch.object(updates, "_stage", return_value=entry):
            updates.start_update("codex", self.body())
            self.assertEqual(self.wait_job()["phase"], "done")
        selection = updates.selection_id(updates._load("codex", ".active.json"))
        other = self.root / "another-codex"
        other.write_text(binary_text("codex", "1.2.5"))
        other.chmod(0o700)
        with patch.object(config, "CODEX_BIN", str(other)):
            self.assertFalse(updates.overview()["agents"][0]["canRollback"])
            with self.assertRaises(updates.UpdateError):
                updates.rollback("codex", {"confirmed": True, "selectionId": selection})
        self.assertEqual(updates.installed_version("codex", str(self.root / "codex")), "1.2.4")

    def test_same_version_replacement_during_download_is_not_overwritten(self):
        entry = self.artifact()
        def stage(*args):
            (self.root / "codex").unlink()
            (self.root / "codex").write_text(binary_text("codex"))
            (self.root / "codex").chmod(0o700)
            return entry
        with patch.object(updates, "_stage", side_effect=stage):
            updates.start_update("codex", self.body())
            self.assertEqual(self.wait_job()["phase"], "failed")
        self.assertEqual(updates.installed_version("codex", str(self.root / "codex")), "1.2.3")

    def test_new_launcher_ignores_stale_parent_release(self):
        env = {**os.environ, **terminal_launch.session_environment()}
        old = self.artifact(version="1.2.2")
        env["CC_WEB_BASE_CODEX"] = env["CC_WEB_REAL_CODEX"] = old["path"]
        result = subprocess.check_output([str(config.TERMINAL_LAUNCHER_DIR / "codex"), "--version"], env=env, text=True)
        self.assertEqual(result.strip(), "codex-cli 1.2.3")

    def test_explicit_npm_entry_migration_keeps_package_and_private_backup(self):
        prefix = self.root / "node"
        package = prefix / "lib/node_modules/@openai/codex/bin/codex.js"
        package.parent.mkdir(parents=True)
        package.write_text("original npm wrapper")
        alias = prefix / "bin/codex"
        alias.parent.mkdir()
        alias.symlink_to("../lib/node_modules/@openai/codex/bin/codex.js")
        self.assertTrue(shared.redirect_npm_codex(alias, self.root / "codex", updates._root()))
        self.assertEqual(alias.resolve(), self.root / "codex")
        self.assertEqual(package.read_text(), "original npm wrapper")
        backup = sessions.load("codex-npm-entry", updates._root(), suffix=".migration.json")
        self.assertEqual(backup["target"], "../lib/node_modules/@openai/codex/bin/codex.js")
        self.assertEqual((updates._root() / "codex-npm-entry.migration.json").stat().st_mode & 0o777, 0o600)
        self.assertFalse(shared.redirect_npm_codex(alias, self.root / "codex", updates._root()))

    def test_npm_migration_never_replaces_unrecognized_entries(self):
        alias = self.root / "unrelated-codex"
        alias.symlink_to(self.root / "claude")
        with self.assertRaises(shared.SharedInstallError):
            shared.redirect_npm_codex(alias, self.root / "codex", updates._root())
        self.assertEqual(alias.resolve(), self.root / "claude")

    def test_native_claude_update_preserves_versions_and_stable_entry(self):
        versions = self.root / "native/share/claude/versions"
        versions.mkdir(parents=True)
        old = versions / "1.2.3"
        shutil.copy2(self.root / "claude", old)
        (self.root / "claude").unlink()
        (self.root / "claude").symlink_to(old)
        updates._save("claude", self.catalog, ".catalog.json")
        entry = self.artifact("claude")
        with patch.object(updates, "_stage", return_value=entry):
            updates.start_update("claude", self.body())
            self.assertEqual(self.wait_job("claude")["phase"], "done")
        self.assertEqual((self.root / "claude").resolve(), versions / "1.2.4")
        self.assertEqual(updates.installed_version("claude", str(old)), "1.2.3")
        active = updates._load("claude", ".active.json")
        updates.rollback("claude", {"confirmed": True, "selectionId": updates.selection_id(active)})
        self.assertEqual((self.root / "claude").resolve(), old)

    def test_opencode_regular_entry_is_replaced_atomically_and_can_roll_back(self):
        updates._save("opencode", self.catalog, ".catalog.json")
        entry = self.artifact("opencode")
        before = (self.root / "opencode").read_bytes()
        with (self.root / "opencode").open("rb") as running_image:
            with patch.object(updates, "_stage", return_value=entry):
                updates.start_update("opencode", self.body())
                self.assertEqual(self.wait_job("opencode")["phase"], "done")
            self.assertEqual(running_image.read(), before)
        self.assertFalse((self.root / "opencode").is_symlink())
        self.assertEqual(updates.installed_version("opencode", str(self.root / "opencode")), "1.2.4")
        active = updates._load("opencode", ".active.json")
        updates.rollback("opencode", {"confirmed": True, "selectionId": updates.selection_id(active)})
        self.assertEqual((self.root / "opencode").read_bytes(), before)

    def test_primary_official_download_falls_back_and_retries_without_losing_verification(self):
        data = b"verified official package"
        release = {**self.catalog, "url": "https://github.com/openai/codex/releases/download/rust-v1.2.4/codex-package-x86_64-unknown-linux-musl.tar.gz",
                   "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        with patch.object(updates, "_open", side_effect=[TimeoutError("private-network-detail"), io.BytesIO(data)]) as opened:
            updates._download(release, self.root / "retry-package", lambda count: None)
        self.assertTrue(opened.call_args_list[0].args[0].startswith("https://releases.openai.com/"))
        self.assertTrue(opened.call_args_list[1].args[0].startswith("https://github.com/"))
        self.assertGreater(opened.call_args_list[0].kwargs["timeout"], 20)
        self.assertEqual((self.root / "retry-package").read_bytes(), data)

    def test_retries_are_bounded_and_diagnostics_do_not_expose_private_error_text(self):
        with patch.object(updates, "_open", side_effect=TimeoutError("private-signed-url-secret")) as opened:
            with self.assertRaises(updates.UpdateError) as caught:
                updates._download(self.catalog, self.root / "retry-package", lambda count: None)
        self.assertEqual(opened.call_count, 3)
        self.assertNotIn("private-signed-url-secret", str(caught.exception))
        with patch.object(updates, "_stage", side_effect=PermissionError(13, "private-account-path-secret")):
            updates.start_update("codex", self.body())
            job = self.wait_job()
        self.assertEqual(job["diagnostic"], {"stage": "downloading", "kind": "PermissionError", "errno": 13, "status": None})
        self.assertNotIn("private-account-path-secret", json.dumps(job))

    def test_marker_write_failure_restores_original_selection(self):
        root, old, entry = self.native_codex()
        real = shared._write_channel
        def write(path, value):
            if "1.2.4" in (value or ""):
                raise PermissionError(13, "private-marker-path")
            return real(path, value)
        with patch.object(updates, "_stage", return_value=entry), patch.object(shared, "_write_channel", side_effect=write):
            updates.start_update("codex", self.body())
            self.assertEqual(self.wait_job()["phase"], "failed")
        self.assertEqual((root / "current").resolve(), old)
        self.assertEqual(updates.installed_version("codex", str(self.root / "codex")), "1.2.3")

    def test_download_hash_and_length_are_checked_before_any_execution(self):
        data = b"untrusted payload"
        release = {"url": "https://github.com/file", "size": len(data), "sha256": "a" * 64}
        with patch.object(updates, "_open", return_value=io.BytesIO(data)):
            with self.assertRaises(updates.UpdateError):
                updates._download(release, self.root / "bad-download", lambda n: None)
        release["sha256"] = hashlib.sha256(data).hexdigest()
        with patch.object(updates, "_open", return_value=io.BytesIO(data)):
            updates._download(release, self.root / "good-download", lambda n: None)

    def test_archive_blocks_traversal_links_devices_and_duplicate_files(self):
        for name, kind, link in (("../outside", tarfile.REGTYPE, ""), ("/outside", tarfile.REGTYPE, ""),
                                 ("bin/tool", tarfile.SYMTYPE, "../../outside"), ("device", tarfile.CHRTYPE, "")):
            archive = self.root / (uuid.uuid4().hex + ".tar.gz")
            with tarfile.open(archive, "w:gz") as package:
                entry = tarfile.TarInfo(name)
                entry.type, entry.linkname = kind, link
                package.addfile(entry)
            payload = self.root / uuid.uuid4().hex
            payload.mkdir()
            with self.assertRaises(updates.UpdateError):
                updates._extract(archive, payload)
        self.assertFalse((self.root / "outside").exists())

    def test_archive_preserves_safe_library_aliases(self):
        archive = self.root / "aliases.tar.gz"
        with tarfile.open(archive, "w:gz") as package:
            entry = tarfile.TarInfo("lib/libexample.so.1")
            entry.size = 3
            package.addfile(entry, io.BytesIO(b"lib"))
            link = tarfile.TarInfo("lib/libexample.so")
            link.type, link.linkname = tarfile.SYMTYPE, "libexample.so.1"
            package.addfile(link)
        payload = self.root / "payload"
        payload.mkdir()
        updates._extract(archive, payload)
        self.assertEqual((payload / "lib/libexample.so").read_bytes(), b"lib")

    def test_api_validation_and_auth_dependency_cover_all_update_routes(self):
        routes = [route for route in main.app.routes if route.path.startswith("/api/agents")]
        self.assertEqual(len(routes), 5)
        for route in routes:
            self.assertIn(main.require_auth, [dependency.call for dependency in route.dependant.dependencies])
        request = Mock(json=AsyncMock(return_value=[]))
        with self.assertRaises(HTTPException):
            asyncio.run(main.check_agent_versions(request, None))
        with self.assertRaises(HTTPException):
            asyncio.run(main.update_agent("codex", request, None))
