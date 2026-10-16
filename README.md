<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="docs/images/en/workspace.png" alt="Easy Web Vibecoding workspace with three independent terminals">
</p>

<h1 align="center">Easy Web Vibecoding</h1>

<p align="center">
  <strong>A persistent, split-screen web workspace for Claude Code, Codex, OpenCode, and your shell.</strong>
</p>

<p align="center">
  <a href="https://github.com/DarranLiu/Easy-Web-Vibecoding/actions/workflows/tests.yml"><img src="https://img.shields.io/github/actions/workflow/status/DarranLiu/Easy-Web-Vibecoding/tests.yml?style=flat&colorA=242424&colorB=3fb950" alt="Tests"></a>
  <a href="https://github.com/DarranLiu/Easy-Web-Vibecoding/releases"><img src="https://img.shields.io/github/v/release/DarranLiu/Easy-Web-Vibecoding?display_name=tag&style=flat&colorA=242424&colorB=58a6ff" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-58a6ff?style=flat&colorA=242424" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Python-3.10%2B-3776ab?style=flat&colorA=242424" alt="Python 3.10+">
  <img src="https://img.shields.io/badge/backend-FastAPI-009688?style=flat&colorA=242424" alt="FastAPI">
</p>

<p align="center">
  <strong>4</strong> terminal types · up to <strong>4</strong> panes · hot updates · one-click session recovery · desktop and mobile
</p>

Easy Web Vibecoding turns command-line coding agents already installed on your Linux server into a browser workspace. Its interface is called **CC Terminal**. It is not a model proxy and it does not relay model API traffic: `tmux + FastAPI + xterm.js` connect your browser to the real terminal process.

Close the tab, lose the network, or restart the web service. The job remains in tmux and can be resumed when you return.

**New in v0.2.0:** check CLI versions, update the shared installation without restarting running windows, and restart a selected agent back into its **original conversation**. The new workspace tree keeps session switching and cross-project splits in the sidebar.

> [!NOTE]
> Every screenshot below comes from the real interface rendered in a browser. Sessions, paths, IP addresses, files, and hardware data are synthetic and do not identify a real server.

## Quick start

**Linux or another Unix-like server**

```bash
git clone https://github.com/DarranLiu/Easy-Web-Vibecoding.git
cd Easy-Web-Vibecoding

export CC_WEB_ROOTS="$HOME/projects"
export CC_WEB_DEFAULT_DIR="$HOME/projects"
./run.sh
```

The first run creates `.venv`, installs the Python dependencies, and generates a random access token. An interactive launch prints the token to the terminal. A non-interactive launch stores it in `~/.cc-web-token` with mode `0600`, keeping it out of service logs.

By default the server only listens on:

```text
http://127.0.0.1:8000
```

The host needs Python 3.10+ and `tmux`. Install and sign in to Claude Code, Codex, or OpenCode separately; this project does not store their API keys. Read the [deployment guide](docs/DEPLOYMENT.en.md) before exposing it through a reverse proxy or tunnel.

## Visual tour

### Hot updates and one-click recovery

Open **Versions & updates** from the package icon. Compare the version in the current window, the shared installation, and the latest official release, then choose:

| Action | What happens |
| --- | --- |
| Check latest | Checks official release metadata. It does not install or restart anything. |
| Update only | Verifies and switches the shared CLI installation. Running windows keep their current process; new web and SSH launches under the same user use the new installation. |
| Update & restore | Installs the update, restarts only the selected window, then verifies that its original conversation loaded. |
| Restart & restore | Restarts the selected agent into its recorded session without installing an update. |
| Roll back installation | Returns to the saved previous installation when available. It does not roll back conversation data. |

![Running, installed and official versions with update and restore controls](docs/images/en/updates.png)

Recovery supports **Codex, Claude Code and OpenCode**, including supported agents started from a web shell. It records the session identity and checks the executable, supported launch arguments and target process before sending an exit or resume command. If the session cannot be identified safely, recovery is blocked or asks you to bind the exact original session. It never guesses another conversation with `--last` or `--continue`.

![Confirm restarting the exact original conversation](docs/images/en/restart.png)

