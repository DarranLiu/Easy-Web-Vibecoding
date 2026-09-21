# Deployment and configuration

[简体中文](DEPLOYMENT.md) · **English**

## Recommended topology

```text
Browser ── HTTPS ── access control / reverse proxy ── 127.0.0.1:8000 ── CC Terminal
```

The backend listens only on loopback by default. For remote access, use a maintained HTTPS reverse proxy, VPN, secure tunnel, or SSH port forwarding. Do not expose the application directly over plain HTTP on the internet.

## Set a stable token

```bash
export CC_WEB_TOKEN='a-long-random-value-from-your-password-manager'
export CC_WEB_ROOTS="$HOME/projects,$HOME/sandbox"
export CC_WEB_DEFAULT_DIR="$HOME/projects"
./run.sh
```

Never put a real token in `.env.example`, a systemd template, a shell history shared with others, or the Git repository.

## systemd user service

The repository includes [deploy/easy-web-vibecoding.service.example](../deploy/easy-web-vibecoding.service.example). Replace the installation path, then provide the token through an environment file with mode `0600`:

```bash
mkdir -p ~/.config/easy-web-vibecoding ~/.config/systemd/user
cp deploy/easy-web-vibecoding.service.example \
  ~/.config/systemd/user/easy-web-vibecoding.service
chmod 600 ~/.config/easy-web-vibecoding/env
systemctl --user daemon-reload
systemctl --user enable --now easy-web-vibecoding.service
```

Example environment file:

```bash
CC_WEB_TOKEN=replace-with-a-long-random-token
CC_WEB_ROOTS=/home/your-user/projects
CC_WEB_DEFAULT_DIR=/home/your-user/projects
```

## Caddy

[deploy/Caddyfile.example](../deploy/Caddyfile.example) demonstrates a basic HTTPS reverse proxy. You are responsible for the certificate, domain, access policy, and log destination. The repository does not ship any certificate or production hostname.

## Environment variables

### Network and authentication

| Variable | Purpose |
| --- | --- |
| `CC_WEB_HOST` | Listen address; defaults to `127.0.0.1`. |
| `CC_WEB_PORT` | Listen port; defaults to `8000`. |
| `CC_WEB_AUTH` | `1` enables authentication. Use `0` only for local testing. |
| `CC_WEB_TOKEN` | Shared login token. `run.sh` generates one when absent. |
| `CC_WEB_TOKEN_FILE` | Private file used for a generated token during non-interactive startup; defaults to `~/.cc-web-token`. |

### Directories and executables

| Variable | Purpose |
| --- | --- |
| `CC_WEB_ROOTS` | Comma-separated file API root allowlist. |
| `CC_WEB_DEFAULT_DIR` | Initial directory in the directory picker. |
| `CC_WEB_CLAUDE` | Path to the Claude Code executable. |
| `CC_WEB_CODEX` | Path to the Codex executable. |
| `CC_WEB_OPENCODE` | Path to the OpenCode executable. |
| `CC_WEB_CODEX_MODEL_CATALOG` | Codex model catalog JSON; an empty string disables the override. |
| `CC_WEB_CODEX_STATUS_LINE` | Comma-separated items for the native Codex status line. |
| `CC_WEB_DISK_ROOTS` | Comma-separated roots that the resource panel may scan with `du`. |

### State files

These variables normally do not need to change. Their defaults are files under the current user's home directory:

| Variable | Purpose |
| --- | --- |
| `CC_WEB_STORE` | Terminal tab metadata. |
| `CC_WEB_GROUPS` | Directory group names. |
| `CC_WEB_MANUAL` | Manually configured groups. |
| `CC_WEB_GPU_HOSTS` | GPU host list. |
| `CC_WEB_DISK_CACHE` | Disk scan cache. |
| `CC_WEB_PRESENCE` | Current presence state. |
| `CC_WEB_KNOWN_IPS` | Previously seen source IPs. |

State files may contain directories, hostnames, and source IP addresses. They must not enter Git. The application enforces mode `0600`; the next write after upgrading also tightens permissions on older files.

The browser does not store the login token. It does keep the theme, layout, terminal IDs, and recent file directories in `localStorage` so the workspace can recover. Use a separate browser profile on shared machines and clear the site's data when access is no longer needed.

`run.sh` and the systemd example use `--no-access-log` by default. File browsing, preview, and disk drill-down query strings can include absolute paths. If Caddy, Nginx, or another edge service logs requests, remove query strings or record only the route and status.

## Multiple backend processes

Usage, presence, and disk scanning use shared state with file locks, so an internal and an HTTPS entry point can run at the same time. Do not put these state files on a network filesystem without POSIX `flock` support.
