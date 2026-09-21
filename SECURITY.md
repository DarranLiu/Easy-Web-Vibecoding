# Security Policy

**English** · [简体中文](SECURITY.zh-CN.md)

## Read this first

Easy Web Vibecoding provides remote terminal access. An authenticated operator can generally act with the permissions of the operating-system account running the service. Protect it as carefully as SSH.

## Supported versions

Security fixes are applied to the latest release and the current `main` branch. Older releases may not receive backports.

## Deployment checklist

- Keep `CC_WEB_AUTH=1`.
- Use a long random token stored in a mode `0600` environment file.
- Listen on `127.0.0.1` and enter through an HTTPS reverse proxy, VPN, or secure tunnel.
- Add identity-aware access control or a source allowlist for internet-facing deployments.
- Limit `CC_WEB_ROOTS` and `CC_WEB_DISK_ROOTS` to directories the service actually needs.
- Review the Online and IP Records views periodically.
- Never commit state JSON, logs, certificates, `.env`, access tokens, or real deployment screenshots.

After login, the browser receives a server-signed session proof instead of the master token. The cookie is `HttpOnly`, `SameSite=Strict`, expires on the server after 30 days, and receives `Secure` on HTTPS. Tokens do not appear in browser storage, download links, or WebSocket URLs.

## Known boundaries

- Authentication uses one shared token; this is not a multi-user authorization system.
- Every authenticated operator can access shared terminals, configured files, resource status, and connection records.
- The terminal inherits all file, process, and SSH permissions of the service account.
- Directory allowlists constrain file APIs, but commands entered in a terminal can still do anything allowed to the service account.
- Source-IP records are an auditing aid, not a firewall.

## Privacy-sensitive data

- Tab metadata, configured directories, GPU hosts, and IP records are stored in local JSON files with mode `0600`.
- IP records contain the source address, device class, first/last seen times, and visit count. They can be deleted in the interface.
- GPU monitoring reads process names but not full command arguments, reducing exposure of tokens and private paths.
- Browser `localStorage` contains layout, terminal IDs, and recent directories, but not the login token or terminal output.
- API and preview responses use `Cache-Control: no-store`; active media previews are sandboxed with CSP.
- File paths are normalized with real-path containment checks. File creation and uploads do not follow the final symbolic link; rename and delete operate on an in-root link itself rather than its target.
- Uvicorn access logging is disabled by default so file API query strings do not record absolute paths. Configure reverse-proxy logs the same way.
- Pasted images are saved unchanged under `.cc-web-images/` with directory mode `0700` and file mode `0600`. Embedded metadata such as EXIF is not stripped automatically.

## Report a vulnerability

Use GitHub's **Security > Report a vulnerability** private reporting flow. Include the affected version, impact, and the smallest sanitized reproduction you can provide.

Do not open a public issue containing access tokens, server addresses, private paths, logs, account details, or an unpatched exploit. You can expect an initial acknowledgement when a maintainer is available, but this volunteer project does not promise a fixed response or remediation deadline.