> [!IMPORTANT]
> “Hot update” means updating the installation **without stopping existing processes**. It does not upgrade code inside a running CLI. Restarting an agent can interrupt work and discard unsent input; restoring its conversation does not resume an in-progress command or recover RAM after a host reboot. Other terminal windows are not restarted. See the [update and recovery guide](docs/UPDATES.en.md).

### Start the right tool in the right directory

Choose a project, then launch a new Claude session, resume Claude, start Codex, OpenCode, or a normal shell. Tools that are not installed are omitted instead of becoming broken menu items.

![New terminal and directory picker](docs/images/en/new-terminal.png)

### Work in up to four panes

Expand a workspace in the left sidebar to see its terminals. Click a session to focus it; use its split icon to add it beside another terminal, even from a different project. Switching workspaces changes navigation, not the panes already on screen. Up to four panes support draggable dividers and swapping; mobile and desktop layouts are saved separately.

![Two terminal panes](docs/images/en/desktop-split.png)

### Copy with Ctrl+C, interrupt deliberately

In the web terminal, `Ctrl+C`, `Ctrl+Shift+C`, and macOS `Cmd+C` **only copy selected text**. No selection or a clipboard error never becomes an interrupt. To cancel a command, use the separate **Interrupt current program** toolbar button and confirm. **Stop** still terminates the tmux session after confirmation. The copy button can also copy the screen; long press or right click requests the available scrollback.

![Terminal selection and copy feedback](docs/images/en/copy-text.png)

Text pastes directly into the focused terminal. The image action accepts a file, a clipboard screenshot, or drag and drop. It saves the image under `.cc-web-images/` in the working directory and inserts the path into the terminal instead of pushing binary data through the PTY.

![Paste or drag an image](docs/images/en/send-image.png)

### Manage and preview project files

Browse, filter, upload, download, create, rename, and delete files inside the `CC_WEB_ROOTS` allowlist.

![File manager](docs/images/en/files.png)

Preview common text, image, video, audio, and PDF files without opening a remote desktop.

![File preview](docs/images/en/file-preview.png)

The workspace file panel can edit UTF-8 files up to 512 KiB, detect conflicting saves, and preserve permissions. The Git panel shows branch, changes and diffs without staging or committing anything.

![Workspace file editor](docs/images/en/workspace-files.png)

### Monitor the machine without leaking command lines

The resource panel shows GPU memory, utilization, temperature, power, user, and process name. It deliberately omits full process arguments, where tokens and private paths often appear. Remote GPU hosts can be queried over key-based SSH.

![GPU resource monitor](docs/images/en/resources-gpu.png)

Storage starts with filesystem capacity and drills down into directory usage. Slow `du` scans run in the backend and are cached.

![Storage usage](docs/images/en/resources-storage.png)

### Recognize connected devices

The current release uses one shared token, not a multi-tenant account system. The connection view records authenticated source IPs, device classes, first/last seen times, and visit counts. You can add a note, flag an unfamiliar source, or remove a record.

![Connection records](docs/images/en/connections.png)

### Keep Codex usage subtle

Only the focused Codex pane shows its remaining percentage and reset time. Hidden tabs and other tools do not poll. Multiple entry points share a cache and file lock, so the server reads usage at most once every ten minutes.

![Codex usage indicator](docs/images/en/codex-usage.png)

### Use it from a phone

The mobile layout keeps practical terminal keys such as `Esc`, `Tab`, `Ctrl`, arrows and Enter. Tap the title for recent sessions, or the slash menu for native commands such as `/model` and `/fast` where supported. Commands are inserted without automatically pressing Enter; use the auxiliary keys to navigate native menus without opening the software keyboard. A swipe scrolls; holding still first allows text selection.

<p align="center">
  <img src="docs/images/en/mobile-terminal.png" width="390" alt="Mobile terminal workspace">
</p>

<p align="center">
  <img src="docs/images/en/mobile-recent.png" width="310" alt="Recent sessions on mobile">
  <img src="docs/images/en/mobile-commands.png" width="310" alt="Native slash commands on mobile">
</p>

### A quieter terminal workspace

