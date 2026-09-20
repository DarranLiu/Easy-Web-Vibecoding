# Contributing

欢迎修复问题和改进交互。提交前请做到：

1. 不提交 Token、证书、日志、真实 IP、用户名或服务器路径。
2. 新增环境相关能力时，默认值必须能在普通用户目录中工作。
3. UI 改动同时检查桌面、窄屏和手机宽度。
4. 运行测试：

```bash
python -m unittest discover -s tests -v
node --check frontend/app.js
```

涉及终端输入、滚轮、剪贴板、IME 或 WebSocket 的改动，请在普通 Shell 和至少一种全屏 TUI 中都实际验证。
