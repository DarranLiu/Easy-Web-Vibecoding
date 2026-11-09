"""Per-launch permissions. Never edit account/project settings or send commands."""
import re
import os
import subprocess

from backend import agent_sessions as sessions, terminal_launch, terminal_preflight

CODEX_APPROVALS = {"on-request": "按需确认", "never": "无需确认"}
CODEX_SANDBOXES = {"read-only": "只读沙盒", "workspace-write": "工作目录可写", "danger-full-access": "完全访问（无沙盒）"}
CLAUDE_MODES = {"default": "常规确认", "acceptEdits": "自动接受编辑", "plan": "计划模式",
                "auto": "自动判断（原生安全审查）", "dontAsk": "无需确认（未授权操作自动拒绝）", "bypassPermissions": "跳过权限检查（高风险）"}


class PermissionError(ValueError):
    pass


def validate(agent, choice):
    if not isinstance(choice, dict):
        raise PermissionError("权限设置无效")
    expected = {"approval", "sandbox"} if agent == "codex" else {"mode"}
    if agent not in {"codex", "claude"} or set(choice) != expected:
        raise PermissionError("此工具不支持该权限设置")
    allowed = {"approval": CODEX_APPROVALS, "sandbox": CODEX_SANDBOXES} if agent == "codex" else {"mode": CLAUDE_MODES}
    if any(not isinstance(value, str) or value not in allowed[key] for key, value in choice.items()):
        raise PermissionError("不支持的权限选项")
    return dict(choice)


def dangerous(agent, choice):
    return choice.get("sandbox") == "danger-full-access" if agent == "codex" else choice.get("mode") == "bypassPermissions"


def rewrite(record, choice):
    """Replace only permission switches, retaining model, provider and exact ID."""
    from backend import terminal_restart as restart
    agent = record["agent"]
    choice = validate(agent, choice)
    args, output, index = record.get("args", []), [], 0
    if agent == "claude" and choice["mode"] == "bypassPermissions" and ("--restricted" in args or os.geteuid() == 0):
        raise PermissionError("此 Claude 启动环境不允许跳过权限检查，旧程序未退出")
    values = restart._COMMON_VALUES | (restart._CODEX_VALUES if agent == "codex" else set())
    remove_values = {"--sandbox", "-s", "--ask-for-approval", "-a"} if agent == "codex" else {"--permission-mode"}
    remove_flags = ({"--yolo", "--dangerously-bypass-approvals-and-sandbox", "--full-auto", "--approve-for-me", "--not-so-yolo"}
                    if agent == "codex" else {"--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"})
    while index < len(args):
        arg = args[index]
        if arg == "--":
            output.extend(args[index:])
            break
        name, equal, inline = arg.partition("=")
        count = 2 if name in values and not equal else 1
        if count == 2 and index + 1 >= len(args):
            raise PermissionError("原启动参数不完整，不会中断程序")
        value = inline if equal else args[index + 1] if count == 2 else ""
        skip = name in remove_values or name in remove_flags
        if agent == "codex" and name in {"-c", "--config"}:
            key = value.partition("=")[0].strip().strip("\"'")
            if key == "permissions" or key.startswith("permissions."):
                raise PermissionError("原程序使用自定义权限配置，不能可靠覆盖；请先在原生终端调整")
            skip = key in {"approval_policy", "sandbox_mode"}
        if not skip:
            output.extend(args[index:index + count])
        index += count
    # Put overrides before a literal prompt delimiter, never inside prompt text.
    offset = output.index("--") if "--" in output else len(output)
    flags = (["--sandbox", choice["sandbox"], "--ask-for-approval", choice["approval"]] if agent == "codex"
             else ["--permission-mode", choice["mode"]])
    output[offset:offset] = flags
    return {**record, "args": output}


