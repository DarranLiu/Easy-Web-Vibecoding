# Updates and exact-session recovery

[简体中文](UPDATES.md) · **English**

## Update a CLI without stopping other windows

![Version management](images/en/updates.png)

1. Focus the terminal you want to inspect.
2. Open the package icon, **Versions & updates**.
3. Choose **Check latest**. The three columns distinguish the running process, the shared installation and the latest official release.
4. Choose **Update only** to install now but leave every running window alone. New launches use the updated installation.
5. Choose **Update & restore** only when the selected task can be interrupted. Review the confirmation before proceeding.

The web launcher and SSH use the same configured executable entry for the same system user. The updater verifies official download metadata and SHA-256, unpacks into staging, checks the version and required resume options offline, then switches the entry atomically. It does not overwrite a running executable or silently select an unrelated installation. An unrecognized, unsafe or unwritable installation is rejected; update it with its original package manager and check again.

Official version checks are explicit and cached. Opening a page does not force an installation or restart. Update downloads use supported official release sources, not a model endpoint. A failed metadata query is shown as unknown, never as proof that the installation is latest.

## Restart the original interactive terminal

![Exact-session restart confirmation](images/en/restart.png)

1. Use the circular-arrow action on a session, the terminal toolbar, or **Restart & restore** in version management.
2. Read the agent, directory and original session identity shown by the confirmation. Older Claude windows may require binding an exact session ID first.
3. Confirm. The backend rechecks the target process and recorded session, performs a graceful exit, waits for the original shell, and launches the exact resume command.
4. A successful result requires observing the original conversation loading. Printing a command or leaving `resume` at the shell prompt is not considered success.

Supported agents are Codex, Claude Code and OpenCode. A supported agent launched from a web shell can also be tracked. Plain shell programs have no universal conversation ID and are not automatically replayed. OpenCode must have an identifiable selected conversation, not just its home screen.

No prompts or draft input are replayed, no automatic “continue” message is sent, and no `--last`/`--continue` guess is used for exact recovery. Unsupported launch options, changed targets, missing transcripts and ambiguous session identity block the operation. Per-terminal locks and request identities prevent concurrent or repeated management commands, including after a lost HTTP response.

## What survives?

| Event | Expected result |
| --- | --- |
| Browser refresh, tab close or network loss | Detach/reconnect only; tmux and the CLI keep running. |
| Web backend restart | The existing tmux task stays alive; the page reconnects. |
| Install-only CLI update | Running processes stay on their existing version; new launches use the new installation. |
| Explicit restart-and-restore | The selected agent exits and resumes its saved conversation in a new process. In-progress work may be interrupted. |
| Host reboot or tmux killed | Conversation metadata may remain, but running jobs and RAM are not preserved. Recovery still requires the original transcript and compatible CLI. |

These are different operations. “Hot update” is not live replacement of code in an existing CLI, automatic task replay, or guaranteed compatibility with every future release.

## Failures and rollback

- Download or preflight failures do not intentionally exit the current task.
- An installed update and a successfully restored session are recorded separately. If installation succeeded but recovery was not confirmed, inspect the terminal before trying again; the server does not blindly resend the command.
- An older failed job can be marked superseded when a later installation is present. This does not retroactively confirm recovery of that old job.
- **Roll back installation**, when available, restores the saved executable entry. Existing processes are not restarted, and newer conversation formats are not rolled back. Major-version upgrades require extra confirmation.
- Back up your native tool's configuration and conversation data before an upgrade. Keep those backups private.

## Upgrade this web application from v0.1.x

This release changes Python code as well as versioned frontend assets. Updating the web source is separate from the in-app CLI updater.

1. Back up the checkout and private runtime state outside the repository. Keep the old release tag for source rollback; do not include credentials or transcripts in a public archive.
2. Stop or restart only the web backend through your existing service manager, not tmux or the agents. With systemd, use a narrow `KillMode=process` setup as in the provided service example.
3. Update the checkout, install `backend/requirements.txt` in its virtual environment, and restart the backend using the same user, token, paths and CLI entries.
4. Refresh the page. Existing tabs are imported into workspace navigation; layouts are stored separately by device. Verify the original sessions before intentionally restarting any agent.

Frontend-only asset changes require a page refresh, not a terminal restart. Python changes require a backend restart. There is no built-in Git self-updater for the web application.

## Private state

`CC_WEB_AGENT_RUNTIME_DIR` stores original-session bindings; `CC_WEB_AGENT_UPDATE_DIR` stores update/rollback metadata and staged releases; `CC_WEB_WORKSPACE_DB` stores workspace and layout metadata. These are private operational data, not distributable examples. Files use private permissions and session/update directories are owner-only. Do not upload them to GitHub or share them as a debugging attachment.

The shared token still grants access to the service account's terminal permissions. This feature does not add account switching, role isolation or a sandbox around shell access.
