const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { workspace } = require('./workspace-fixture.cjs');

// All data and terminal output come from the isolated fixture, never a live server.
async function translatePreview(page) {
  await page.evaluate(() => {
    const dictionary = {
      '当前窗口与安装版本不同': 'Window and installed versions differ',
      '当前窗口仍在运行旧版': 'This window is still running an older version',
      '已是官方最新版': 'Up to date', '正在检测官方版本': 'Checking official releases',
      '检测最新版本': 'Check latest', '版本与更新': 'Versions & updates',
      '重启并恢复': 'Restart & restore', '更新并恢复': 'Update & restore',
      '当前窗口': 'Running window', '共享安装': 'Shared installation', '官方最新': 'Official latest',
      '仅更新': 'Update only', '有新版本': 'Update available', '未运行': 'Not running',
      '目标窗口：': 'Target: ', '检测时间': 'Checked at', '重置': 'reset',
      '最近会话': 'Recent sessions', '快捷命令': 'Quick commands',
      '个窗口': 'windows', '模型': 'Model', '命令': 'commands',
      '工作区': 'Workspaces', '需要处理': 'Needs attention', '处理中': 'Working',
      '已停止': 'Stopped', '已完成': 'Complete', '已保存': 'Saved', '在线': 'Online',
      '运行中': 'Running', '就绪': 'Ready', '已连接': 'Connected', '终端': 'Terminal',
      '任务': 'Tasks', '全部': 'All', '当前': 'Current', '文件': 'Files', '活动': 'Activity',
      '设置': 'Settings', '新建': 'New', '保存': 'Save', '取消': 'Cancel',
      '搜索会话': 'Search sessions', '搜索工作区或会话': 'Search workspaces or sessions',
      '深色': 'Dark', '浅色': 'Light', '刷新': 'Refresh', '工具': 'Tools',
      '选择模型': 'Choose model', '切换模型': 'Choose model', '快速模式': 'Fast mode',
      '切换快速模式': 'Toggle fast mode', '查看状态': 'View status', '状态': 'Status',
      '查看模型': 'View models', '帮助': 'Help', '打开模型选择': 'Open model picker',
      '原生命令': 'Native commands', '新终端': 'New terminal', '刷新目录': 'Refresh directory',
      '未暂存': 'Unstaged', '已暂存': 'Staged', '暂存': 'Staged', '分支': 'Branch',
    };
    const entries = Object.entries(dictionary).sort((a, b) => b[0].length - a[0].length);
    const replace = text => entries.reduce((value, [from, to]) => value.split(from).join(to), text);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (node.parentElement.closest('.xterm,script,style')) continue;
      const updated = replace(node.textContent);
      if (updated !== node.textContent) node.textContent = updated;
    }
    for (const element of document.querySelectorAll('[title],[aria-label],[placeholder]')) {
      for (const attribute of ['title', 'aria-label', 'placeholder']) {
        if (element.hasAttribute(attribute)) element.setAttribute(attribute, replace(element.getAttribute(attribute)));
      }
    }
    if (document.querySelector('.ui-dialog')) {
      document.querySelector('.ui-dialog-title').textContent = 'Restart & restore Codex';
      document.querySelector('.ui-dialog-msg').textContent = 'This exits the selected agent and may interrupt work or discard unsent input. Restore original session 11111111-2222-4333-8444-555555555555, then wait for input. No message is sent automatically.';
    }
  });
}

