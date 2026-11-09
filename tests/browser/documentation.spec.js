const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { documentationWorkspace } = require('./documentation-fixture.cjs');

// All data and terminal output come from the isolated fixture, never a live server.
async function translatePreview(page) {
  await page.evaluate(() => {
    const dictionary = {
      '上次检测时间': 'Last checked at',
      '新终端 · 选择目录': 'New terminal · Choose directory', '在此目录开：': 'Start here:',
      'Claude · 新对话': 'Claude · New', 'Claude · 续上次': 'Claude · Continue',
      'Claude · 选会话': 'Claude · Resume', '普通终端': 'Shell',
      '发送图片到终端': 'Insert images into terminal', '点击选择图片': 'Choose images',
      '也可 Ctrl+V 粘贴 · 或把图片拖到这里': 'Paste with Ctrl+V or drop images here',
      '也可 ': 'Or ', ' · 或把图片拖到这里': ' or drop images here',
      ' · 或把图片': ' or ', '拖到这里': 'drop images here',
      '全部命令': 'All commands',
      '已选 1 张,点「发送到终端」': '1 image ready to insert',
      '选择文件或拖放': 'Choose or drop files', '每个不超过 100 MiB': '100 MiB per file',
      '应用并恢复会话': 'Apply & restore session', '新屏幕': 'New screen',
      '上级': 'Parent', '常用目录': 'Pinned directories', '个文件夹': 'folders',
      '显卡': 'GPUs', '添加': 'Add',
      '添加服务器 (IP 或 user@host)': 'Add server (IP or user@host)', '显示名(可选)': 'Name (optional)',
      '远程机器通过免密 SSH 读取 nvidia-smi,需要本机能直接 ssh 过去。': 'Remote machines use nvidia-smi over key-based SSH from this server.',
      '容量(df)实时读取;目录用量(du)在后台扫描后缓存 —— 点目录可逐层下钻,找出到底是谁占的空间。': 'Disk capacity is live; directory sizes are cached after background scans. Open a directory to inspect its usage.',
      '每个通过认证的 IP 都会被记下来。加了备注的算熟人,其余算陌生。': 'Authenticated connections are recorded. Add a note to identify a known source.',
      '新建工作区': 'New workspace', '工作区排序': 'Workspace order', '工作区与终端': 'Workspaces and terminals',
      '会话操作：': 'Session actions: ', '重命名': 'Rename', '窗格': 'Pane',
      '搜索命令、工作区或会话': 'Search commands or sessions',
      '搜索终端或目录': 'Search terminals or directories', '搜索当前目录': 'Search this directory',
      '输入服务器文件或文件夹路径': 'Enter a server file or directory path', '筛选当前目录': 'Filter this directory',
      '会话 UUID': 'session UUID',
      '运行权限': 'Permissions', '参考文件': 'References', '路径预览': 'Path preview',
      '按 ID 打开': 'Open by ID', '会话 ID': 'Session ID', '检查器': 'Inspector',
      '最近活跃': 'Recent activity', '名称 A–Z': 'Name A-Z', '手动排序': 'Manual order',
      '选择分屏终端': 'Choose split terminals', '当前屏幕已打开': 'Open on this screen',
      '其他屏幕已打开': 'Open on another screen',
      '本机': 'Local', '屏幕': 'Screen', '分屏显示': 'Show splits', '分屏': 'Split',
      '左右': 'Columns', '上下': 'Rows', '自动': 'Auto', '未打开': 'Not open',
      '已在当前屏幕打开': 'Open on this screen', '已在': 'Open in', '打开': 'Open',
      '前往': 'Go', '输入路径预览文件或文件夹': 'Enter a file or directory path',
      '输入服务器路径，支持相对路径和 ~/': 'Server path, relative path or ~/',
      '原文': 'Source', '渲染': 'Preview', '预览': 'Preview', '下载': 'Download',
      '列表': 'List', '网格': 'Grid', '新建文件夹': 'New folder', '新建文件': 'New file',
      '文件夹': 'folders', '个文件': 'files', '筛选文件': 'Filter files',
      '搜索文件': 'Search files', '上传': 'Upload', '粘贴': 'Paste', '复制': 'Copy',
      '选择图片或拖到这里': 'Choose or drop images here', '选择图片': 'Choose images',
      '点击选择文件，或拖入文件': 'Choose or drop files',
      '最多 10 个文件，每个不超过 100 MiB': 'Up to 10 files, 100 MiB each',
      '上传并插入': 'Upload & insert', '待上传': 'Pending upload', '移除': 'Remove',
      '发送到终端': 'Insert into terminal', '发送图片': 'Send image',
      '资源监控': 'Resources', '存储': 'Storage', '利用率': 'Usage', '显存': 'Memory',
      '无进程': 'No processes', '空闲': 'Idle', '占着显存': 'Memory held',
      '运行': 'Running', '占用': 'Held', '卡': 'GPU', '剩 ': 'Free ',
      '合计': 'Total', '上次扫描': 'Last scan', '耗时': 'Duration', '重新扫描': 'Rescan',
      '刚刚': 'Just now', ' 分钟前': ' minutes ago', ' 小时前': ' hours ago', ' 天前': ' days ago',
      '首次': 'First seen', '最近': 'Last seen', ' 次': ' visits',
      'IP 记录': 'Connections', '访问记录': 'Connections', '备注': 'Note',
      '标记可疑': 'Flag source', '删除': 'Delete', '陌生': 'Unknown',
      '启动配置：': 'Launch settings: ', '按需确认 · 工作目录可写': 'On request · Workspace write',
      '操作确认': 'Approval', '访问范围': 'Sandbox', '选择模式': 'Choose mode',
      '仅更改此会话的审批和沙盒模式；原有额外目录授权保留。无需确认不等于解除沙盒。': 'Changes only this session. Existing extra directory grants are retained; skipping approval does not remove the sandbox.',
      '应用并恢复': 'Apply & restore', '重新读取': 'Reload',
      '窗口 / 会话 ID': 'Window / session ID', '窗口 / Session ID': 'Window / session ID',
      '打开到': 'Open in', '加入分屏': 'Add to split', '运行中 · 直接打开': 'Running · Attach',
      '后重置': ' until reset', '资源': 'Resources', '关闭': 'Close',
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
    if (document.querySelector('.ui-dialog') && !document.querySelector('.ui-dialog').closest('.hidden')) {
      document.querySelector('.ui-dialog-title').textContent = 'Restart & restore Codex';
      document.querySelector('.ui-dialog-msg').textContent = 'This exits the selected agent and may interrupt work or discard unsent input. Restore original session 11111111-2222-4333-8444-555555555555, then wait for input. No message is sent automatically.';
    }
  });
}

async function paintDemo(page, locale) {
  await page.evaluate(async locale => {
    const demos = {
      codex: ['Codex', 'Review the API changes and run the tests.',
        'Updated src/routes.ts', 'Added focused regression coverage', 'PASS 24 tests', 'Ask Codex to do anything', 'demo-model · Ready · Context 73% left'],
      claude: ['Claude Code', 'Check the accessibility of the account settings.',
        'Reviewed keyboard focus and contrast', 'Updated labels in 3 components', 'Waiting for your review', 'Continue with the next change', 'demo-model · /workspace/tools'],
      shell: ['Project checks', '$ npm test', 'PASS session recovery', 'PASS independent split layout',
        'All checks passed.', '$ ', '/workspace/demo'],
    };
    if (locale !== 'en') {
      demos.codex = ['Codex', '检查接口修改，并运行相关测试。', '已更新 src/routes.ts', '已补充回归测试', '通过 24 项测试', '继续下一项任务', 'demo-model · 就绪 · 剩余上下文 73%'];
      demos.claude = ['Claude Code', '检查账号设置页面的无障碍体验。', '已检查键盘焦点与对比度', '已更新三个组件的标签', '等待你确认修改', '继续检查下一处', 'demo-model · /workspace/tools'];
      demos.shell = ['项目检查', '$ npm test', '通过：会话恢复', '通过：独立分屏布局', '全部检查通过。', '$ ', '/workspace/demo'];
    }
    for (const pane of panes) {
      const data = demos[pane.tab.type] || demos.shell;
      let output = '\x1b[2J\x1b[H\x1b[?25h\x1b[1m' + data[0] + '\x1b[0m\r\n\r\n' + data[1] + '\r\n\r\n';
      output += data.slice(2, 5).map(line => '\x1b[32m' + line + '\x1b[0m\r\n\r\n').join('');
      const row = Math.max(12, pane.term.rows - 4);
      output += `\x1b[${row};1H› ${data[5]}\x1b[${row + 2};1H${data[6]}\x1b[${row};3H`;
      await new Promise(resolve => pane.term.write(output, resolve));
    }
    window.ccNativeInput?.sync();
  }, locale);
}

for (const locale of ['en', 'zh-CN']) {
  test(`documentation previews use synthetic data and ${locale} labels`, async ({ page }, info) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await documentationWorkspace(page, locale);
    const untranslatedScreens = [];
    await page.waitForFunction(() => panes.length === 3 && panes.every(pane => pane.ws?.readyState === 1));
    await paintDemo(page, locale);
    async function snapshot(name) {
      await page.mouse.move(1400, 880);
      await page.waitForTimeout(250);
      if (locale === 'en') {
        await translatePreview(page);
        await page.waitForTimeout(100);
        await translatePreview(page);
        const untranslated = (await page.locator('body').innerText()).split('\n').filter(line => /[\u3400-\u9fff]/.test(line));
        untranslated.push(...await page.locator('[placeholder]:visible').evaluateAll(elements => elements.map(element => element.placeholder).filter(value => /[\u3400-\u9fff]/.test(value))));
        if (untranslated.length) untranslatedScreens.push({ name, untranslated });
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize().width);
      const destination = process.env.DOCS_SCREENSHOTS === '1'
        ? path.resolve(__dirname, '../../docs/images', locale === 'en' ? 'en' : '', name)
        : info.outputPath(name);
      await page.screenshot({ path: destination });
    }
    await snapshot('workspace.png');
    await page.locator('#header-split').click();
    await expect(page.locator('#ws-split-modal')).toBeVisible();
    await snapshot('screens.png');
    await page.locator('#ws-split-list input[data-session="demo01"]').uncheck();
    await page.locator('#ws-split-apply').click();
    await expect(page.locator('.pane')).toHaveCount(2);
    await paintDemo(page, locale);
    await snapshot('desktop-split.png');
    await snapshot('codex-usage.png');
    await page.locator('#btn-versions').click();
    await expect(page.locator('.version-row')).toHaveCount(3);
    await snapshot('updates.png');
    await page.locator('#versions-close').click();
    await page.locator('#btn-restart').click();
    await expect(page.locator('.ui-dialog')).toBeVisible();
    await snapshot('restart.png');
    await page.locator('.ui-dialog .ui-btn').first().click();
    await page.locator('#header-new').click();
    await expect(page.locator('#dir-modal')).toBeVisible();
    await snapshot('new-terminal.png');
    await page.locator('#dir-close').click();
    await page.locator('#btn-img').click();
    await page.locator('#img-file-input').setInputFiles(path.resolve(__dirname, '../../frontend/assets/mist-coast.png'));
    await expect(page.locator('#img-send')).toBeEnabled();
    await snapshot('send-image.png');
    await page.locator('#img-close').click();
    await page.locator('#btn-reference').click();
    await page.locator('#reference-input').setInputFiles([{ name: 'requirements.md', mimeType: 'text/markdown', buffer: Buffer.from('# Demo requirements') }, { name: 'results.csv', mimeType: 'text/csv', buffer: Buffer.from('check,result\ninput,pass\n') }]);
    await snapshot('reference-files.png');
    await page.locator('#reference-close').click();
    await page.locator('#btn-permissions').click();
    await expect(page.locator('#permission-sandbox')).toBeVisible();
    await snapshot('permissions.png');
    await page.keyboard.press('Escape');
    await page.locator('#workbench-lookup').click();
    await page.locator('#session-lookup-input').fill('11111111-2222-4333-8444-555555555555');
    await page.locator('#session-lookup-form button').click();
    await expect(page.locator('.session-lookup-row')).toHaveCount(1);
    await snapshot('session-lookup.png');
    await page.keyboard.press('Escape');
    await page.locator('#btn-files').click();
    await expect(page.locator('.fl-row[data-path="/workspace/demo/README.md"]')).toBeVisible();
    await snapshot('files.png');
    await page.locator('.fl-row[data-path="/workspace/demo/README.md"] .fl-name').click();
    await expect(page.locator('.fv-markdown')).toBeVisible();
    await snapshot('file-preview.png');
    await page.locator('#fv-close').click(); await page.locator('#files-close').click();
    await page.locator('#btn-gpu').click();
    await expect(page.locator('.gpu-card')).toHaveCount(2);
    await snapshot('resources-gpu.png');
    await page.locator('#tab-disk').click();
    await expect(page.locator('.du-row')).toHaveCount(4);
    await snapshot('resources-storage.png');
    await page.locator('#gpu-close').click();
    await page.evaluate(() => openIpsModal());
    await expect(page.locator('.ip-row')).toHaveCount(2);
    await snapshot('connections.png');
    await page.locator('#ips-close').click();
    await page.locator('#ws-deck-toggle').click();
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
    await paintDemo(page, locale);
    await snapshot('mobile-terminal.png');
    await page.locator('#recent-toggle').click();
    await expect(page.locator('#recent-sessions')).toBeVisible();
    await snapshot('mobile-recent.png');
    await page.locator('#recent-close').click();
    await page.locator('#cap-commands').click();
    await expect(page.locator('#quick-commands')).toBeVisible();
    await snapshot('mobile-commands.png');
    expect(fixture.requests.filter(request => /\/(?:restart|update)$/.test(request.path) && request.method === 'POST')).toEqual([]);
    expect(fixture.mutations.filter(request => /\/(?:restart|update|reference|image|open)$/.test(request.path))).toEqual([]);
    expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
    expect(fixture.errors).toEqual([]);
    expect(untranslatedScreens).toEqual([]);
  });
}
