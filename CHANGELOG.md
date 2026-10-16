# Changelog

This project follows [Semantic Versioning](https://semver.org/) for tagged releases.

## [Unreleased]

## [0.2.0] - 2026-10-16

### Added

- CLI version management for Codex, Claude Code and OpenCode: running / shared installed / official latest versions, explicit latest checks, verified install-only updates, update-and-restore and conditional installation rollback.
- One-click exact-conversation restart with private persistent bindings, compatibility preflight, target identity checks, operation locks and post-launch verification. Supported agents started from a web shell can be tracked too.
- Compact workspace/session tree, cross-project split controls, device-specific independent layouts, task/activity panel, bounded history search, conflict-aware UTF-8 file editing and read-only Git diffs.
- Optional Mist Glass, edge glow, cursor trails and a subtle native input-region tint, with mobile and accessibility fallbacks.
- Mobile recent sessions, native slash-command menu and keyboard-free navigation keys.

### Fixed

- Web launches and manual `codex resume` no longer silently attach to a stale shared backend or pin an obsolete separate web installation.
- Restarts wait for the original shell and verify the exact restored conversation instead of treating a printed `resume` command as success. Install success and recovery success are reported separately.
- Fine-grained Codex wheel routing, wrapper/short-pane handling and fractional movement replace page-sized history jumps. Touch swipes remain available when selection mode is saved.
- Three-pane rearrangements explicitly position panes instead of leaving an empty fourth cell after divider reordering.
- Codex redraws do not repeatedly hide/show the input tint; unchanged layout measurements do not trigger extra full-screen refreshes.
- Web `Ctrl+C`, `Ctrl+Shift+C` and Mac `Cmd+C` only copy selected text. No selection or clipboard failure never sends an interrupt. Interruption has its own confirmed toolbar command.
- Terminal resizing follows its container as well as browser viewport changes; slow clients use bounded backpressure.
- The systemd example now uses `KillMode=process` to avoid killing detached tmux jobs when the web process restarts.

### Security and documentation

- Retained signed expiring cookies, real-path allowlists, safe file creation, sandboxed previews and private runtime files from the standalone release.
- Added bilingual update/recovery instructions, synthetic localized previews and new bundled-asset license notices. No server addresses, private transcripts, credentials or production backups are included.
- “Hot update” means switching the installation while leaving running processes alone. Explicit restart may interrupt work; it restores conversation history, not running computations.

See the [English / Chinese release notes](docs/releases/v0.2.0.md).

## [0.1.3] - 2026-09-27

### Fixed

- Fixed fullscreen Codex history getting stuck at a yellow tmux position such as `[2/2]`. The backend now checks the foreground program and inner screen, leaves stale copy-mode, and uses Codex's native PageUp/PageDown navigation. Inline terminals keep tmux scrollback.
- Kept wheel scrolling available while text selection mode blocks pointer clicks and drags.
- Accumulated small trackpad movements instead of forcing every event to scroll a whole line; reset fractional movement between gestures, directions and connections.
- Kept Ctrl+wheel zoom gestures out of terminal input and verified independent scrolling in split panes.

### Tests

- Added browser scroll regression coverage and offline full-screen/inline fixtures running in an isolated real tmux server. CI now runs the tmux integration tests too.

This release changes the backend as well as the frontend. See the [English / Chinese upgrade notes](docs/releases/v0.1.3.md).

## [0.1.2] - 2026-09-23

### Fixed

- Kept terminal input readable when a TUI draws a light background in dark mode, or a dark background in light mode. xterm now adjusts low-contrast text while preserving the program's background colors and terminal output.
- Synchronized all open panes when the system appearance changes, unless a light/dark preference was chosen manually.
- Synchronized appearance changes between browser tabs and handled invalid saved theme values consistently at startup.
- Versioned the updated frontend script so an ordinary page reload fetches the fix.

### Tests

- Added real-browser regression tests for indexed/RGB colors, dim placeholders, inverse text, four panes, theme switching, refresh, reconnect, cross-tab preferences, and mobile layout.

See the [English / Chinese release notes](docs/releases/v0.1.2.md) for the reported symptom, fix boundaries, and upgrade steps.

## [0.1.1] - 2026-09-21

### Security

- Replaced the raw-token authentication cookie with a server-signed, time-limited session proof.
- Normalized file allowlist checks with real paths and common-path containment.
- Prevented file creation and uploads from following final symbolic links.
- Made rename and delete act on an in-root symbolic link itself instead of its target.

## [0.1.0] - 2026-09-21

### Added

- Persistent browser terminals backed by tmux.
- Launchers for Claude Code, Codex, OpenCode, and a normal shell.
- Up to four resizable panes with tab and layout management.
- Terminal-aware wheel, selection, copy, paste, image, IME, and reconnect handling.
- Allowlisted file management and common file previews.
- GPU, storage, connection, and Codex usage views.
- Responsive desktop/mobile UI, bundled terminal fonts, themes, and PWA metadata.
- Token authentication with privacy-hardened cookies, state files, previews, and logging defaults.

[Unreleased]: https://github.com/DarranLiu/Easy-Web-Vibecoding/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/DarranLiu/Easy-Web-Vibecoding/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/DarranLiu/Easy-Web-Vibecoding/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/DarranLiu/Easy-Web-Vibecoding/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/DarranLiu/Easy-Web-Vibecoding/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DarranLiu/Easy-Web-Vibecoding/releases/tag/v0.1.0
