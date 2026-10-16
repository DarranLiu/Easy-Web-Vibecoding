"""Web-only agent launchers inherited by every new terminal and its children."""
import json
import os
from pathlib import Path
import shlex
import shutil
import sys
import tempfile


AGENTS = ("codex", "claude", "opencode")
DIRECTORY_ENV = ("HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
                 "XDG_STATE_HOME", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_TUI_CONFIG")
_VALUE_OPTIONS = {
    "-c", "--config", "--enable", "--disable", "-m", "--model", "-p", "--profile",
    "-i", "--image", "-C", "--cd", "--add-dir", "-s", "--sandbox", "-a", "--ask-for-approval",
    "--remote-auth-token-env", "--agent", "--settings", "--session-id", "--log-level",
    "--hostname", "--port", "--sock", "--listen", "--code-mode-host", "-r", "--resume",
    "--session", "--prompt", "--replay-limit",
}


class AttachmentBlocked(ValueError):
    pass


def _positional_commands(args):
    """Ignore option values and literal prompts after -- when checking commands."""
    positionals = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--":
            break
        if arg in _VALUE_OPTIONS:
            index += 2
            continue
        if not arg.startswith("-"):
            positionals.append(arg)
        index += 1
    return positionals


def guarded_arguments(agent, args, env):
    active_options = args[:args.index("--")] if "--" in args else args
    commands = _positional_commands(args)
    if agent == "codex":
        if any(arg == "--remote" or arg.startswith("--remote=") for arg in active_options):
            raise AttachmentBlocked("Web Codex remote/shared-backend attachment is disabled.")
        if commands and commands[0] in {"agents", "queue", "remote-control"}:
            raise AttachmentBlocked("Web Codex shared-daemon commands are disabled.")
        if commands and commands[0] == "app-server":
            if len(commands) < 2 or commands[1] not in {"generate-ts", "generate-json-schema", "help"}:
                raise AttachmentBlocked("Start app-server outside web terminals; shared/proxy backends are disabled here.")
        defaults = ["--no-daemon"]
        if env.get("CC_WEB_CODEX_SCROLLBACK", "1") != "0":
            defaults.append("--no-alt-screen")
        catalog = env.get("CC_WEB_CODEX_MODEL_CATALOG", "")
        if catalog:
            defaults.extend(["-c", "model_catalog_json=" + json.dumps(catalog)])
        status = json.loads(env.get("CC_WEB_CODEX_STATUS_ITEMS", "[]"))
        if status:
            defaults.extend(["-c", "tui.status_line=" + json.dumps(status, separators=(",", ":"))])
        return defaults + list(args)
    if agent == "claude" and commands and commands[0] == "attach":
        raise AttachmentBlocked("Attaching an existing Claude background process is disabled in web terminals.")
    if agent == "opencode" and (commands and commands[0] == "attach" or any(
        arg == "--attach" or arg.startswith("--attach=") for arg in active_options
    )):
        raise AttachmentBlocked("Attaching an existing OpenCode server is disabled in web terminals.")
    return list(args)


def _write_launcher(directory, agent):
    from backend import config
    path = directory / agent
    update_root = shlex.quote(str(config.AGENT_UPDATE_DIR.absolute()))
    configured = getattr(config, agent.upper() + "_BIN", "bash")
    search = os.pathsep.join(p for p in os.environ.get("PATH", os.defpath).split(os.pathsep) if p != str(directory))
    common = os.path.abspath(configured) if os.path.sep in configured else shutil.which(configured, path=search)
    export = "export CC_WEB_SHARED_" + agent.upper() + "=" + shlex.quote(common) + "\n" if common and agent in AGENTS else ""
    content = ("#!/bin/sh\nexport CC_WEB_AGENT_UPDATE_DIR=${CC_WEB_AGENT_UPDATE_DIR:-" + update_root + "}\n" + export + "exec " +
               shlex.join([sys.executable, str(Path(__file__).resolve()), agent]) + ' "$@"\n')
    if path.is_file() and not path.is_symlink() and path.read_text() == content:
        path.chmod(0o700)
        return
    fd, temporary = tempfile.mkstemp(prefix="." + agent + "-", dir=directory)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o700)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _write_shell_init(directory):
    path = directory / "shell-init"
    content = (
        'if [ -n "${BASH_VERSION-}" ]; then\n'
        '  case "$-" in\n'
        '    *i*) [ ! -f "$HOME/.bashrc" ] || . "$HOME/.bashrc" ;;\n'
        '    *) [ -z "${CC_WEB_OLD_BASH_ENV-}" ] || [ ! -f "$CC_WEB_OLD_BASH_ENV" ] || . "$CC_WEB_OLD_BASH_ENV" ;;\n'
        '  esac\n'
        'else\n'
        '  [ -z "${CC_WEB_OLD_ENV-}" ] || [ ! -f "$CC_WEB_OLD_ENV" ] || . "$CC_WEB_OLD_ENV"\n'
        'fi\n' + shell_setup() + "\n"
    )
    fd, temporary = tempfile.mkstemp(prefix=".shell-init-", dir=directory)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return str(path)


