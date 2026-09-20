# Security Policy

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
- 运行时使用服务账号现有的文件和 SSH 权限。
- 目录白名单阻止文件 API 越界，但终端本身仍能执行该系统用户有权执行的命令。
- 来源 IP 面板是辅助监控，不是防火墙。

## 报告问题

请使用 GitHub 的 **Security advisories / Report a vulnerability** 私下报告安全问题。不要在公开 Issue 中附带 Token、服务器地址、日志、目录结构或复现所需的真实账号信息。
