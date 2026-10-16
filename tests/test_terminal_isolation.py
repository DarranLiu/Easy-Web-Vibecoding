import asyncio
from contextlib import ExitStack
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from backend import config, main, terminal_launch, tmux_mgr


class TerminalIsolationTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix="webcc-isolation-")))
        self.home = self.root / "home"
        self.home.mkdir()
        (self.home / ".hushlogin").touch()
        self.native = self.root / "native"
        self.native.mkdir()
        self.launchers = self.root / "web launchers"
        self.stack.enter_context(patch.dict(os.environ, {
            "HOME": str(self.home), "PATH": str(self.native) + ":/usr/bin:/bin",
            "BASH_ENV": "", "ENV": "", "CC_WEB_OLD_BASH_ENV": "", "CC_WEB_OLD_ENV": "",
        }))
        self.stack.enter_context(patch.object(config, "TERMINAL_LAUNCHER_DIR", self.launchers))
        self.stack.enter_context(patch.object(config, "AGENT_RUNTIME_DIR", self.root / "runtime"))
        self.stack.enter_context(patch.object(config, "AGENT_UPDATE_DIR", self.root / "updates"))
        self.stack.enter_context(patch.object(config, "CODEX_MODEL_CATALOG", ""))
        self.stack.enter_context(patch.object(config, "CODEX_STATUS_LINE", []))
        self.stack.enter_context(patch.object(config, "CODEX_SCROLLBACK", True))
        for agent in terminal_launch.AGENTS:
            binary = self.native / agent
            binary.write_text(f'#!{sys.executable}\nimport json, sys\nprint(json.dumps(sys.argv[1:]))\n')
            binary.chmod(0o700)
            self.stack.enter_context(patch.object(config, agent.upper() + "_BIN", str(binary)))
        self.environment = {**os.environ, **terminal_launch.session_environment()}

    def run_shell(self, shell, flags, command):
        result = subprocess.run([shell, *flags, command], env=self.environment,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return [json.loads(line) for line in result.stdout.splitlines()]

    def test_every_terminal_type_installs_the_same_guard(self):
        for kind in (*terminal_launch.AGENTS, "shell"):
            command = main._launch_cmd(kind, "new")
            with self.subTest(kind=kind):
                for agent in terminal_launch.AGENTS:
                    self.assertIn(f'alias {agent}=_cc_web_{agent}', command)
                calls = self.run_shell("/bin/sh", ["-ic"], command + "\ncodex resume\n")
                self.assertEqual(calls[-1], ["--no-daemon", "--no-alt-screen", "resume"])

    def test_resume_remains_isolated_in_child_shells_and_command_lookup(self):
        for shell, flags in (("sh", ["-c"]), ("sh", ["-ic"]), ("bash", ["-c"]),
                             ("bash", ["-lc"]), ("bash", ["-ic"])):
            for invocation in ("codex resume", "command codex resume", "env codex resume"):
                with self.subTest(shell=shell, flags=flags, invocation=invocation):
                    self.assertEqual(self.run_shell(shell, flags, invocation),
                                     [["--no-daemon", "--no-alt-screen", "resume"]])

    def test_user_bashrc_cannot_accidentally_restore_native_path_or_alias(self):
        (self.home / ".bashrc").write_text(
            f'export PATH={shlex.quote(str(self.native))}:"$PATH"\n'
            f'alias codex={shlex.quote(str(self.native / "codex"))}\n'
        )
        self.assertEqual(self.run_shell("bash", ["-ic"], "codex resume\ncommand codex resume"),
                         [["--no-daemon", "--no-alt-screen", "resume"]] * 2)

    def test_agent_tool_children_inherit_protection(self):
        for agent in ("claude", "opencode"):
            (self.native / agent).write_text(
                f'#!{sys.executable}\nimport subprocess\nsubprocess.run(["codex", "resume"], check=True)\n'
            )
            with self.subTest(agent=agent):
                self.assertEqual(self.run_shell("/bin/sh", ["-c"], agent),
                                 [["--no-daemon", "--no-alt-screen", "resume"]])

    def test_explicit_old_backend_attachments_are_rejected(self):
        cases = {
            "codex": [["--remote", "http://localhost:1234"], ["resume", "--remote=ws://localhost:1234"],
                      ["queue"], ["agents"], ["remote-control"], ["app-server"],
                      ["app-server", "proxy"], ["app-server", "daemon"],
                      ["--model", "some-model", "app-server", "proxy"]],
            "claude": [["attach", "old-process"]],
            "opencode": [["attach", "http://localhost:1234"], ["run", "--attach", "http://localhost:1234"],
                         ["run", "--attach=http://localhost:1234"]],
        }
        for agent, commands in cases.items():
            for args in commands:
                with self.subTest(agent=agent, args=args), self.assertRaises(terminal_launch.AttachmentBlocked):
                    terminal_launch.guarded_arguments(agent, args, self.environment)

    def test_normal_commands_and_literal_prompts_are_not_blocked(self):
        for args in (["resume", "session-id"], ["--version"], ["login", "status"],
                     ["--model", "queue", "resume"], ["app-server", "generate-json-schema"],
                     ["--", "--remote", "app-server"]):
            with self.subTest(args=args):
                self.assertEqual(terminal_launch.guarded_arguments("codex", args, self.environment),
                                 ["--no-daemon", "--no-alt-screen", *args])
        for agent, args in (("claude", ["--resume", "attach"]), ("claude", ["--continue"]),
                            ("opencode", ["--port", "0", "--hostname", "127.0.0.1"])):
            self.assertEqual(terminal_launch.guarded_arguments(agent, args, self.environment), args)

    def test_new_sessions_receive_private_environment_not_global_tmux_updates(self):
        mock_tmux = Mock(return_value=subprocess.CompletedProcess([], 0, "", ""))
        with patch.object(tmux_mgr, "session_exists", return_value=False), patch.object(
            tmux_mgr, "_tmux", mock_tmux
        ):
            tmux_mgr.start_session("fixture", str(self.root), main._launch_cmd("shell", "new"))
        creation = mock_tmux.call_args_list[0].args[0]
        self.assertEqual(creation[0], "new-session")
        values = [creation[index + 1] for index, value in enumerate(creation) if value == "-e"]
        self.assertIn("CC_WEB_REAL_CODEX=" + str(self.native / "codex"), values)
        self.assertIn("PATH=" + self.environment["PATH"], values)
        self.assertFalse(any(call.args[0][0] == "set-environment" for call in mock_tmux.call_args_list))

    def test_existing_running_sessions_are_not_modified(self):
        with patch.object(tmux_mgr, "session_exists", return_value=True), patch.object(
            terminal_launch, "session_environment"
        ) as prepare, patch.object(tmux_mgr, "_tmux") as execute:
            self.assertEqual(tmux_mgr.start_session("fixture", str(self.root)), "cc_fixture")
            prepare.assert_not_called()
            execute.assert_not_called()

    def test_launcher_preparation_failure_does_not_fall_back(self):
        with patch.object(tmux_mgr, "session_exists", return_value=False), patch.object(
            terminal_launch, "session_environment", side_effect=OSError("not writable")
        ), patch.object(tmux_mgr, "_tmux") as execute:
            with self.assertRaisesRegex(RuntimeError, "isolated web terminal"):
                tmux_mgr.start_session("fixture", str(self.root))
            execute.assert_not_called()

    def test_new_and_restarted_api_terminals_share_guarded_launch_path(self):
        for kind in (*terminal_launch.AGENTS, "shell"):
            tab = {"id": "fixture", "cwd": str(self.root), "type": kind, "mode": "new"}
            request = Mock(json=AsyncMock(return_value={"cwd": str(self.root), "type": kind}))
            with self.subTest(kind=kind), patch.object(main, "safe_resolve", return_value=self.root), patch.object(
                main.tmux_mgr, "gen_id", return_value="fixture"
            ), patch.object(main.tmux_mgr, "start_session") as start, patch.object(
                main.tmux_mgr, "session_exists", return_value=False
            ), patch.object(main.tmux_mgr, "list_sessions", return_value=[]), patch.object(
                main.store, "add_tab"
            ), patch.object(main.store, "get_tab", return_value=tab), patch.object(main.store, "update_tab"), patch.object(
                main.terminal_restart, "_inspect", return_value={"ready": True, "expected": "saved-exact-id"}
            ), patch.object(main.terminal_restart, "restart_locked", return_value={**tab, "alive": True, "resumed": True}) as resume:
                asyncio.run(main.create_session(request, None))
                self.assertEqual(start.call_args.args[2], main._launch_cmd(kind, "new"))
                result = main.start_session("fixture", None)
                if kind == "shell":
                    resume.assert_not_called()
                    self.assertEqual(start.call_args.args[2], main._launch_cmd(kind, "new"))
                else:
                    self.assertTrue(result["resumed"])
                    self.assertEqual(resume.call_args.args[2]["expected"], "saved-exact-id")

    def test_native_install_symlink_is_not_pinned_to_a_release(self):
        stable = self.native / "codex"
        stable.unlink()
        stable.symlink_to(self.native / "release-one")
        for name, marker in (("release-one", "one"), ("release-two", "two")):
            binary = self.native / name
            binary.write_text(f'#!{sys.executable}\nimport json\nprint(json.dumps({marker!r}))\n')
            binary.chmod(0o700)
        self.assertEqual(self.environment["CC_WEB_REAL_CODEX"], str(stable))
        self.assertEqual(self.run_shell("/bin/sh", ["-c"], "codex --version"), ["one"])
        stable.unlink()
        stable.symlink_to(self.native / "release-two")
        self.assertEqual(self.run_shell("/bin/sh", ["-c"], "codex --version"), ["two"])

    def test_private_files_and_repeated_environment_preparation(self):
        self.assertEqual(self.launchers.stat().st_mode & 0o777, 0o700)
        for agent in terminal_launch.AGENTS:
            self.assertEqual((self.launchers / agent).stat().st_mode & 0o777, 0o700)
        with patch.dict(os.environ, self.environment), patch.object(config, "CODEX_BIN", str(self.launchers / "codex")):
            again = terminal_launch.session_environment()
        self.assertEqual(again["CC_WEB_REAL_CODEX"], str(self.native / "codex"))
        self.assertEqual(again["CC_WEB_OLD_BASH_ENV"], "")
        self.assertEqual(again["PATH"].count(str(self.launchers)), 1)

    def test_missing_native_executable_fails_without_using_another_binary(self):
        environment = {**self.environment, "CC_WEB_REAL_CODEX": str(self.root / "missing")}
        result = subprocess.run([str(self.launchers / "codex"), "resume"], env=environment,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 127)
        self.assertEqual(result.stdout, "")
        self.assertIn("will not fall back", result.stderr)

    def test_self_referential_native_path_is_rejected(self):
        environment = {**self.environment, "CC_WEB_REAL_CODEX": str(self.launchers / "codex")}
        result = subprocess.run([str(self.launchers / "codex")], env=environment,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 127)
        self.assertIn("refuses to use itself", result.stderr)


if __name__ == "__main__":
    unittest.main()
