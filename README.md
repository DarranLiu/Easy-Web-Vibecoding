<p align="center">
  <img src="docs/images/desktop-split.png" alt="Easy Web Vibecoding 双终端工作区">
</p>

<h1 align="center">Easy Web Vibecoding</h1>

<p align="center">
  <strong>把 Claude Code、Codex、OpenCode 和 Shell 放进一个可恢复、可分屏的浏览器工作台。</strong>
</p>

<p align="center">
  <a href="https://github.com/DarranLiu/Easy-Web-Vibecoding/actions/workflows/tests.yml"><img src="https://img.shields.io/github/actions/workflow/status/DarranLiu/Easy-Web-Vibecoding/tests.yml?style=flat&colorA=242424&colorB=3fb950" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-58a6ff?style=flat&colorA=242424" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Python-3.10%2B-3776ab?style=flat&colorA=242424" alt="Python 3.10+">
  <img src="https://img.shields.io/badge/backend-FastAPI-009688?style=flat&colorA=242424" alt="FastAPI">
</p>

<p align="center">
  <strong>4</strong> 种终端 · <strong>4</strong> 格分屏 · tmux 持久会话 · 文件与资源管理 · 桌面与移动端
</p>

Easy Web Vibecoding 的界面叫 **CC Terminal**。它不是新的模型服务，也不转发模型 API。它做的事情很直接：把服务器上已经能运行的命令行工具，通过 `tmux + FastAPI + xterm.js` 接到浏览器。

浏览器关掉、网络断开或 Web 后端重启，真正的任务仍留在 tmux 中。再次打开页面，就能继续看、继续输入。

> [!NOTE]
> 下面所有画面都来自项目真实前端和真实浏览器渲染。会话、目录、IP、文件和资源数据均为匿名演示内容，不对应任何真实服务器。

## 先跑起来

**Linux / 类 Unix 服务端**

```bash
git clone https://github.com/DarranLiu/Easy-Web-Vibecoding.git
cd Easy-Web-Vibecoding

export CC_WEB_ROOTS="$HOME/projects"
export CC_WEB_DEFAULT_DIR="$HOME/projects"
./run.sh
```

第一次运行会创建 `.venv`、安装 Python 依赖，并打印访问地址与随机 Token。默认只监听：

```text
http://127.0.0.1:8000
```

服务端需要 Python 3.10+ 和 `tmux`。Claude Code、Codex、OpenCode 需要先在服务器上自行安装并登录；本项目不会保存它们的 API Key。

完整部署方式见 [部署与配置](docs/DEPLOYMENT.md)。

## 01 · 从目录启动任何一种终端

点“新终端”，选项目目录，再选择 Claude 新对话、继续会话、Codex、OpenCode 或普通 Shell。没有安装的工具不会显示成一个点了才报错的假入口。

![新建终端与目录选择](docs/images/new-terminal.png)

## 02 · 一个页面同时盯住多个任务

每个标签背后都是独立 tmux session。工作区最多放四格，可以左右、上下或自动排列；分隔线可拖动，终端位置也能交换。切换标签只是在换视图，不会终止任务。

![双终端分屏](docs/images/desktop-split.png)

## 03 · 复制文字，也保留终端该有的 Ctrl+C

终端里选中文字后，可以点顶部复制按钮，Windows / Linux 也可用 `Ctrl+Shift+C`，macOS / iPad 可用 `Cmd+C`。普通 `Ctrl+C` 仍然发送中断信号，不会被网页抢走。

没有选区时，复制按钮会复制当前屏幕；长按或右键复制按钮会复制完整历史。对于会接管鼠标的 AI TUI，可以先打开顶部“选择模式”再拖动。

![终端文字选择与复制反馈](docs/images/copy-text.png)

普通文字粘贴不需要专门窗口：聚焦终端后直接按 `Ctrl+V` / `Cmd+V`，或使用手机系统的粘贴操作即可。

## 04 · 粘贴图片不是一句空话

点顶部图片按钮后，可以选择图片、按 `Ctrl+V` 粘贴截图，或直接拖进窗口。图片会先保存到当前工作目录的 `.cc-web-images/`，随后把文件路径插入终端；补充一句要求再按回车即可。

![选择、粘贴或拖入图片](docs/images/send-image.png)

这样做不会把二进制数据硬塞进 PTY，也不会依赖某一家 AI 工具的私有上传接口。

## 05 · 文件管理不必再开一个远程桌面

文件面板支持列表/网格、筛选、上传、下载、新建、改名和删除。所有操作都受 `CC_WEB_ROOTS` 白名单限制。

![文件列表](docs/images/files.png)

图片、视频、音频、PDF 和常见文本可以直接预览，并支持前后切换与下载。

![文件预览](docs/images/file-preview.png)

## 06 · GPU 和磁盘放在同一个资源面板

GPU 页展示显存、利用率、温度、功耗、用户和进程。远程主机可通过免密 SSH 读取 `nvidia-smi`，无需在远端安装本项目。

![GPU 资源监控](docs/images/resources-gpu.png)

