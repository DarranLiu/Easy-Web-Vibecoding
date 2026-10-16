"""Offline launch capability checks before interrupting a real task."""
import os
from pathlib import Path
import re
import subprocess
import tempfile


def check(agent, binary, arguments):
    path = str(Path(binary).resolve(strict=True))
    stat = os.stat(path)
    identity = [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns]
    # Help must not load the user's account, hooks, projects, or remote models.
    with tempfile.TemporaryDirectory(prefix="webcc-cli-preflight-") as temporary:
        env = {"PATH": os.environ.get("PATH", os.defpath), "HOME": temporary,
               "CODEX_HOME": temporary, "CLAUDE_CONFIG_DIR": temporary,
               "XDG_CONFIG_HOME": temporary, "XDG_DATA_HOME": temporary, "XDG_STATE_HOME": temporary,
               "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1",
               "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "OPENCODE_DISABLE_AUTOUPDATE": "true",
               "OPENCODE_DISABLE_MODELS_FETCH": "true", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true"}
        commands = [["--help"], ["resume", "--help"]] if agent == "codex" else [["--help"]]
        outputs = []
        for command in commands:
            result = subprocess.run([path, *command], cwd=temporary, env=env,
                                    capture_output=True, text=True, timeout=12)
            if result.returncode:
                raise RuntimeError("程序帮助检查失败，旧任务未退出")
            outputs.append(result.stdout + result.stderr)
        supported = set(re.findall(r"(?<![\w-])--[a-zA-Z][\w-]*|(?<![\w-])-[a-zA-Z]\b", "\n".join(outputs)))
        required = {"codex": {"--no-daemon"}, "claude": {"--resume", "--settings"},
                    "opencode": {"--session", "--port", "--hostname"}}[agent]
        for argument in arguments:
            name = argument.split("=", 1)[0]
            if re.fullmatch(r"--[a-zA-Z][\w-]*|-[a-zA-Z]", name):
                required.add(name)
        missing = required - supported
        if missing:
            raise RuntimeError("新版程序缺少恢复所需参数 " + ", ".join(sorted(missing)) + "，旧任务未退出")
    current = os.stat(path)
    if identity != [current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns]:
        raise RuntimeError("检查期间程序又更新了，请重试；旧任务未退出")
    return {"path": path, "identity": identity}
