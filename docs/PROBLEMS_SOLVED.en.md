# Problems this project has solved

[简体中文](PROBLEMS_SOLVED.md) · **English**

This is not a release log. It records concrete failures encountered while using coding-agent terminals through a browser and the behavior implemented in response.

| Problem | Current behavior |
| --- | --- |
| Closing the browser also lost the AI task | The task runs in tmux. Browser disconnects and backend restarts do not kill it. |
| The interface felt like a generic page rather than working software | The workspace uses compact, consistent type, spacing, focus, command bars, and light/dark states. |
| Some Windows computers showed boxes or corrupt glyphs | Terminal fonts are shipped with the app and backed by cross-platform fallbacks. |
| The wheel only moved the AI app, leaving normal shell history unreachable | Full-screen TUIs receive wheel input; a normal shell drives tmux copy-mode history. |
| One page could show only one terminal | Up to four panes support horizontal, vertical, and automatic layouts, draggable dividers, swapping, and independent reconnects. |
| The OpenCode action launched a different program | Frontend type, backend command, and executable detection are separate and covered by a contract test. |
| Codex models visible in a normal terminal were missing in the web launch | The web-launched process can reuse the local model catalog, with environment controls to disable or override it. |
| Codex footer information was clipped by terminal height | Account limits live in a separate row below the terminal; the native footer keeps model, state, and context. |
| The usage bar was too prominent and repeated in every pane | One thin indicator appears only for the currently focused Codex pane. |
| Web usage stayed stale after the desktop client changed | The backend returns the authoritative next-refresh time; the frontend no longer adds a second cache clock. |
| Several pages or backend processes could query usage together | HTTP/HTTPS processes share a cache and file lock; hidden pages and unfocused tools do not schedule requests. |
| A phone keyboard covered the terminal cursor | Visual Viewport changes resize the terminal and a second correction runs after the keyboard animation. |
| IME input sometimes lost characters | Composition events remain separate from ordinary key events. |
| Copy failed on a plain-HTTP LAN origin | HTTPS uses the Clipboard API; a controlled fallback remains for ordinary HTTP. |
| A TCP tunnel made every source IP look local | Trusted proxy information can restore the source; otherwise client ID and device data provide a fallback count. |
| Tokens appeared in WebSocket or download URLs | Login now issues a signed, time-limited HttpOnly session proof; the master token stays out of browser storage, URLs, history, and default proxy logs. |

The shared principle is that a terminal is a work tool: stable, recoverable, and quiet, without requiring users to memorize browser-specific rituals.