def session_environment(use_updates=True):
    from backend import config, agent_updates

    directory = config.TERMINAL_LAUNCHER_DIR.absolute()
    if directory.is_symlink():
        raise RuntimeError("Terminal launcher directory must not be a symlink")
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    if directory.stat().st_uid != os.getuid():
        raise RuntimeError("Terminal launcher directory has an unexpected owner")
    directory.chmod(0o700)
    for agent in AGENTS:
        _write_launcher(directory, agent)
    shell_init = _write_shell_init(directory)
    # Use the service's current PATH, not tmux's long-lived global environment.
    original_path = os.environ.get("PATH", os.defpath)
    guards = {str(directory), os.environ.get("CC_WEB_AGENT_BIN", "")}
    path = os.pathsep.join(p for p in original_path.split(os.pathsep) if p not in guards)

    def original_init(kind):
        old = os.environ.get("CC_WEB_OLD_" + kind, os.environ.get(kind, ""))
        if old and os.path.dirname(os.path.abspath(old)) in guards:
            return ""
        return old

    env = {"CC_WEB_AGENT_BIN": str(directory), "PATH": str(directory) + os.pathsep + path,
           "CC_WEB_AGENT_RUNTIME_DIR": str(config.AGENT_RUNTIME_DIR.absolute()),
           "CC_WEB_AGENT_UPDATE_DIR": str(config.AGENT_UPDATE_DIR.absolute()),
           "CC_WEB_SHELL_INIT": shell_init, "BASH_ENV": shell_init, "ENV": shell_init,
           "CC_WEB_OLD_BASH_ENV": original_init("BASH_ENV"),
           "CC_WEB_OLD_ENV": original_init("ENV"),
           "CC_WEB_CODEX_SCROLLBACK": "1" if config.CODEX_SCROLLBACK else "0",
           "CC_WEB_CODEX_MODEL_CATALOG": config.CODEX_MODEL_CATALOG,
           "CC_WEB_CODEX_STATUS_ITEMS": json.dumps(config.CODEX_STATUS_LINE)}
    for key in DIRECTORY_ENV:
        if key in os.environ:
            env[key] = os.environ[key]
    for agent in AGENTS:
        binary = getattr(config, agent.upper() + "_BIN")
        if os.path.sep in binary and os.path.dirname(os.path.abspath(binary)) in guards:
            binary = os.environ.get("CC_WEB_REAL_" + agent.upper(), "") or agent
        if os.path.sep not in binary:
            binary = shutil.which(binary, path=path) or ""
        # Keep the installer's stable path: resolving its symlink would pin a release.
        base = os.path.abspath(binary) if binary else ""
        env["CC_WEB_BASE_" + agent.upper()] = base
        env["CC_WEB_SHARED_" + agent.upper()] = base
        env["CC_WEB_REAL_" + agent.upper()] = agent_updates.selected_binary(agent, base) if use_updates else base
    bash = shutil.which("bash", path=path)
    if bash:
        env["CC_WEB_REAL_BASH"] = bash
        _write_launcher(directory, "bash")
    return env


def shell_setup():
    parts = ['export PATH="$CC_WEB_AGENT_BIN:$PATH"', 'hash -r 2>/dev/null || true']
    for agent in AGENTS:
        parts.append(f'_cc_web_{agent}() {{ command "$CC_WEB_AGENT_BIN/{agent}" "$@"; }}')
        parts.append(f"alias {agent}=_cc_web_{agent}")
    return "; ".join(parts)


