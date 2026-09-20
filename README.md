# Easy Web Vibecoding

> 把 Claude Code、Codex、OpenCode 和普通 Shell 放进一个可以远程打开的浏览器工作台。

[![Tests](https://github.com/DarranLiu/Easy-Web-Vibecoding/actions/workflows/tests.yml/badge.svg)](https://github.com/DarranLiu/Easy-Web-Vibecoding/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-0f6cbd.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-3776ab.svg)](https://www.python.org/)

![桌面双终端界面](docs/images/desktop-split.png)

Easy Web Vibecoding 的界面叫 **CC Terminal**。它不是另一个 AI 服务，也不会替你转发模型 API；它只是把你机器上已经能运行的命令行工具，通过 `tmux + FastAPI + xterm.js` 安全地接到浏览器里。

浏览器关掉、网络断开，甚至 Web 后端重启，终端里的任务仍然留在 tmux 中继续运行。重新打开页面，就能接着看和接着输入。

## 它能做什么

- **一页管理多种终端**：Claude Code、Codex、OpenCode 和普通 Shell。
- **最多四格分屏**：支持左右、上下或自动布局，分隔线可以拖动。
- **断线不丢任务**：浏览器只是窗口，真正的进程在 tmux 里。
- **目录和文件管理**：搜索目录、新建、上传、下载、改名、删除和常见文件预览。
- **手机也能操作**：有 `Esc`、`Tab`、`Ctrl`、方向键等触控辅助键，并处理了软键盘遮挡。
- **终端历史可滚动**：普通 Shell 走 tmux 历史，交互式 TUI 走应用自己的滚动。
- **图片可以直接送进会话**：选择、粘贴或拖入图片，上传后把文件路径送入当前终端。
- **资源面板**：查看磁盘、目录占用和 NVIDIA GPU；也能通过免密 SSH 添加远程主机。
- **连接提示**：显示当前在线页面、设备和来源 IP，陌生来源会被标出来。
- **Codex 用量条**：只在当前聚焦的 Codex 窗口显示，服务端最多每 10 分钟读取一次。
- **适合安装成 Web App**：支持浅色/深色、高对比度、减少动画和移动端布局。

更完整的界面说明见 [可视化操作手册](docs/VISUAL_GUIDE.md)。

## 三分钟跑起来

### 1. 准备环境

服务端需要 Linux 或其他提供 PTY 的类 Unix 系统：

- Python 3.10 或更高版本
- `tmux`
- 至少一种可选工具：`claude`、`codex`、`opencode`

Ubuntu / Debian 可以先安装基础依赖：

```bash
sudo apt update
sudo apt install -y python3 python3-venv tmux
```

AI 命令行工具要先在服务器上完成自己的安装和登录。本项目不会保存它们的 API Key。

### 2. 启动

```bash
git clone https://github.com/DarranLiu/Easy-Web-Vibecoding.git
cd Easy-Web-Vibecoding

export CC_WEB_ROOTS="$HOME/projects"
export CC_WEB_DEFAULT_DIR="$HOME/projects"
./run.sh
```

第一次运行会创建 `.venv` 并安装 Python 依赖。终端会打印访问地址和一枚随机 Token。打开地址，在登录页输入 Token 即可。

默认只监听 `127.0.0.1:8000`。本机浏览器直接打开：

```text
http://127.0.0.1:8000
```

### 3. 开一个会话

1. 点“新终端”。
2. 选择允许访问的目录。
3. 选择 Claude、Codex、OpenCode 或普通终端。
4. 关掉浏览器再打开，会话仍在。

## 常用配置

| 环境变量 | 默认值 | 人话说明 |
| --- | --- | --- |
| `CC_WEB_HOST` | `127.0.0.1` | 服务监听地址。不要随便改成公网地址。 |
| `CC_WEB_PORT` | `8000` | 服务端口。 |
| `CC_WEB_AUTH` | `1` | 是否启用 Token 登录。只有纯本机调试才能设为 `0`。 |
| `CC_WEB_TOKEN` | 启动时随机生成 | 自定义登录 Token。建议使用密码管理器生成的长随机值。 |
| `CC_WEB_ROOTS` | 当前用户家目录 | 浏览器允许访问的根目录，多个目录用逗号分隔。 |
| `CC_WEB_DEFAULT_DIR` | 当前用户家目录 | 新建终端时默认打开的位置。 |
| `CC_WEB_CLAUDE` | 自动查找 | `claude` 可执行文件路径。 |
| `CC_WEB_CODEX` | 自动查找 | `codex` 可执行文件路径。 |
| `CC_WEB_OPENCODE` | 自动查找 | `opencode` 可执行文件路径。 |
| `CC_WEB_CODEX_MODEL_CATALOG` | 自动查找 | 可选的 Codex 模型目录文件。设为空字符串可关闭覆盖。 |
| `CC_WEB_CODEX_STATUS_LINE` | 模型、状态、上下文 | Web 新建 Codex 时使用的底栏项目，逗号分隔。 |
| `CC_WEB_DISK_ROOTS` | 当前用户家目录 | 资源面板允许执行 `du` 的根目录，多个目录用逗号分隔。 |

完整变量和部署方法见 [部署与配置](docs/DEPLOYMENT.md)。

## 安全提醒

这不是普通网页。它拥有你登录用户能执行的几乎全部命令，因此应当把它当作 SSH 一样保护。

- 不要在关闭鉴权时暴露到局域网或公网。
- 公网访问必须使用 HTTPS，并建议再加 Cloudflare Access、Tailscale 或来源 IP 限制。
- `CC_WEB_ROOTS` 不要直接设为 `/`。
- 不要把 `.env`、Token、证书、运行日志或状态 JSON 提交到 Git。
- 远程 GPU 监控会使用当前用户的 SSH 凭据，只添加你信任的主机。

本项目使用 HttpOnly Cookie 维持登录；Token 不放进下载链接或 WebSocket URL。更多说明见 [SECURITY.md](SECURITY.md)。

## 它是怎么工作的

```text
浏览器 xterm.js
      │ WebSocket
      ▼
FastAPI 后端 ── attach ── tmux session ── Claude / Codex / OpenCode / Shell
      │
      └── 文件、资源、在线状态等 REST API
```

关键点只有一个：**浏览器连接和终端进程不是一回事**。WebSocket 断开时只会丢掉这次“观看连接”，不会杀掉 tmux 中的任务。

## 已经踩过的坑

这个项目不是一次写出来的。字体乱码、滚轮失灵、模型列表不一致、手机键盘遮挡、额度显示过期、OpenCode 启动错程序等问题都真实出现过，并已逐项处理。

完整过程见 [曾经解决过的问题](docs/PROBLEMS_SOLVED.md)。

## 测试

```bash
python -m unittest discover -s tests -v
node --check frontend/app.js
```

## 适用边界

- 服务端面向 Linux / 类 Unix；Windows 可以作为浏览器客户端。
- 这是个人或小团队自托管工具，不包含多租户和细粒度权限系统。
- Claude Code、Codex、OpenCode 的安装、账号和可用模型由各自工具决定。
- 资源面板在 GNU `df` / `du` 和 NVIDIA `nvidia-smi` 环境下功能最完整。

## 开源协议

项目代码使用 [MIT License](LICENSE)。内置的 xterm.js 和 DejaVu 字体各自遵循原项目协议，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
