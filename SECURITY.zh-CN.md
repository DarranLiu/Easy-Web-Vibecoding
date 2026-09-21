# Security Policy

[English](SECURITY.md) · **简体中文**

## 先说最重要的

这个项目提供远程终端能力。拿到访问权限的人，通常也就拿到了运行服务的系统用户权限。请像保护 SSH 一样保护它。

## 安全部署清单

- 保持 `CC_WEB_AUTH=1`。
- 使用长随机 Token，并放在权限为 `0600` 的环境文件中。
- 只监听 `127.0.0.1`，由 HTTPS 反向代理或安全隧道接入。
- 公网场景再加一层身份验证或 IP 白名单。
- 把 `CC_WEB_ROOTS` 和 `CC_WEB_DISK_ROOTS` 收到真正需要的目录。
- 定期检查“在线”和“IP 记录”面板。
- 不要提交状态 JSON、日志、证书、`.env` 或任何 Token。

登录成功后，浏览器使用 `HttpOnly`、`SameSite=Strict` Cookie。下载和 WebSocket URL 不携带 Token。HTTPS 请求会得到 `Secure` Cookie。

## 已知边界

- 当前是共享 Token，不是多用户权限系统。
- 所有通过认证的操作者都能看到共享终端、配置目录、资源状态和连接来源；只应向受信任的人提供 Token。
- 运行时使用服务账号现有的文件和 SSH 权限。
- 目录白名单阻止文件 API 越界，但终端本身仍能执行该系统用户有权执行的命令。
- 来源 IP 面板是辅助监控，不是防火墙。

## 隐私数据落点

- 服务端标签、目录、GPU 主机和 IP 记录保存在权限为 `0600` 的本地 JSON 文件中。
- IP 记录包含来源地址、设备类型及首次/最近出现时间，可在界面中删除。
- GPU 监控只读取进程名，不读取完整命令参数，避免参数中的密钥或私人路径进入 API。
- 浏览器只在 `localStorage` 保存界面布局、终端 ID 和最近目录，不保存登录 Token 或终端输出。
- API 与文件预览使用 `Cache-Control: no-store`；主动媒体预览带 CSP sandbox。
- 默认关闭 Uvicorn access log，避免文件 API 查询参数中的绝对路径进入日志；反向代理日志也应删除查询参数。
- 粘贴图片会原样保存到工作目录的 `.cc-web-images/`，权限为目录 `0700`、文件 `0600`；原图自带的 EXIF 等元数据不会自动删除。

## 报告问题

请使用 GitHub 的 **Security advisories / Report a vulnerability** 私下报告安全问题。不要在公开 Issue 中附带 Token、服务器地址、日志、目录结构或复现所需的真实账号信息。