def shell_bootstrap(sid, environment):
    """Install guards in the parent shell; never serialize keys or inline config."""
    from backend import agent_sessions
    if not agent_sessions.SID_RE.fullmatch(sid):
        raise ValueError("Invalid terminal ID")
    path = agent_sessions.runtime_dir() / (sid + ".shell")
    content = []
    for key, value in environment.items():
        if key.startswith("CC_WEB_") or key in (*DIRECTORY_ENV, "PATH", "BASH_ENV", "ENV"):
            content.append("export " + key + "=" + shlex.quote(value))
    content.append(shell_setup())
    fd, temporary = tempfile.mkstemp(prefix=".shell-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write("\n".join(content) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return path


def main():
    agent = sys.argv[1] if len(sys.argv) > 1 else ""
    if agent not in (*AGENTS, "bash"):
        print("Unknown web terminal agent", file=sys.stderr)
        return 64
    native_args = sys.argv[2:]
    if __package__:
        from backend import agent_sessions
    else:
        import agent_sessions
    try:
        plan_args = agent_sessions.take_restart_plan(agent)
        if plan_args is not None:
            native_args = plan_args
    except (OSError, ValueError, RuntimeError):
        print("Restart plan is invalid; no new agent was started.", file=sys.stderr)
        return 64
    binary = os.environ.get("CC_WEB_REAL_" + agent.upper(), "")
    guard = os.environ.get("CC_WEB_AGENT_BIN", "")
    launcher = Path(guard) / agent
    if not binary or not os.path.isfile(binary) or not os.access(binary, os.X_OK):
        print(f"{agent} is unavailable; web terminals will not fall back to another executable.", file=sys.stderr)
        return 127
    if guard and launcher.exists() and os.path.samefile(binary, launcher):
        print("Web launcher refuses to use itself as the native executable.", file=sys.stderr)
        return 127
    if agent in AGENTS and plan_args is None:
        if __package__:
            from backend import agent_updates
        else:
            import agent_updates
        try:
            binary = agent_updates.selected_binary(agent, os.environ.get("CC_WEB_SHARED_" + agent.upper()) or
                                                    os.environ.get("CC_WEB_BASE_" + agent.upper()) or binary)
        except RuntimeError:
            print("Web release selection failed; no fallback agent was started.", file=sys.stderr)
            return 127
    if agent in AGENTS and "/releases/" in binary and os.environ.get("CC_WEB_AGENT_UPDATE_DIR"):
        os.environ["DISABLE_AUTOUPDATER"] = "1"
        os.environ["OPENCODE_DISABLE_AUTOUPDATE"] = "true"
    if not binary or not os.path.isfile(binary) or not os.access(binary, os.X_OK):
        print(f"{agent} is unavailable; web terminals will not fall back to another executable.", file=sys.stderr)
        return 127
    if guard and launcher.exists() and os.path.samefile(binary, launcher):
        print("Web launcher refuses to use itself as the native executable.", file=sys.stderr)
        return 127
    if agent == "bash":
        os.execve(binary, [binary, "--rcfile", os.environ["CC_WEB_SHELL_INIT"], *sys.argv[2:]], os.environ)
    try:
        arguments = guarded_arguments(agent, native_args, os.environ)
    except AttachmentBlocked as exc:
        print(str(exc), file=sys.stderr)
        return 64
    if agent in AGENTS:
        try:
            monitored = agent_sessions.prepare_launch(agent, native_args)
            arguments = guarded_arguments(agent, monitored, os.environ)
        except (OSError, ValueError, RuntimeError):
            print("Session tracking unavailable; automatic restart is disabled for this launch.", file=sys.stderr)
    # Execute the stable native path directly; children keep the guarded PATH.
    try:
        os.execve(binary, [binary, *arguments], os.environ)
    except OSError:
        sid, root = os.environ.get("CC_WEB_SESSION_ID", ""), os.environ.get("CC_WEB_AGENT_RUNTIME_DIR", "")
        if agent_sessions.SID_RE.fullmatch(sid) and root:
            with agent_sessions.lock(sid, root=root):
                record = agent_sessions.load(sid, root)
                if record.get("pid") == os.getpid():
                    record["launch_failed"] = True
                    agent_sessions.save(sid, record, root)
        print("Native startup failed; the saved conversation was retained.", file=sys.stderr)
        return 127


if __name__ == "__main__":
    sys.exit(main())
