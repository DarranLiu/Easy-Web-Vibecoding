# Contributing

**English** · [简体中文](CONTRIBUTING.zh-CN.md)

Bug fixes, focused features, documentation, and tested interaction improvements are welcome.

## Before opening a change

1. Search existing issues and discussions.
2. Use an issue or discussion for broad behavior changes before investing in a large implementation.
3. Keep pull requests scoped to one problem.
4. Do not include tokens, certificates, logs, real IP addresses, usernames, server paths, or customer data.

## Development checks

```bash
python3 -m unittest discover -s tests -v
node --check frontend/app.js
bash -n run.sh
```

UI changes should be checked at desktop, narrow desktop, and phone widths. Changes involving terminal input, wheel handling, clipboard behavior, IME, resize, or WebSockets should be exercised in a normal shell and at least one full-screen TUI.

Use environment-independent defaults that work from a normal user account. Update documentation and tests whenever a user-visible contract changes.

## Contribution license

By submitting code, documentation, or other material, you represent that you have the right to submit it and agree that your contribution is licensed under this project's [MIT License](LICENSE), without additional terms. Do not submit confidential material or content that an employer, client, or third party has not authorized you to license.

No Contributor License Agreement is currently required. Contributors retain copyright in their contributions. The project name and identity policy is separate from the source license; see [TRADEMARKS.md](TRADEMARKS.md).

## Security reports

Do not put vulnerabilities, credentials, private infrastructure, or personal data in a public issue. Follow [SECURITY.md](SECURITY.md) and use GitHub's private vulnerability reporting flow.
