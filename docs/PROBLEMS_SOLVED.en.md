# Problems this project has solved

[简体中文](PROBLEMS_SOLVED.md) · **English**

This is not a release log. It records concrete failures encountered while using coding-agent terminals through a browser and the behavior implemented in response.

| Problem | Current behavior |
| --- | --- |
| Closing the browser also lost the AI task | The task runs in tmux. Browser disconnects and backend restarts do not kill it. |
| The interface felt like a generic page rather than working software | A compact workspace tree and collapsible task panel keep native terminal work central; optional glass/effects respect accessibility settings. |
| Some Windows computers showed boxes or corrupt glyphs | Terminal fonts are shipped with the app and backed by cross-platform fallbacks. |
| Codex input became almost invisible on a pale background in dark mode | xterm adjusts low-contrast text while retaining the program's explicit backgrounds. Theme changes update all open panes. See [v0.1.2](releases/v0.1.2.md). |
| The wheel only moved the AI app, leaving normal shell history unreachable | Full-screen TUIs receive wheel input; a normal shell drives tmux copy-mode history. |
| Codex stopped scrolling at a yellow `[2/2]` even though earlier messages existed | Fullscreen Codex now receives native wheel reports rather than tmux screen snapshots or page-sized jumps. Inline Codex keeps tmux history. Wrapper and short-pane cases are covered too. |
| Selecting text disabled scrolling, and tiny trackpad movements jumped too far | Selection mode now permits wheel reports while blocking pointer reports; fractional trackpad movement accumulates per pane. |
| One page could show only one terminal | Up to four panes support horizontal, vertical, and automatic layouts, draggable dividers, swapping, and independent reconnects. |
| The OpenCode action launched a different program | Frontend type, backend command, and executable detection are separate and covered by a contract test. |
| Codex models visible in a normal terminal were missing in the web launch | Web launches use the configured shared executable, resolve its current target, preserve the configured local catalog, and prevent stale daemon attachment. Availability still depends on the native tool, provider and account. |
| A manual `codex resume` connected to an older backend | Web-created shells and supported child launches use isolation guards; explicit attach-to-old-backend operations are rejected instead of silently changing routing. |
| Restart printed `resume` but did not enter the conversation | Restart waits for the original shell, resumes the recorded session ID and verifies that conversation loading was observed. An unconfirmed restore is not reported as success. |
| Updating one window risked interrupting others | Install-only updates leave running processes alone. Explicit update-and-restore targets one window, validates compatibility and does not restart other panes. |
| An old failed update looked like a current installation failure | Installed and restored outcomes are separate; superseded historic jobs do not imply successful recovery. |
| Workspace switching unexpectedly replaced the split layout | Workspace navigation and device-specific screen layouts are independent; sessions can be split across projects. |
| Three panes left an empty fourth cell after rearranging | Panes are positioned from the layout model, not the first DOM child among reordered divider nodes. |
| Codex output made the input background flash | Automatic output-follow is separated from manual history scrolling; brief TUI redraws retain confirmed tint and unchanged sizes no longer force a full refresh. |
| Copying accidentally cancelled the agent | Web Ctrl+C/Ctrl+Shift+C and Mac Cmd+C only copy selection. No selection or clipboard failure never falls through to SIGINT; interruption requires a separate confirmed command. |
| Codex footer information was clipped by terminal height | Account limits live in a separate row below the terminal; the native footer keeps model, state, and context. |
| The usage bar was too prominent and repeated in every pane | One thin indicator appears only for the currently focused Codex pane. |
| Web usage stayed stale after the desktop client changed | The backend returns the authoritative next-refresh time; the frontend no longer adds a second cache clock. |
| Several pages or backend processes could query usage together | HTTP/HTTPS processes share a cache and file lock; hidden pages and unfocused tools do not schedule requests. |
| A phone keyboard covered the terminal cursor | Visual Viewport changes resize the terminal and a second correction runs after the keyboard animation. |
| Switching mobile sessions meant searching again | A recent-session picker switches the single visible terminal. A native-command menu and auxiliary Enter/arrows avoid opening the keyboard for menu navigation. |
| IME input sometimes lost characters | Composition events remain separate from ordinary key events. |
| Copy failed on a plain-HTTP LAN origin | HTTPS uses the Clipboard API; a controlled fallback remains for ordinary HTTP. |
| A TCP tunnel made every source IP look local | Trusted proxy information can restore the source; otherwise client ID and device data provide a fallback count. |
| Tokens appeared in WebSocket or download URLs | Login now issues a signed, time-limited HttpOnly session proof; the master token stays out of browser storage, URLs, history, and default proxy logs. |

The shared principle is that a terminal is a work tool: stable, recoverable, and quiet, without requiring users to memorize browser-specific rituals.