Graphite is the default. Optional Mist Glass, edge glow, cursor trails and a subtle native input-region tint keep the real terminal input rather than adding another composer. Motion and transparency fall back appropriately for mobile, reduced-motion, data-saving and high-contrast settings. Effects do not change terminal output or call model APIs.

## Details that matter in daily use

- Browser disconnects detach the tmux client; they do not terminate the job.
- The wheel enters tmux history for inline terminals; full-screen Codex receives fine-grained native wheel input instead of page-sized jumps or a stale tmux snapshot.
- Bundled terminal fonts reduce missing symbols and alignment problems on Windows clients.
- IME composition is handled as composition, avoiding broken Chinese/Japanese/Korean input.
- Light, dark, high-contrast, reduced-motion, and installable PWA layouts are supported.
- API responses and file previews use `Cache-Control: no-store`.
- Slow browser connections apply bounded backpressure instead of building an unlimited terminal-output queue.

The [visual guide](docs/VISUAL_GUIDE.md) covers each workflow step by step in Chinese. The [problems solved](docs/PROBLEMS_SOLVED.en.md) and [v0.2.0 release notes](docs/releases/v0.2.0.md) explain the fixes and upgrade boundaries. English preview labels are translated for documentation; the shipped interface currently uses primarily Chinese controls.

## Architecture

```text
Browser / xterm.js
       │ WebSocket
       ▼
FastAPI backend ── attach ── tmux session ── Claude / Codex / OpenCode / Shell
       │
       └── file, resource, presence, and usage REST APIs
```

The core rule is simple: **a browser connection is not the terminal process**.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CC_WEB_HOST` | `127.0.0.1` | Listen address. Do not expose the app directly to the public internet. |
| `CC_WEB_PORT` | `8000` | Listen port. |
| `CC_WEB_AUTH` | `1` | Token authentication. Disable only for local testing. |
| `CC_WEB_TOKEN` | Random on first launch | Shared access token; use a long random value. |
| `CC_WEB_ROOTS` | Current user's home | Comma-separated allowlist for file APIs. |
| `CC_WEB_DEFAULT_DIR` | Current user's home | Initial directory for new terminals. |
| `CC_WEB_CLAUDE` | Auto-detected | Path to the `claude` executable. |
| `CC_WEB_CODEX` | Auto-detected | Path to the `codex` executable. |
| `CC_WEB_OPENCODE` | Auto-detected | Path to the `opencode` executable. |
| `CC_WEB_DISK_ROOTS` | Current user's home | Directories the resource panel may scan with `du`. |

See [deployment and configuration](docs/DEPLOYMENT.en.md) for every variable plus systemd and Caddy examples.

## Security model

This is a remote terminal. Anyone with access can generally act with the permissions of the service account, so protect it like SSH.

- Keep `CC_WEB_AUTH=1`.
- Use HTTPS plus an identity-aware proxy, VPN, or source allowlist for internet access.
- Restrict `CC_WEB_ROOTS`; do not casually set it to `/`.
- Share the token only with trusted operators. There are no per-user roles or read-only guests yet.
- Never commit `.env`, tokens, certificates, logs, state JSON, or real deployment screenshots.

Authentication exchanges the master token for a server-signed, time-limited HttpOnly and SameSite session cookie; the raw token is not stored in the browser. Tokens are kept out of download links, WebSocket URLs, browser history, and default access logs. Runtime state files use mode `0600`. Read the complete [security policy](SECURITY.md) and report vulnerabilities privately.

## Test

```bash
python3 -m unittest discover -s tests -v
node --check frontend/app.js
bash -n run.sh
npm ci
npx playwright install chromium
npm run test:browser
```

## Contributing and support

Bug reports, focused pull requests, and tested interaction improvements are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), use [GitHub Discussions](https://github.com/DarranLiu/Easy-Web-Vibecoding/discussions) for questions, and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

If this project makes a remote coding workflow easier, a GitHub star helps other developers find it.

## License and project identity

The source code is available under the [MIT License](LICENSE). Bundled xterm.js, Lucide icons and fonts retain their upstream licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). MIT covers the code, not an implied right to present a modified project as the official Easy Web Vibecoding distribution; see [TRADEMARKS.md](TRADEMARKS.md).