存储页先看分区容量，再按目录逐层下钻。耗时的 `du` 在后端扫描并缓存，不会把页面一直卡住。

![存储容量与目录占用](docs/images/resources-storage.png)

## 07 · 连接管理，而不是假装有一套账号系统

当前版本使用共享 Token，不是多租户账号/角色系统。它提供的是更实用的连接识别：查看通过认证的来源 IP、设备、首次/最近出现时间和访问次数，可以加备注、标记可疑或删除记录。

![连接和 IP 记录](docs/images/connections.png)

未备注的新来源会显示为“陌生”并亮起提醒。这个面板是辅助监控，不替代反向代理、身份访问控制或防火墙。

## 08 · Codex 用量只在需要时出现

只有当前聚焦的 Codex 窗口会在底部显示一条轻量用量栏：剩余百分比与重置时间。后台标签、其它分屏和其它工具不会重复请求；多个入口共享缓存和文件锁，服务端最多每 10 分钟读取一次。

![Codex 用量栏](docs/images/codex-usage.png)

## 09 · 手机上仍然是终端，不是缩小的桌面网页

移动端保留 `Esc`、`Tab`、`Ctrl`、方向键等辅助键。软键盘出现时，终端会按 Visual Viewport 重算高度，避免光标和输入位置被遮住。

<p align="center">
  <img src="docs/images/mobile-terminal.png" width="390" alt="移动端终端">
</p>

## 10 · 断线、刷新、滚轮和字体这些细节也算功能

- 浏览器断开只会分离 tmux 客户端，不会杀任务。
- 普通 Shell 的滚轮进入 tmux 历史，Claude/Codex 等 TUI 的滚轮交给应用自己。
- 终端字体随项目自带，减少 Windows 客户端缺字、方框和特殊符号错位。
- 中文输入法按 composition 生命周期处理，避免把合成中的文字拆成按键。
- 页面支持浅色/深色、高对比度、减少动画和可安装 Web App 布局。

这些问题为何出现、最后怎样处理，见 [曾经解决过的问题](docs/PROBLEMS_SOLVED.md)。

## 操作手册

[可视化操作手册](docs/VISUAL_GUIDE.md) 按实际点击顺序说明：

- 新建与恢复终端
- 分屏、切换、交换和关闭
- 滚动历史、选择、复制与粘贴
- 粘贴截图或拖入图片
- 文件管理与预览
- GPU、磁盘与目录扫描
- 在线连接与 IP 记录
- Codex 用量与移动端操作

## 它是怎么工作的

```text
浏览器 xterm.js
      │ WebSocket
      ▼
FastAPI 后端 ── attach ── tmux session ── Claude / Codex / OpenCode / Shell
      │
      └── 文件、资源、在线状态等 REST API
```

核心原则只有一个：**浏览器连接和终端进程不是一回事。**

## 常用配置

| 环境变量 | 默认值 | 人话说明 |
| --- | --- | --- |
| `CC_WEB_HOST` | `127.0.0.1` | 服务监听地址。不要直接暴露到公网。 |
| `CC_WEB_PORT` | `8000` | 服务端口。 |
| `CC_WEB_AUTH` | `1` | 是否启用 Token 登录。只有纯本机调试才能设为 `0`。 |
| `CC_WEB_TOKEN` | 启动时随机生成 | 自定义登录 Token。建议使用长随机值。 |
| `CC_WEB_ROOTS` | 当前用户家目录 | 文件 API 可以访问的根目录，多个目录用逗号分隔。 |
| `CC_WEB_DEFAULT_DIR` | 当前用户家目录 | 新终端默认打开的位置。 |
| `CC_WEB_CLAUDE` | 自动查找 | `claude` 可执行文件路径。 |
| `CC_WEB_CODEX` | 自动查找 | `codex` 可执行文件路径。 |
| `CC_WEB_OPENCODE` | 自动查找 | `opencode` 可执行文件路径。 |
| `CC_WEB_DISK_ROOTS` | 当前用户家目录 | 资源面板允许执行 `du` 的目录。 |

更多环境变量、systemd 和 Caddy 示例见 [部署与配置](docs/DEPLOYMENT.md)。

## 安全边界

这不是普通网页。拿到访问权限的人，通常也就拿到了运行服务的系统用户权限，因此应该像保护 SSH 一样保护它。

- 保持 `CC_WEB_AUTH=1`。
- 公网访问必须使用 HTTPS，并建议再加一层身份访问控制或来源限制。
- 不要把 `CC_WEB_ROOTS` 直接设为 `/`。
- 不要提交 `.env`、Token、证书、日志和状态 JSON。
- 当前没有多租户隔离、角色权限和只读访客模式。

登录状态使用 HttpOnly、SameSite Cookie；Token 不进入下载链接、WebSocket URL、浏览器历史或代理访问日志。详见 [安全策略](SECURITY.md)。

## 测试

```bash
python -m unittest discover -s tests -v
node --check frontend/app.js
bash -n run.sh
```

## 开源协议

项目代码使用 [MIT License](LICENSE)。内置 xterm.js 和 DejaVu 字体遵循各自协议，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