async function paintDemo(page) {
  await page.evaluate(async () => {
    const demos = {
      codex: ['Codex', 'Review the API changes and run the tests.',
        'Updated src/routes.ts', 'Added focused regression coverage', 'PASS 24 tests', 'Ask Codex to do anything', 'demo-model · Ready · Context 73% left'],
      claude: ['Claude Code', 'Check the accessibility of the account settings.',
        'Reviewed keyboard focus and contrast', 'Updated labels in 3 components', 'Waiting for your review', 'Continue with the next change', 'demo-model · /workspace/tools'],
      shell: ['Project checks', '$ npm test', 'PASS session recovery', 'PASS independent split layout',
        'All checks passed.', '$ ', '/workspace/demo'],
    };
    for (const pane of panes) {
      const data = demos[pane.tab.type] || demos.shell;
      let output = '\x1b[2J\x1b[H\x1b[?25h\x1b[1m' + data[0] + '\x1b[0m\r\n\r\n' + data[1] + '\r\n\r\n';
      output += data.slice(2, 5).map(line => '\x1b[32m' + line + '\x1b[0m\r\n\r\n').join('');
      const row = Math.max(12, pane.term.rows - 4);
      output += `\x1b[${row};1H› ${data[5]}\x1b[${row + 2};1H${data[6]}\x1b[${row};3H`;
      await new Promise(resolve => pane.term.write(output, resolve));
    }
    window.ccNativeInput?.sync();
  });
}

for (const locale of ['en', 'zh-CN']) {
  test(`documentation previews use synthetic data and ${locale} labels`, async ({ page }, info) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await workspace(page, 'dark', {
      initial: { panes: ['demo02', 'demo03', 'demo01'], active: 'demo02' },
    });
    await page.waitForFunction(() => panes.length === 3 && panes.every(pane => pane.ws?.readyState === 1));
    await paintDemo(page);
    async function snapshot(name) {
      await page.mouse.move(1400, 880);
      await page.waitForTimeout(250);
      if (locale === 'en') {
        await translatePreview(page);
        await page.waitForTimeout(100);
        await translatePreview(page);
        expect(await page.locator('body').innerText()).not.toMatch(/[\u3400-\u9fff]/);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize().width);
      const destination = process.env.DOCS_SCREENSHOTS === '1'
        ? path.resolve(__dirname, '../../docs/images', locale === 'en' ? 'en' : '', name)
        : info.outputPath(name);
      await page.screenshot({ path: destination });
    }
    await snapshot('workspace.png');
    await snapshot('desktop-split.png');
    await page.locator('#btn-versions').click();
    await expect(page.locator('.version-row')).toHaveCount(3);
    await snapshot('updates.png');
    await page.locator('#versions-close').click();
    await page.locator('#btn-restart').click();
    await expect(page.locator('.ui-dialog')).toBeVisible();
    await snapshot('restart.png');
    await page.locator('.ui-dialog .ui-btn').first().click();
    await page.locator('[data-panel="files"]').click();
    await page.locator('.ws-row[data-file="/workspace/demo/index.js"]').click();
    await expect(page.locator('#ws-editor-text')).toHaveValue('export const answer = 42;\n');
    await snapshot('workspace-files.png');
    await page.locator('[data-panel="git"]').click();
    await page.locator('.ws-row', { hasText: 'index.js' }).click();
    await expect(page.locator('.ws-diff')).toContainText('+new');
    await snapshot('workspace-git.png');
    await page.locator('#ws-deck-toggle').click();
    await page.evaluate(() => active.term.select(0, 0, 5));
    await snapshot('copy-text.png');
    await page.evaluate(() => active.term.clearSelection());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => panes.length === 1 && active?.ws?.readyState === 1);
    await page.evaluate(() => openTab(state.tabs.find(tab => tab.id === 'demo02')));
    await page.waitForFunction(() => active?.tab?.id === 'demo02' && active?.ws?.readyState === 1);
    await paintDemo(page);
    await snapshot('mobile-terminal.png');
    await page.locator('#recent-toggle').click();
    await expect(page.locator('#recent-sessions')).toBeVisible();
    await snapshot('mobile-recent.png');
    await page.locator('#recent-close').click();
    await page.locator('#cap-commands').click();
    await expect(page.locator('#quick-commands')).toBeVisible();
    await snapshot('mobile-commands.png');
    expect(fixture.requests.filter(request => /\/(?:restart|update)$/.test(request.path) && request.method === 'POST')).toEqual([]);
    expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}
