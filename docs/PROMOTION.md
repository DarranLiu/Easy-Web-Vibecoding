# Launch and promotion kit

This document keeps public promotion accurate, repeatable, and free of private deployment details. Rewrite community posts in your own voice and check each community's current rules before publishing.

## One-sentence position

**Easy Web Vibecoding is a self-hosted browser workspace that keeps Claude Code, Codex, OpenCode, and shell sessions alive in tmux, with split panes, file tools, and machine monitoring.**

The strongest story is not "another web terminal." It is the collection of daily problems already solved: persistent coding-agent sessions, correct wheel behavior in shells and TUIs, cross-platform terminal fonts, image paste by path, restrained Codex usage polling, and a usable phone layout.

## Public assets

- Repository: <https://github.com/DarranLiu/Easy-Web-Vibecoding>
- Main workspace: `docs/images/desktop-split.png`
- New terminal flow: `docs/images/new-terminal.png`
- Copy and image workflows: `docs/images/copy-text.png`, `docs/images/send-image.png`
- Files and preview: `docs/images/files.png`, `docs/images/file-preview.png`
- Resources: `docs/images/resources-gpu.png`, `docs/images/resources-storage.png`
- Connections and mobile: `docs/images/connections.png`, `docs/images/mobile-terminal.png`

All included screenshots use synthetic data. Do not replace them with production captures unless every path, address, session name, account name, hostname, file, and hardware process has been reviewed.

For GitHub's social preview, upload `docs/images/desktop-split.png` under **Settings > General > Social preview**. GitHub recommends a 1280 x 640 image for best display; the supplied 1440 x 761 image is lightweight and close to that ratio. A purpose-made 1280 x 640 banner can replace it later.

## Launch order

1. Publish a tagged release and verify anonymous clone, installation, and screenshots.
2. Ask a small number of real users to install it and report setup friction. Do not ask for coordinated votes.
3. Publish one Chinese technical post built around a problem and its solution, not a list of features.
4. Publish one English post after incorporating the first feedback. Stay available to answer technical questions that day.
5. Turn the best questions into documentation, then share the improvement rather than reposting the same announcement.
6. After the first release is at least four months old, evaluate an awesome-selfhosted submission. Its current rules require that minimum release age and a tagged release.

Do not post the same text to many communities on the same day. Each community should receive a native explanation aimed at its users.

## Good channels

| Channel | Angle | Timing |
| --- | --- | --- |
| GitHub Topics and Releases | Search discovery and a stable install target | Launch day |
| GitHub Discussions | Support, use cases, screenshots, and roadmap feedback | Launch day |
| V2EX / Linux.do / relevant Chinese developer groups | A real remote coding workflow and the terminal problems solved | First week |
| Hacker News Show HN | tmux persistence and browser/TUI interaction engineering | After the project is easy to try and the author is an active HN participant |
| Relevant Reddit communities | Self-hosting or terminal workflow, subject to each community's rules | Staggered after first feedback |
| Personal blog / technical article | Deep dive into one hard problem with code and diagrams | Weeks 1-3 |
| Short demo video | 45-90 seconds: start agent, split pane, disconnect, resume, paste image | Weeks 1-2 |
| awesome-selfhosted | Long-term discovery | At least four months after v0.1.0 |

Hacker News asks Show HN authors to share something people can actually try, remain available for discussion, and never solicit votes. Reddit requires authentic participation and prohibits spam or vote manipulation. Follow those rules rather than optimizing for a one-day spike.

## Post drafts

### Chinese developer community

**Title**

```text
我把 Claude Code、Codex 和 OpenCode 做成了一个可恢复、可分屏的网页工作台
```

**Draft**

```text
我经常在远程服务器上同时跑几个 coding agent。普通网页终端最影响使用的不是“能不能输入命令”，而是断线后任务是否还在、滚轮到底应该滚 tmux 还是交给 TUI、Windows 是否缺字、手机键盘会不会挡住输入，以及复制和粘贴截图是否顺手。

所以我做了 Easy Web Vibecoding：后端把浏览器附着到真正的 tmux session，支持 Claude Code、Codex、OpenCode 和 Shell，最多四格分屏。浏览器关闭或后端重启不会杀掉任务；另外带文件预览、图片粘贴、GPU/磁盘查看和连接记录。

项目是 MIT 开源，README 里放了真实界面的完整截图和安全边界。现在最想听的是安装过程、终端交互和移动端体验里还有哪些实际问题。

GitHub: https://github.com/DarranLiu/Easy-Web-Vibecoding
```

### English community

**Title**

```text
I built a persistent split-screen web workspace for Claude Code, Codex, and OpenCode
```

**Draft**

```text
I use several coding agents on a remote Linux machine, and the difficult part was not getting a shell into a browser. It was keeping jobs alive across disconnects, making the wheel work in both tmux scrollback and full-screen TUIs, handling IME and clipboard behavior, and keeping the interface usable from Windows and a phone.

Easy Web Vibecoding attaches the browser to real tmux sessions and supports Claude Code, Codex, OpenCode, and a normal shell in up to four panes. It also includes allowlisted file tools, image paste by file path, GPU/storage views, and connection records.

It is MIT licensed and self-hosted. I would value feedback on installation friction and terminal behavior, especially from people who use remote coding agents every day.

https://github.com/DarranLiu/Easy-Web-Vibecoding
```

### Show HN

Suggested title:

```text
Show HN: Easy Web Vibecoding – persistent web terminals for coding agents
```

Write the first comment personally. Explain why you built it, the specific tmux/TUI wheel conflict, why browser disconnects do not own process lifetime, and what feedback you want. Do not paste generic launch copy, ask for votes, or use friends to seed comments.

## Technical article ideas

- Why a browser disconnect must not kill a coding-agent process.
- Making one mouse wheel work for tmux history and full-screen terminal apps.
- Browser terminal clipboard design that preserves `Ctrl+C`.
- Fixing missing terminal glyphs on unmanaged Windows machines.
- Pasting screenshots into CLI agents without a proprietary upload API.
- Polling Codex usage without waking every hidden terminal.
- What a shared-token remote terminal can and cannot secure.

Each article should include one diagram, one focused code path, one failure mode, and one reproducible result. Link to the repository once near the beginning and once at the end; the article should remain useful even if the reader never installs the project.

## Metrics that matter

Review GitHub traffic weekly, not hourly:

- unique visitors to clones;
- README visitor-to-star ratio;
- completed installs or useful support questions;
- returning discussion participants;
- issues that reveal a real workflow;
- external links that continue sending visitors after launch day.

Stars are a discovery signal, not the product goal. Avoid paid stars, star exchanges, giveaways tied to stars, automated direct messages, cross-community copy-paste, and coordinated voting. They produce poor feedback and can damage trust or violate platform rules.

## Thirty-day checklist

- [ ] Verify the public repository from a logged-out browser.
- [ ] Publish `v0.1.0` with a concise release summary.
- [ ] Upload a GitHub social preview.
- [ ] Pin a welcome discussion asking what environment people use.
- [ ] Recruit 3-5 genuine install testers.
- [ ] Publish one Chinese problem/solution post.
- [ ] Record a short, silent demo with synthetic data.
- [ ] Publish one English technical post or Show HN when appropriate.
- [ ] Turn repeated questions into FAQ or deployment documentation.
- [ ] Review traffic sources and invest in the channel that sends engaged users.
- [ ] Schedule the awesome-selfhosted eligibility date four months after the first release.
