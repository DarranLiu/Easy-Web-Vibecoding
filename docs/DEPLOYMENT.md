# 部署与配置

## 推荐结构

```text
浏览器 ── HTTPS ── 访问控制 / 反向代理 ── 127.0.0.1:8000 ── CC Terminal
```

后端默认只监听回环地址。远程访问建议使用 Cloudflare Tunnel、Tailscale、SSH 端口转发，或你已经维护好的 HTTPS 反向代理。

## 使用固定 Token

```bash
export CC_WEB_TOKEN='用密码管理器生成的长随机值'
export CC_WEB_ROOTS="$HOME/projects,$HOME/sandbox"
export CC_WEB_DEFAULT_DIR="$HOME/projects"
./run.sh
```

不要把真实 Token 写进 `.env.example`、systemd 模板或 Git 仓库。

## systemd 用户服务

仓库提供 [deploy/easy-web-vibecoding.service.example](../deploy/easy-web-vibecoding.service.example)。复制前先替换其中的安装目录，并通过权限为 `0600` 的 EnvironmentFile 提供 Token：

```bash
mkdir -p ~/.config/easy-web-vibecoding ~/.config/systemd/user
cp deploy/easy-web-vibecoding.service.example \
  ~/.config/systemd/user/easy-web-vibecoding.service
chmod 600 ~/.config/easy-web-vibecoding/env
systemctl --user daemon-reload
systemctl --user enable --now easy-web-vibecoding.service
```

示例新增 `KillMode=process`：重启 Web 服务时，不应连带终止最初由该服务启动的 tmux。已有部署升级前请核对这个设置。它会有意保留分离的任务，任务需在终端界面中明确管理。

示例环境文件：

```bash
CC_WEB_TOKEN=replace-with-a-long-random-token
CC_WEB_ROOTS=/home/your-user/projects
CC_WEB_DEFAULT_DIR=/home/your-user/projects
```

## Caddy

[deploy/Caddyfile.example](../deploy/Caddyfile.example) 演示了普通 HTTPS 反向代理。证书、域名和日志位置必须由部署者自己决定，仓库不附带任何证书。

## 所有环境变量

### 网络与鉴权

| 变量 | 作用 |
| --- | --- |
| `CC_WEB_HOST` | 监听地址，默认 `127.0.0.1`。 |
| `CC_WEB_PORT` | 监听端口，默认 `8000`。 |
| `CC_WEB_AUTH` | `1` 启用鉴权；`0` 仅供本机调试。 |
| `CC_WEB_TOKEN` | 登录 Token。`run.sh` 未收到时会临时生成。 |
| `CC_WEB_TOKEN_FILE` | 非交互启动时保存随机 Token 的私有文件；默认 `~/.cc-web-token`。 |

### 目录与程序

| 变量 | 作用 |
| --- | --- |
| `CC_WEB_ROOTS` | 文件 API 的根目录白名单，逗号分隔。 |
| `CC_WEB_DEFAULT_DIR` | 目录选择器默认位置。 |
| `CC_WEB_CLAUDE` | Claude Code 可执行文件。 |
| `CC_WEB_CODEX` | Codex 可执行文件。 |
| `CC_WEB_OPENCODE` | OpenCode 可执行文件。 |
| `CC_WEB_CODEX_MODEL_CATALOG` | Codex 模型目录 JSON；空字符串关闭覆盖。 |
| `CC_WEB_CODEX_STATUS_LINE` | Codex 原生底栏项目，逗号分隔。 |
| `CC_WEB_CODEX_SCROLLBACK` | 默认 `1`，新建 Codex 使用内联历史；设为 `0` 可选择原生全屏模式。 |
| `CC_WEB_DISK_ROOTS` | 允许资源面板执行 `du` 的根目录，逗号分隔。 |

### 状态文件

下面这些变量通常不需要修改，默认都写在当前用户家目录：

| 变量 | 作用 |
| --- | --- |
| `CC_WEB_STORE` | 终端标签元数据。 |
| `CC_WEB_GROUPS` | 目录分组名称。 |
| `CC_WEB_MANUAL` | 手工分组。 |
| `CC_WEB_GPU_HOSTS` | GPU 主机列表。 |
| `CC_WEB_DISK_CACHE` | 磁盘扫描缓存。 |
| `CC_WEB_PRESENCE` | 当前在线状态。 |
| `CC_WEB_KNOWN_IPS` | 已见过的来源 IP。 |
| `CC_WEB_AGENT_RUNTIME_DIR` | 原会话绑定及私有恢复计划；默认 `~/.cache/cc-web-terminal/sessions`。 |
| `CC_WEB_AGENT_UPDATE_DIR` | 更新状态、暂存版本及回退记录；默认 `~/.cache/cc-web-terminal/updates`。 |
| `CC_WEB_TERMINAL_LAUNCHER_DIR` | 仅属主可访问的网页启动保护入口；默认 `~/.cache/cc-web-terminal/bin`。 |
| `CC_WEB_WORKSPACE_DB` | 工作区、设备布局和活动元数据的 SQLite 文件；默认 `~/.cache/cc-web-workspaces/state.sqlite3`。 |

状态文件可能包含目录、主机名和来源 IP，不应提交到 Git。程序会强制使用 `0600`；从旧版本升级后，下一次写入也会收紧已有文件权限。

浏览器端不会保存 Token，但会在 `localStorage` 中保留主题、布局、终端 ID 和最近打开的文件目录，方便恢复界面。共享电脑上使用独立浏览器用户配置，并在不再使用时清理该站点数据。

会话绑定可能包含恢复工具所需的启动配置；活动记录只保存状态元数据，不保存提问或终端输出。它们都属于私有数据，不要把这些路径指向准备公开的仓库。使用共享安装更新前请阅读 [更新与恢复说明](UPDATES.md)。

`run.sh` 和 systemd 示例默认使用 `--no-access-log`。文件浏览、预览和磁盘下钻的 URL 查询参数可能包含绝对路径；如果在 Caddy、Nginx 或其它入口启用访问日志，请配置为不记录查询参数，或只记录路由和状态码。

## 多进程说明

用量、在线状态和磁盘扫描都使用带文件锁的共享状态，因此可以同时运行一个内网入口和一个 HTTPS 入口。不要把这些状态文件放在不支持 POSIX `flock` 的网络文件系统上。
