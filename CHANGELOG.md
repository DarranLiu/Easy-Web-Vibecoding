# Changelog

This project follows [Semantic Versioning](https://semver.org/) for tagged releases.

## [Unreleased]

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

[Unreleased]: https://github.com/DarranLiu/Easy-Web-Vibecoding/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/DarranLiu/Easy-Web-Vibecoding/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/DarranLiu/Easy-Web-Vibecoding/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DarranLiu/Easy-Web-Vibecoding/releases/tag/v0.1.0
