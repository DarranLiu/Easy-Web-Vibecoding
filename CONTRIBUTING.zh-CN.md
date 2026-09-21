# 参与贡献

[English](CONTRIBUTING.md) · **简体中文**

欢迎修复问题和改进交互。提交前请做到：

1. 不提交 Token、证书、日志、真实 IP、用户名或服务器路径。
2. 新增环境相关能力时，默认值必须能在普通用户目录中工作。
3. UI 改动同时检查桌面、窄屏和手机宽度。
4. 运行测试：

```bash
python3 -m unittest discover -s tests -v
node --check frontend/app.js
```

涉及终端输入、滚轮、剪贴板、IME 或 WebSocket 的改动，请在普通 Shell 和至少一种全屏 TUI 中都实际验证。

## 贡献授权

提交代码、文档或其他内容，即表示你确认自己有权提交这些内容，并同意按照项目的 [MIT License](LICENSE) 授权该贡献，不附加额外条款。请不要提交雇主、客户或第三方的机密信息与无权再授权的内容。

项目目前不要求签署 CLA。版权仍归各自贡献者所有；项目名称和标识的使用边界见 [TRADEMARKS.md](TRADEMARKS.md)。

## 安全问题

漏洞、Token、真实服务器地址或可识别个人的信息不要放进公开 Issue。请按照 [安全策略](SECURITY.zh-CN.md) 使用 GitHub 私密漏洞报告。