def current(record):
    agent, args = record.get("agent"), record.get("args", [])
    result = {}
    values = {"--sandbox": "sandbox", "-s": "sandbox", "--ask-for-approval": "approval", "-a": "approval"} if agent == "codex" else {"--permission-mode": "mode"}
    index = 0
    # Skip unrelated option values so a model name cannot become a permission flag.
    from backend import terminal_restart as restart
    known = restart._COMMON_VALUES | (restart._CODEX_VALUES if agent == "codex" else set())
    while index < len(args):
        arg = args[index]
        if arg == "--":
            break
        name, equal, inline = arg.partition("=")
        count = 2 if name in known and not equal else 1
        value = inline if equal else args[index + 1] if count == 2 and index + 1 < len(args) else ""
        if name in values:
            result[values[name]] = value
        if agent == "codex" and name in {"--yolo", "--dangerously-bypass-approvals-and-sandbox"}:
            result.update(sandbox="danger-full-access", approval="never")
        if agent == "codex" and name in {"-c", "--config"}:
            key, _, val = value.partition("=")
            if key.strip() in {"approval_policy", "sandbox_mode"}:
                result[{"approval_policy": "approval", "sandbox_mode": "sandbox"}[key.strip()]] = val.strip().strip("\"'")
        if agent == "claude" and name == "--dangerously-skip-permissions":
            result["mode"] = "bypassPermissions"
        index += count
    if agent == "claude" and record.get("permission_mode"):
        result["mode"] = "default" if record["permission_mode"] == "manual" else record["permission_mode"]
    labels = {**CODEX_APPROVALS, **CODEX_SANDBOXES, **CLAUDE_MODES, "manual": "常规确认", "auto": "自动判断"}
    return {"values": result, "label": " · ".join(labels.get(value, "原生自定义配置") for value in result.values()) or "由原生配置决定（未确认）",
            "source": "native-hook" if agent == "claude" and record.get("permission_mode") else "launch-arguments"}


def supported(help_text, value):
    return bool(re.search(r"(?<![\w-])" + re.escape(value) + r"(?![\w-])", help_text))


def option_help(help_text, key):
    flag = {"approval": "--ask-for-approval", "sandbox": "--sandbox", "mode": "--permission-mode"}[key]
    lines, active, found = [], False, False
    for line in help_text.splitlines():
        if re.match(r"\s*(?:-[a-zA-Z],\s+)?--[\w-]+(?:\s|=|$)", line):
            active = supported(line, flag)
            found = found or active
        if active:
            lines.append(line)
    return "\n".join(lines) if found else ""


def check_values(agent, choice, help_text):
    if any(not supported_value(help_text, key, value) for key, value in choice.items()):
        raise PermissionError("当前安装版本未声明支持此权限模式，旧程序未退出")


def supported_value(help_text, key, value):
    block = option_help(help_text, key)
    # New Claude help calls the documented default/manual alias "manual".
    return supported(block, value) or key == "mode" and value == "default" and supported(block, "manual")


def inspect(sid, tab):
    from backend import terminal_restart as restart
    try:
        # The stored tab can be Shell even when a native agent now owns the pane.
        preview = restart.inspect(sid, tab)
    except restart.RestartError:
        if tab.get("type") == "shell" and sessions.load(sid).get("agent") not in terminal_launch.AGENTS:
            return {"ready": False, "reason": "普通 Shell 没有 Agent 权限模式"}
        raise
    agent = preview["agent"]
    record = sessions.load(sid)
    view = {**preview, "current": current(record), "options": {}}
    if agent == "opencode":
        return {**view, "ready": False, "reason": "OpenCode 使用项目和 Agent 的细粒度权限规则，暂不在网页中覆盖"}
    if not preview.get("ready"):
        return view
    env = terminal_launch.session_environment()
    try:
        checked = terminal_preflight.check(agent, env.get("CC_WEB_REAL_" + agent.upper(), ""), [])
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        raise restart.RestartError("无法确认安装版本的权限选项，未修改终端") from exc
    help_text = checked["help"]
    groups = {"approval": CODEX_APPROVALS, "sandbox": CODEX_SANDBOXES} if agent == "codex" else {"mode": CLAUDE_MODES}
    view["options"] = {key: [{"value": value, "label": label} for value, label in choices.items()
                              if supported_value(help_text, key, value)] for key, choices in groups.items()}
    if any(not choices for choices in view["options"].values()):
        view.update(ready=False, reason="当前安装版本未提供可验证的权限选项")
    return view
