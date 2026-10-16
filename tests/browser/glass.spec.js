const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const frontend = process.env.WEBCC_FRONTEND || path.resolve(__dirname, '../../frontend');

const tabs = [
  { id: 'demo01', name: 'Workspace', cwd: '/workspace/demo', type: 'shell', alive: true, attached: 1 },
  { id: 'demo02', name: 'Codex', cwd: '/workspace/demo', type: 'codex', alive: true, codexScrollback: true },
  { id: 'demo03', name: 'Claude Code', cwd: '/workspace/demo', type: 'claude', alive: true },
  { id: 'demo04', name: 'OpenCode', cwd: '/workspace/demo', type: 'opencode', alive: true },
];
const files = ['src', 'README.md', 'package.json', 'notes.txt'].map((name, i) => ({
  name, path: '/workspace/demo/' + name, type: i ? 'file' : 'dir', size: i * 1024, mtime: 1700000000,
}));

const restartPreview = { ready: true, running: true, agent: 'codex',
  sessionId: '11111111-2222-4333-8444-555555555555', expected: 'synthetic-challenge' };

async function openRestartWorkspace(page) {
  const errors = await openWorkspace(page);
  await page.evaluate(() => {
    for (const tab of state.tabs.slice(1)) attachTerminal(tab, makePane());
    focusPane(panes[0], false);
    window.restartReferences = panes.map(p => ({ pane: p, term: p.term, ws: p.ws, gen: p.gen, id: p.tab.id }));
  });
  await page.waitForFunction(() => panes.every(p => p.ws?.readyState === 1));
  await page.route('**/api/sessions/*/restart', async route => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    if (route.request().method() === 'GET') return route.fulfill({ json: restartPreview });
    return route.fulfill({ json: { ...tabs.find(tab => tab.id === id), resumed: true } });
  });
  return errors;
}

async function assertRestartReferences(page) {
  expect(await page.evaluate(() => restartReferences.every(ref =>
    panes.includes(ref.pane) && ref.pane.term === ref.term && ref.pane.ws === ref.ws &&
    ref.pane.gen === ref.gen && ref.pane.tab.id === ref.id))).toBe(true);
}

const versionFixture = {
  sid: 'demo02', current: { agent: 'codex', version: '1.2.1' }, resume: restartPreview,
  agents: ['codex', 'claude', 'opencode'].map(agent => ({ agent, installed: '1.2.3', latest: '1.2.4',
    running: agent === 'codex' ? '1.2.1' : null, runningStatus: agent === 'codex' ? 'outdated' : 'unknown',
    status: 'outdated', canUpdate: true, checkedAt: 1800000000, checkId: 'synthetic-check', job: {} })),
};

async function openVersionWorkspace(page, theme = 'dark', data = versionFixture) {
  const errors = await openWorkspace(page, theme);
  await page.evaluate(() => {
    for (const tab of state.tabs.slice(1)) attachTerminal(tab, makePane());
    focusPane(panes[1], false);
    window.restartReferences = panes.map(p => ({ pane: p, term: p.term, ws: p.ws, gen: p.gen, id: p.tab.id }));
  });
  await page.route('**/api/agents/versions*', route => route.fulfill({ json: data }));
  await page.route('**/api/agents/versions/check', route => route.fulfill({ json: data }));
  await page.getByRole('button', { name: '版本与更新', exact: true }).click();
  await expect(page.locator('.version-row')).toHaveCount(3);
  return errors;
}

test('version panel distinguishes running, installed and official versions with no automatic check', async ({ page }) => {
  const requests = [];
  page.on('request', request => requests.push(request));
  const errors = await openVersionWorkspace(page);
  await expect(page.locator('#versions-target')).toContainText('Codex');
  const row = page.locator('.version-row[data-agent="codex"]');
  await expect(row.locator('dd')).toHaveText(['1.2.1', '1.2.3', '1.2.4']);
  await expect(row.locator('dt')).toHaveText(['当前窗口', '共享安装', '官方最新']);
  await expect(row.locator('.version-note')).toContainText('仍在运行旧版');
  expect(requests.filter(request => request.method() === 'POST' && request.url().includes('/api/agents'))).toHaveLength(0);
  await page.locator('#versions-check').click();
  await expect(page.locator('#versions-list')).toHaveAttribute('aria-busy', 'false');
  expect(requests.filter(request => request.url().endsWith('/versions/check'))).toHaveLength(1);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(errors).toEqual([]);
});

test('cancel update and version errors never issue an update POST', async ({ page }) => {
  const posts = [];
  await openVersionWorkspace(page);
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.locator('.version-row[data-agent="codex"]').getByRole('button', { name: '仅更新', exact: true }).click();
  await expect(page.locator('.ui-dialog-msg')).toContainText('当前运行的窗口不会重启');
  await expect(page.locator('.ui-dialog-msg')).toContainText('SSH');
  await page.locator('.ui-dialog .ui-btn').first().click();
  await expect(page.locator('.ui-dialog')).toHaveCount(0);
  await page.route('**/api/agents/versions/check', route => route.fulfill({ json: { ...versionFixture,
    agents: versionFixture.agents.map(row => ({ ...row, latest: null, status: 'unknown', canUpdate: false, error: '官方版本暂不可达' })) } }));
  await page.locator('#versions-check').click();
  await expect(page.locator('.version-row').first().locator('.version-note')).toContainText('官方版本暂不可达');
  await expect(page.locator('.version-row').first().getByRole('button', { name: '仅更新', exact: true })).toBeDisabled();
  expect(posts.filter(url => url.endsWith('/update'))).toEqual([]);
});

test('historical download failure does not imply the installed version or resume succeeded', async ({ page }) => {
  await openVersionWorkspace(page, 'dark', { ...versionFixture,
    agents: versionFixture.agents.map(row => ({ ...row, jobSuperseded: true,
      job: { phase: 'failed', mode: 'update-restart', sid: 'demo02', message: 'Old download failed' } })) });
  const note = page.locator('.version-row[data-agent="codex"] .version-note');
  await expect(note).toContainText('历史更新未完成');
  await expect(note).toContainText('该次会话恢复未确认');
  await expect(note).not.toContainText('Old download failed');
  await expect(note).not.toHaveClass(/warning/);
});

test('old update for another window does not imply this session failed recovery', async ({ page }) => {
  await openVersionWorkspace(page, 'dark', { ...versionFixture,
    agents: versionFixture.agents.map(row => ({ ...row, jobSuperseded: true,
      job: { phase: 'failed', mode: 'update-restart', sid: 'another-window', message: 'Old download failed' } })) });
  const note = page.locator('.version-row[data-agent="codex"] .version-note');
  await expect(note).toContainText('历史更新未完成');
  await expect(note).not.toContainText('会话恢复未确认');
  await expect(page.locator('.version-row[data-agent="codex"]').getByRole('button', { name: '重启并恢复', exact: true })).toBeEnabled();
});

test('unavailable native session keeps disabled recovery controls visible', async ({ page }) => {
  await openVersionWorkspace(page, 'dark', { ...versionFixture,
    resume: { ready: false, agent: 'codex', reason: '原程序正在退出' } });
  const row = page.locator('.version-row[data-agent="codex"]');
  await expect(row.locator('.version-note')).toContainText('原程序正在退出');
  await expect(row.getByRole('button', { name: '重启并恢复', exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: '重启并恢复', exact: true })).toBeDisabled();
});

test('install-only update is deduplicated and never sends restart or terminal input', async ({ page }) => {
  await openVersionWorkspace(page);
  const posts = [];
  let job = {};
  await page.route('**/api/agents/codex/update', route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      posts.push(body);
      job = { ...body, agent: 'codex', phase: 'downloading', message: '正在下载官方安装包' };
      return route.fulfill({ json: job });
    }
    job = { ...job, phase: 'done', installed: true, resumed: false, message: '新版已安装；运行中的窗口保持不变' };
    return route.fulfill({ json: job });
  });
  const button = page.locator('.version-row[data-agent="codex"]').getByRole('button', { name: '仅更新', exact: true });
  await button.click();
  await expect(button).toBeDisabled();
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('#toast')).toContainText('运行中的窗口保持不变', { timeout: 6000 });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ mode: 'update', sid: null, expected: null, confirmed: true, version: '1.2.4' });
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  await assertRestartReferences(page);
});

test('update-and-restore captures original conversation and never changes another split or focus', async ({ page }) => {
  await openVersionWorkspace(page);
  const posts = [];
  let job = {};
  await page.route('**/api/agents/codex/update', route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      posts.push(body);
      job = { ...body, agent: 'codex', phase: 'restarting', message: '恢复中' };
      return route.fulfill({ json: job });
    }
    return route.fulfill({ json: { ...job, phase: 'done', installed: true, resumed: true,
      result: { ...tabs[1], resumed: true }, message: '已恢复原会话' } });
  });
  await page.locator('.version-row[data-agent="codex"]').getByRole('button', { name: '更新并恢复', exact: true }).click();
  await expect(page.locator('.ui-dialog-msg')).toContainText(restartPreview.sessionId);
  await page.evaluate(() => focusPane(panes[3], false));
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('#toast')).toContainText('已恢复原会话', { timeout: 6000 });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ mode: 'update-restart', sid: 'demo02', expected: restartPreview.expected });
  expect(await page.evaluate(() => active.tab.id)).toBe('demo04');
  await assertRestartReferences(page);
});

test('changing captured pane while confirming cancels update-and-restore', async ({ page }) => {
  await openVersionWorkspace(page);
  const posts = [];
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.locator('.version-row[data-agent="codex"]').getByRole('button', { name: '更新并恢复', exact: true }).click();
  await page.evaluate(() => { versionTarget.pane.gen++; });
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('#toast')).toContainText('操作已取消');
  expect(posts.filter(url => url.endsWith('/update'))).toEqual([]);
});

test('lost update response polls state without retrying POST and does not claim success', async ({ page }) => {
  await openVersionWorkspace(page);
  let posts = 0, gets = 0;
  let requestId;
  await page.route('**/api/agents/codex/update', route => {
    if (route.request().method() === 'POST') { posts++; requestId = route.request().postDataJSON().requestId; return route.abort(); }
    gets++;
    return route.fulfill({ json: { requestId, phase: 'failed', agent: 'codex', message: '校验失败，原安装未改变' } });
  });
  await page.locator('.version-row[data-agent="codex"]').getByRole('button', { name: '仅更新', exact: true }).click();
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('#toast')).toContainText('校验失败', { timeout: 6000 });
  expect(posts).toBe(1);
  expect(gets).toBeGreaterThan(0);
});

test('rollback confirmation and action leave running windows intact', async ({ page }) => {
  await openVersionWorkspace(page, 'dark', { ...versionFixture,
    agents: versionFixture.agents.map(row => ({ ...row, canRollback: row.agent === 'codex' })) });
  const posts = [];
  await page.route('**/api/agents/codex/rollback', route => {
    posts.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, message: '已回退共享安装版本；运行中的窗口保持不变' } });
  });
  await page.locator('.version-row[data-agent="codex"]').getByRole('button', { name: '回退安装' }).click();
  await expect(page.locator('.ui-dialog-msg')).toContainText('不会回滚会话数据');
  await expect(page.locator('.ui-dialog-msg')).toContainText('SSH');
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('#toast')).toContainText('已回退');
  expect(posts).toEqual([{ version: '1.2.3', confirmed: true }]);
  await assertRestartReferences(page);
});

test('another agent update cannot poll away an unconfirmed update dialog', async ({ page }) => {
  await openVersionWorkspace(page);
  let codexGets = 0;
  await page.route('**/api/agents/codex/update', route => { codexGets++; return route.fulfill({ json: {} }); });
  await page.route('**/api/agents/claude/update', route => route.fulfill({ json: {
    requestId: 'synthetic-claude-job', agent: 'claude', phase: 'downloading', message: '正在下载官方安装包',
  } }));
  await page.evaluate(() => {
    versionJobs.set('claude', { requestId: 'synthetic-claude-job', phase: 'downloading' });
    scheduleVersionPoll();
  });
  await page.locator('.version-row[data-agent="codex"]').getByRole('button', { name: '仅更新', exact: true }).click();
  await page.waitForTimeout(1800);
  expect(codexGets).toBe(0);
  expect(await page.evaluate(() => versionJobs.get('codex').phase)).toBe('confirming');
  await page.locator('.ui-dialog .ui-btn').first().click();
  await expect.poll(() => page.evaluate(() => versionJobs.has('codex'))).toBe(false);
});

for (const theme of ['dark', 'light']) {
  for (const width of [320, 390, 1280]) {
    test(`${theme} version panel fits ${width}px and preserves terminal geometry`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const errors = await openVersionWorkspace(page, theme);
      await expect(page.locator('#versions-modal')).not.toHaveClass(/is-opening/);
      const dimensions = await page.evaluate(() => {
        const box = document.querySelector('.versions-box').getBoundingClientRect();
        return { left: box.left, right: box.right, bottom: box.bottom,
          overflow: document.querySelector('.versions-list').scrollWidth - document.querySelector('.versions-list').clientWidth,
          buttons: Array.from(document.querySelectorAll('.version-actions button')).map(b => ({ w: b.getBoundingClientRect().width, text: b.scrollWidth > b.clientWidth })) };
      });
      expect(dimensions.left).toBeGreaterThanOrEqual(0);
      expect(dimensions.right).toBeLessThanOrEqual(width);
      expect(dimensions.bottom).toBeLessThanOrEqual(844);
      expect(dimensions.overflow).toBeLessThanOrEqual(1);
      expect(dimensions.buttons.every(button => button.w > 0 && !button.text)).toBe(true);
      if (width === 390 || width === 1280) await page.screenshot({ animations: 'disabled', path: path.resolve(frontend, `../backups/previews/v88-updates-${width}-${theme}.png`) });
      await page.keyboard.press('Escape');
      await expect(page.locator('#versions-modal')).toHaveClass(/hidden/);
      await assertRestartReferences(page);
      expect(errors).toEqual([]);
    });
  }
}

test('targeted restart restores one split without replacing terminals, sockets or focus', async ({ page }) => {
  const errors = await openRestartWorkspace(page);
  const requests = [];
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/restart')) requests.push(req); });
  await page.locator('.pane').nth(1).locator('.pane-restart').click();
  await expect(page.locator('.ui-dialog-title')).toContainText('Codex');
  await expect(page.locator('.ui-dialog-msg')).toContainText(restartPreview.sessionId);
  await expect(page.locator('.ui-dialog-msg')).toContainText('不自动发送');
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('#toast')).toContainText('已恢复');
  expect(requests).toHaveLength(1);
  expect(requests[0].url()).toContain('/demo02/restart');
  expect(requests[0].postDataJSON()).toMatchObject({ expected: restartPreview.expected, confirmed: true });
  expect(requests[0].postDataJSON().requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  await assertRestartReferences(page);
  expect(errors).toEqual([]);
});

test('cancel and unavailable identity never issue restart or terminal input', async ({ page }) => {
  await openRestartWorkspace(page);
  const posts = [];
  page.on('request', req => { if (req.method() === 'POST') posts.push(req.url()); });
  await page.locator('.pane').nth(1).locator('.pane-restart').click();
  await page.locator('.ui-dialog .ui-btn').first().click();
  await expect(page.locator('.ui-dialog')).toHaveCount(0);
  await page.route('**/api/sessions/demo02/restart', route => route.fulfill({ status: 409, json: { detail: '无法准确识别原会话' } }));
  await page.locator('.pane').nth(1).locator('.pane-restart').click();
  await expect(page.locator('#toast')).toContainText('无法准确识别');
  expect(posts.filter(url => url.includes('/restart'))).toEqual([]);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  await assertRestartReferences(page);
});

test('OpenCode has the same exact-conversation restart control and no continue command', async ({ page }) => {
  const errors = await openRestartWorkspace(page);
  const identifier = 'ses_synthetic123456789';
  const requests = [];
  await page.route('**/api/sessions/demo04/restart', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ...restartPreview, agent: 'opencode', sessionId: identifier } });
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { ...tabs[3], resumed: true } });
  });
  await page.locator('.pane').nth(3).locator('.pane-restart').click();
  await expect(page.locator('.ui-dialog-title')).toContainText('OpenCode');
  await expect(page.locator('.ui-dialog-msg')).toContainText(identifier);
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('#toast')).toContainText('已恢复');
  expect(requests).toHaveLength(1);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  await assertRestartReferences(page);
  expect(errors).toEqual([]);
});

test('a native agent started in a shell tab receives the same safe restart control', async ({ page }) => {
  await openRestartWorkspace(page);
  await page.evaluate(() => {
    panes[0].tab.resumeAgent = 'codex';
    updateRestartControls();
  });
  await page.locator('.pane').first().locator('.pane-restart').click();
  await expect(page.locator('.ui-dialog-msg')).toContainText(restartPreview.sessionId);
  await page.locator('.ui-dialog .ui-btn').first().click();
  await assertRestartReferences(page);
});

test('repeated restart clicks are deduplicated and only target input is paused', async ({ page }) => {
  await openRestartWorkspace(page);
  let calls = 0;
  await page.route('**/api/sessions/demo02/restart', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: restartPreview });
    calls++;
    await new Promise(resolve => setTimeout(resolve, 800));
    await route.fulfill({ json: { ...tabs[1], resumed: true } });
  });
  await page.locator('.pane').nth(1).locator('.pane-restart').click();
  await expect(page.locator('.pane').nth(1).locator('.pane-restart')).toBeDisabled();
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('.pane').nth(1)).toHaveClass(/restarting/);
  await page.evaluate(() => { deliverTo(panes[1], 'do-not-send'); deliverTo(panes[0], 'other-window'); requestRestartTab(panes[1].tab); });
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input').map(msg => msg.data))).toEqual(['other-window']);
  await expect(page.locator('#toast')).toContainText('已恢复');
  await expect(page.locator('.pane').nth(1).locator('.pane-restart')).toBeEnabled();
  expect(calls).toBe(1);
  await assertRestartReferences(page);
});

test('changing the pane while restart preflight is pending cancels the operation', async ({ page }) => {
  await openRestartWorkspace(page);
  let calls = 0;
  await page.route('**/api/sessions/demo02/restart', async route => {
    if (route.request().method() === 'POST') calls++;
    await new Promise(resolve => setTimeout(resolve, 250));
    await route.fulfill({ json: restartPreview });
  });
  await page.locator('.pane').nth(1).locator('.pane-restart').click();
  await page.evaluate(() => attachTerminal(state.tabs[3], panes[1]));
  await expect(page.locator('#toast')).toContainText('窗口已切换');
  await expect(page.locator('.ui-dialog')).toHaveCount(0);
  expect(calls).toBe(0);
});

test('restart failure is not automatically retried or remounted', async ({ page }) => {
  await openRestartWorkspace(page);
  let calls = 0;
  await page.route('**/api/sessions/demo02/restart', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: restartPreview });
    calls++;
    return route.fulfill({ status: 409, json: { detail: '旧后台尚未退出，没有启动第二个会话' } });
  });
  await page.locator('.pane').nth(1).locator('.pane-restart').click();
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('#toast')).toContainText('没有启动第二个会话');
  await expect(page.locator('.pane').nth(1).locator('.pane-restart')).toBeEnabled();
  expect(calls).toBe(1);
  await assertRestartReferences(page);
});

test('legacy Claude binds only the UUID explicitly entered by the user', async ({ page }) => {
  await openRestartWorkspace(page);
  const bodies = [];
  await page.route('**/api/sessions/demo03/restart', route => route.fulfill({ json: { ready: false, canBind: true, agent: 'claude' } }));
  await page.route('**/api/sessions/demo03/restart/bind', route => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: { ...restartPreview, agent: 'claude' } });
  });
  await page.locator('.pane').nth(2).locator('.pane-restart').click();
  await expect(page.locator('.ui-dialog-title')).toContainText('绑定');
  await page.locator('.ui-dialog-input').fill(restartPreview.sessionId);
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('.ui-dialog-title')).toContainText('重启并恢复');
  await page.locator('.ui-dialog .ui-btn').first().click();
  expect(bodies).toEqual([{ sessionId: restartPreview.sessionId }]);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  await assertRestartReferences(page);
});

test('stopped sidebar restart restores exact history without opening or replacing another pane', async ({ page }) => {
  await openRestartWorkspace(page);
  await page.evaluate(() => {
    state.tabs.push({ id: 'stopped05', name: 'Stopped Codex', cwd: '/workspace/demo', type: 'codex', alive: false });
    renderTabs();
  });
  const posts = [];
  await page.route('**/api/sessions/stopped05/restart', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ...restartPreview, running: false, stopped: true } });
    posts.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: 'stopped05', name: 'Stopped Codex', cwd: '/workspace/demo', type: 'codex', alive: true, resumed: true } });
  });
  await page.locator('#nav-global').click();
  await page.locator('.chat-item').filter({ hasText: 'Stopped Codex' }).hover();
  await page.locator('.chat-item').filter({ hasText: 'Stopped Codex' }).locator('button[title="重启并恢复原会话"]').click();
  await expect(page.locator('.ui-dialog-msg')).toContainText(restartPreview.sessionId);
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('#toast')).toContainText('已恢复');
  expect(posts).toHaveLength(1);
  expect(await page.evaluate(() => state.tabs.find(t => t.id === 'stopped05').alive)).toBe(true);
  expect(await page.evaluate(() => panes.length)).toBe(4);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  await assertRestartReferences(page);
});

for (const theme of ['dark', 'light']) {
  test(`${theme} mobile restart confirmation fits 320px and uses no keyboard`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true });
    try {
      const page = await context.newPage();
      const errors = await openWorkspace(page, theme);
      await page.evaluate(() => openTab(state.tabs[1]));
      await page.waitForFunction(() => active.tab.id === 'demo02' && active.ws?.readyState === 1);
      await page.route('**/api/sessions/demo02/restart', route => route.fulfill({ json: restartPreview }));
      await page.locator('.pane-restart').tap();
      await expect(page.locator('.ui-dialog')).toBeVisible();
      await expect(page.locator('.ui-dialog-input')).toHaveCount(0);
      const box = await page.locator('.ui-dialog').boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(320);
      expect(box.y + box.height).toBeLessThanOrEqual(640);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `/tmp/webcc-v84-restart-mobile-${theme}.png` });
      await page.locator('.ui-dialog .ui-btn').first().tap();
      expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}

async function openWorkspace(page, theme = 'dark', noIcons = false) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(theme => {
    localStorage.setItem('cc_ui', 'legacy');
    localStorage.setItem('cc_theme', theme);
    window.sent = [];
    window.copied = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text; } } });
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 10); }
      send(data) { window.sent.push({ ...JSON.parse(data), socket: this.url }); }
      close() { this.readyState = 3; }
    };
  }, theme);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    const api = {
      '/api/config': { defaultDir: '/workspace/demo', roots: ['/workspace/demo'], types: { shell: true, codex: true, claude: true, opencode: true } },
      '/api/sessions': { sessions: tabs, groups: {}, manualGroups: [] },
      '/api/presence': { count: 1, strangers: 0, ips: [] },
      '/api/ips': { entries: [] },
      '/api/fs': { path: '/workspace/demo', parent: '/workspace', roots: ['/workspace/demo'], entries: files },
      '/api/fs/text': { text: '# Demo workspace\n\nAll preview content is synthetic.\n', truncated: false },
      '/api/term/image': { path: '/workspace/demo/.cc-web-images/demo.png' },
      '/api/codex/usage': { window: { remainingPercent: 55, usedPercent: 45, resetsAt: 1800000000 }, nextRefreshAt: Date.now() / 1000 + 600 },
      '/api/gpu': { hosts: [{ addr: 'local', name: 'Demo machine', ok: true,
        summary: { total: 1, idle: 0, busy: 1, held: 0, mem_used: 8192, mem_total: 24576, users: [] },
        gpus: [{ index: 0, name: 'NVIDIA Demo GPU', state: 'busy', util: 36, mem_used: 8192, mem_total: 24576, mem_pct: 33, temp: 52, power: 100, power_limit: 250, procs: [] }],
      }] },
    };
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: api[url.pathname] || {} });
    if (noIcons && url.pathname.endsWith('lucide.min.js')) return route.fulfill({ status: 404 });
    const file = path.resolve(frontend, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(frontend + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto('http://localhost/');
  await page.waitForFunction(() => typeof active !== 'undefined' && active?.ws?.readyState === 1);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(resolve => active.term.write(
    '\x1b[?1049h\x1b[2J\x1b[HDemo workspace\r\n\r\n' +
    '\x1b[32mPASS\x1b[0m  terminal scrolling\r\n\x1b[32mPASS\x1b[0m  split layout\r\n' +
    '\x1b[36m~/workspace/demo\x1b[0m $ npm test\r\n\r\nAll checks passed.\r\n', resolve)));
  return errors;
}

for (const theme of ['dark', 'light']) {
  for (const width of [320, 390]) {
    test(`${theme} recent session picker fits ${width}px without shrinking terminal`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const errors = await openWorkspace(page, theme);
      const before = await page.locator('#panes').boundingBox();
      await page.locator('#recent-toggle').click();
      await expect(page.locator('#recent-sessions')).toBeVisible();
      await expect(page.locator('.recent-row')).toHaveCount(4);
      await expect(page.locator('.recent-row[aria-checked="true"]')).toHaveAttribute('data-session-id', 'demo01');
      await expect(page.locator('#recent-toggle')).toHaveAttribute('aria-expanded', 'true');
      expect(await page.locator('#panes').boundingBox()).toEqual(before);
      const box = await page.locator('#recent-sessions').boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      await assertFits(page);
      if (width === 390) await page.screenshot({ path: `/tmp/webcc-v81-recents-${theme}.png` });
      await page.locator('.recent-row[data-session-id="demo02"]').click();
      await expect(page.locator('#recent-sessions')).toBeHidden();
      await expect(page.locator('.pane')).toHaveCount(1);
      await expect(page.locator('#topbar-title')).toHaveText('Codex');
      expect(await page.evaluate(() => active.tab.id)).toBe('demo02');
      expect(errors).toEqual([]);
    });
  }
}

test('recent sessions keep order across refresh without starting or stopping live tasks', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const changes = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/api\/sessions/.test(request.url())) changes.push(request.url());
  });
  await openWorkspace(page);
  for (const id of ['demo02', 'demo03']) {
    await page.locator('#recent-toggle').click();
    await page.locator(`.recent-row[data-session-id="${id}"]`).click();
    await expect(page.locator('#recent-sessions')).toBeHidden();
  }
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cc_recent_sessions')))).toEqual(['demo03', 'demo02', 'demo01']);
  await page.reload();
  await page.waitForFunction(() => active?.ws?.readyState === 1);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo03');
  await page.locator('#recent-toggle').click();
  expect(await page.locator('.recent-row').evaluateAll(rows => rows.map(row => row.dataset.sessionId))).toEqual(['demo03', 'demo02', 'demo01', 'demo04']);
  expect(changes).toEqual([]);
});

test('recent picker preserves stopped entries, deduplicates and drops deleted sessions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('cc_recent_sessions', JSON.stringify(['gone', 'demo02', 'demo02', 'demo01'])));
  await openWorkspace(page);
  await page.evaluate(() => {
    state.tabs.push({ id: 'stopped', name: 'Stopped task', cwd: '/workspace/demo', type: 'codex', alive: false });
    saveActiveId('stopped');
    renderTabs();
  });
  await page.locator('#recent-toggle').click();
  await expect(page.locator('.recent-row[data-session-id="gone"]')).toHaveCount(0);
  await expect(page.locator('.recent-row[data-session-id="demo02"]')).toHaveCount(1);
  await expect(page.locator('.recent-row[data-session-id="stopped"]')).toContainText('已停止');
  let starts = 0;
  await page.route('**/api/sessions/stopped/start', route => { starts++; return route.fulfill({ json: {
    id: 'stopped', name: 'Stopped task', cwd: '/workspace/demo', type: 'codex', alive: true,
  } }); });
  await page.locator('.recent-row[data-session-id="stopped"]').click();
  await expect(page.locator('.ui-dialog')).toContainText('无法确认原会话时不会新建替代对话');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ui-dialog')).toHaveCount(0);
  await expect(page.locator('#recent-sessions')).toBeVisible();
  await expect(page.locator('.recent-row[data-session-id="stopped"]')).toBeEnabled();
  expect(starts).toBe(0);
  await page.locator('.recent-row[data-session-id="stopped"]').click();
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await expect(page.locator('#recent-sessions')).toBeHidden();
  expect(await page.evaluate(() => active.tab.id)).toBe('stopped');
  expect(starts).toBe(1);
});

test('recent picker handles keyboard, outside dismissal, narrow heights and long names', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 440 });
  await openWorkspace(page);
  await page.evaluate(() => {
    state.tabs[0].name = '<script>not markup</script> ' + 'LongName'.repeat(12);
    state.tabs.push(...Array.from({ length: 15 }, (_, i) => ({
      id: 'extra' + i, name: 'Extra session ' + i, cwd: '/workspace/demo', type: 'shell', alive: true,
    })));
    renderTabs();
  });
  await page.locator('#recent-toggle').click();
  await expect(page.locator('.recent-row')).toHaveCount(10);
  await expect(page.locator('#recent-list script')).toHaveCount(0);
  const dimensions = await page.locator('#recent-sessions').evaluate(el => {
    const box = el.getBoundingClientRect();
    return { right: box.right, bottom: box.bottom, scrollWidth: el.scrollWidth, width: el.clientWidth };
  });
  expect(dimensions.right).toBeLessThanOrEqual(320);
  expect(dimensions.bottom).toBeLessThanOrEqual(440);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
  await page.keyboard.press('End');
  await expect(page.locator('.recent-row').last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.locator('.recent-row').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#recent-toggle')).toBeFocused();
  await expect(page.locator('#recent-sessions')).toBeHidden();
  await page.locator('#recent-toggle').click();
  await page.locator('#topbar-tools').click();
  await expect(page.locator('#recent-sessions')).toBeHidden();
});

test('failed recent-session restart stays selectable and repeated taps do not double-start', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page);
  await page.evaluate(() => {
    state.tabs.push({ id: 'stopped', name: 'Stopped task', cwd: '/workspace/demo', type: 'codex', alive: false });
    renderTabs();
  });
  let calls = 0;
  await page.route('**/api/sessions/stopped/start', async route => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 200));
    await route.fulfill({ status: 500, json: { detail: 'Synthetic restart failure' } });
  });
  await page.locator('#recent-toggle').click();
  await page.locator('.recent-row[data-session-id="stopped"]').click();
  await expect(page.locator('.recent-row[data-session-id="stopped"]')).toBeDisabled();
  expect(calls).toBe(0);
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await expect(page.locator('#toast')).toContainText('Synthetic restart failure');
  await expect(page.locator('.recent-row[data-session-id="stopped"]')).toBeEnabled();
  await expect(page.locator('#recent-sessions')).toBeVisible();
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  expect(calls).toBe(1);
});

test('bad recent-session storage falls back to available sessions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('cc_recent_sessions', '{broken json'));
  const errors = await openWorkspace(page);
  await page.locator('#recent-toggle').click();
  await expect(page.locator('.recent-row')).toHaveCount(4);
  expect(errors).toEqual([]);
});

test('mobile touch scrolls the recent list and switches one terminal without sending input', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 440 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    const errors = await openWorkspace(page);
    await page.evaluate(() => {
      for (const tab of state.tabs) tab.name += ' / ' + 'Long session name '.repeat(8);
      renderTabs();
    });
    await page.locator('#recent-toggle').tap();
    const list = await page.locator('#recent-list').boundingBox();
    const client = await context.newCDPSession(page);
    const x = list.x + list.width / 2;
    const y = list.y + list.height - 30;
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 15 }] });
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.locator('#recent-list').evaluate(el => el.scrollTop)).toBeGreaterThan(50);
    await page.locator('.recent-row[data-session-id="demo04"]').tap();
    await expect(page.locator('#recent-sessions')).toBeHidden();
    await expect(page.locator('.pane')).toHaveCount(1);
    expect(await page.evaluate(() => active.tab.id)).toBe('demo04');
    expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

async function assertFits(page) {
  await expect.poll(() => page.evaluate(() => {
    const within = (a, b) => a.left >= b.left - 1 && a.top >= b.top - 1 && a.right <= b.right + 1 && a.bottom <= b.bottom + 1;
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const app = document.getElementById('app');
    const issues = [];
    if (!within(app.getBoundingClientRect(), viewport)) issues.push('app outside viewport');
    if (document.documentElement.scrollWidth > innerWidth) issues.push('horizontal page overflow');
    for (const pane of panes) {
      const screen = pane.host.querySelector('.xterm-screen');
      if (screen && !within(screen.getBoundingClientRect(), pane.el.getBoundingClientRect())) issues.push({
        issue: 'terminal outside pane', name: pane.tab?.name,
        screen: screen.getBoundingClientRect().toJSON(),
        host: pane.host.getBoundingClientRect().toJSON(),
        pane: pane.el.getBoundingClientRect().toJSON(),
        dimensions: { cols: pane.term.cols, rows: pane.term.rows, proposed: pane.fit.proposeDimensions() },
      });
    }
    return issues;
  })).toEqual([]);
}

async function openDemoSplits(page) {
  await page.evaluate(tabs => {
    for (const tab of tabs.slice(1)) attachTerminal(tab, makePane());
    focusPane(panes[0]);
  }, tabs);
  await page.waitForFunction(() => panes.length === 4 && panes.every(pane => pane.ws?.readyState === 1));
  await page.evaluate(async () => {
    for (const pane of panes) await new Promise(resolve => pane.term.write(
      '\x1b[?1049h\x1b[2J\x1b[H' + pane.tab.name + '\r\n\r\n' +
      'Demo workspace\r\n\r\n\x1b[32mReady\x1b[0m\r\n\r\n' +
      'All preview content is synthetic.\r\n\r\n> ', resolve));
    window.originalTerminals = panes.map(pane => pane.term);
    window.originalSockets = panes.map(pane => pane.ws);
  });
}

async function assertTerminalDimensions(page) {
  await expect.poll(() => page.evaluate(() => panes.flatMap(pane => {
    const box = pane.host.getBoundingClientRect();
    if (!pane.term || box.width < 40 || box.height < 40) return [];
    const expected = pane.fit.proposeDimensions();
    return expected && pane.term.cols === expected.cols && pane.term.rows === expected.rows ? [] : [{
      id: pane.tab.id, cols: pane.term.cols, rows: pane.term.rows, expected,
    }];
  }))).toEqual([]);
  await assertFits(page);
}

for (const theme of ['dark', 'light']) {
  for (const width of [1920, 2560, 3440]) {
    test(`${theme} wide workspace fills ${width}px while preserving four terminals`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1080 });
      const errors = await openWorkspace(page, theme);
      await openDemoSplits(page);
      const dimensions = await page.evaluate(() => {
        const box = document.getElementById('app').getBoundingClientRect();
        const style = getComputedStyle(document.body);
        return { left: box.left, right: box.right, width: box.width,
          paddingLeft: parseFloat(style.paddingLeft), paddingRight: parseFloat(style.paddingRight) };
      });
      if (width === 2560) await page.screenshot({ path: `/tmp/webcc-v83-width-${theme}.png` });
      expect(dimensions.left).toBeCloseTo(dimensions.paddingLeft, 1);
      expect(dimensions.right).toBeCloseTo(width - dimensions.paddingRight, 1);
      expect(dimensions.width).toBeCloseTo(width - dimensions.paddingLeft - dimensions.paddingRight, 1);
      await assertTerminalDimensions(page);
      expect(await page.evaluate(() => panes.every((pane, i) => pane.term === originalTerminals[i] && pane.ws === originalSockets[i]))).toBe(true);
      expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

test('internal workspace and host size changes refit without browser resize events', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const errors = await openWorkspace(page);
  await openDemoSplits(page);
  await assertTerminalDimensions(page);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.resizeEvents = 0;
    window.addEventListener('resize', () => resizeEvents++);
    document.getElementById('app').style.width = '700px';
  });
  await expect(page.locator('#panes')).toHaveAttribute('data-eff', 'col');
  await assertTerminalDimensions(page);
  await page.evaluate(() => { document.getElementById('app').style.width = '1100px'; });
  await expect(page.locator('#panes')).toHaveAttribute('data-eff', 'row');
  await assertTerminalDimensions(page);
  await page.evaluate(() => {
    for (const pane of panes) pane.host.style.padding = '24px 36px';
  });
  await assertTerminalDimensions(page);
  await page.evaluate(() => {
    document.getElementById('app').style.removeProperty('width');
    for (const pane of panes) pane.host.style.removeProperty('padding');
  });
  await assertTerminalDimensions(page);
  expect(await page.evaluate(() => resizeEvents)).toBe(0);
  expect(await page.evaluate(() => panes.every((pane, i) => pane.term === originalTerminals[i] && pane.ws === originalSockets[i]))).toBe(true);
  expect(errors).toEqual([]);
});

test('viewport changes keep the same terminals fitted from wide desktop to phone and back', async ({ page }) => {
  const errors = await openWorkspace(page);
  await openDemoSplits(page);
  for (const viewport of [{ width: 2560, height: 1100 }, { width: 1920, height: 1000 },
    { width: 1280, height: 900 }, { width: 720, height: 1000 }, { width: 390, height: 1100 }, { width: 1440, height: 960 }]) {
    await page.setViewportSize(viewport);
    await assertTerminalDimensions(page);
    const gap = await page.evaluate(() => {
      const box = document.getElementById('app').getBoundingClientRect();
      const style = getComputedStyle(document.body);
      return Math.abs(box.left - parseFloat(style.paddingLeft)) +
        Math.abs(innerWidth - box.right - parseFloat(style.paddingRight));
    });
    expect(gap).toBeLessThan(1);
    expect(await page.evaluate(() => panes.every((pane, i) => pane.term === originalTerminals[i] && pane.ws === originalSockets[i]))).toBe(true);
  }
  expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
  expect(errors).toEqual([]);
});

test('unchanged sizes are not resent and replacement sockets receive an initial resize', async ({ page }) => {
  await openWorkspace(page);
  await openDemoSplits(page);
  await assertTerminalDimensions(page);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.sent = [];
    for (let i = 0; i < 20; i++) refitAll();
  });
  expect(await page.evaluate(() => sent.filter(message => message.type === 'resize'))).toEqual([]);
  await page.evaluate(() => {
    active.ws.close();
    active.ws = new WebSocket(active.ws.url);
  });
  await page.waitForFunction(() => active.ws.readyState === 1);
  await page.evaluate(() => { refitAll(); refitAll(); });
  expect(await page.evaluate(() => sent.filter(message => message.type === 'resize').map(message => ({ cols: message.cols, rows: message.rows })))).toEqual([
    await page.evaluate(() => ({ cols: active.term.cols, rows: active.term.rows })),
  ]);
});

test('container observers skip hidden panes and release closed hosts', async ({ page }) => {
  const errors = await openWorkspace(page);
  await openDemoSplits(page);
  await assertTerminalDimensions(page);
  await page.evaluate(() => {
    window.hiddenSizes = panes.slice(1).map(pane => ({ cols: pane.term.cols, rows: pane.term.rows }));
    window.sent = [];
    togglePaneMaximized(panes[0]);
  });
  await assertTerminalDimensions(page);
  expect(await page.evaluate(() => panes.slice(1).map(pane => ({ cols: pane.term.cols, rows: pane.term.rows })))).toEqual(await page.evaluate(() => hiddenSizes));
  expect(await page.evaluate(() => sent.filter(message => message.type === 'resize').every(message => message.cols > 1 && message.rows > 1))).toBe(true);
  await page.evaluate(() => { togglePaneMaximized(panes[0]); });
  await assertTerminalDimensions(page);
  await page.evaluate(() => {
    window.closedHost = panes[3].host;
    window.releasedHosts = [];
    const unobserve = workspaceResizeObserver.unobserve.bind(workspaceResizeObserver);
    workspaceResizeObserver.unobserve = host => { releasedHosts.push(host); unobserve(host); };
    closePane(panes[3]);
  });
  await assertTerminalDimensions(page);
  expect(await page.evaluate(() => releasedHosts.includes(closedHost))).toBe(true);
  await page.evaluate(() => { closeAllPanes(); document.getElementById('app').style.width = '900px'; });
  await page.waitForTimeout(150);
  expect(errors).toEqual([]);
});

test('window resize fallback works when ResizeObserver is unavailable', async ({ page }) => {
  await page.addInitScript(() => { window.ResizeObserver = undefined; });
  const errors = await openWorkspace(page);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await assertTerminalDimensions(page);
  await page.setViewportSize({ width: 1024, height: 800 });
  await assertTerminalDimensions(page);
  expect(errors).toEqual([]);
});

async function selectMobileSession(page, id) {
  await page.locator('#recent-toggle').tap();
  await page.locator(`.recent-row[data-session-id="${id}"]`).tap();
  await page.waitForFunction(id => active?.tab?.id === id && active?.ws?.readyState === 1, id);
}

for (const theme of ['dark', 'light']) {
  for (const width of [320, 390]) {
    test(`${theme} mobile command menu fits ${width}px and inserts text without keyboard or Enter`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
      try {
        const page = await context.newPage();
        const errors = await openWorkspace(page, theme);
        await expect(page.locator('#cap-commands')).toBeDisabled();
        await selectMobileSession(page, 'demo02');
        await expect(page.locator('#cap-commands')).toBeEnabled();
        await page.evaluate(() => new Promise(resolve => active.term.write(
          '\x1b[?1049h\x1b[2J\x1b[H' +
          'Codex terminal\r\n\r\n' +
          '\x1b[32mReady\x1b[0m\r\n\r\n' +
          'Demo workspace\r\nAll preview content is synthetic.\r\n\r\n' +
          '> Ask Codex to do anything\r\n', resolve)));
        const requests = [];
        page.on('request', request => requests.push(request.url()));
        const before = await page.locator('#panes').boundingBox();
        expect((await page.locator('#workspace-footer').boundingBox()).height).toBe(64);
        for (const button of await page.locator('.aux-primary .keycap').all()) {
          const box = await button.boundingBox();
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        await page.locator('#cap-commands').tap();
        await expect(page.locator('#quick-commands')).toBeVisible();
        await expect(page.locator('#cap-commands')).toHaveAttribute('aria-expanded', 'true');
        expect(await page.locator('#panes').boundingBox()).toEqual(before);
        const menu = await page.locator('#quick-commands').boundingBox();
        expect(menu.x).toBeGreaterThanOrEqual(0);
        expect(menu.x + menu.width).toBeLessThanOrEqual(width);
        expect(menu.y).toBeGreaterThanOrEqual(0);
        expect(menu.y + menu.height).toBeLessThanOrEqual(844);
        await assertFits(page);
        if (width === 390) await page.screenshot({ path: `/tmp/webcc-v82-commands-${theme}.png` });
        await page.locator('.quick-command-row[data-command="/model"]').tap();
        await expect(page.locator('#quick-commands')).toBeHidden();
        expect(await page.evaluate(() => sent.filter(message => message.type === 'input').map(message => message.data))).toEqual(['/model']);
        expect(await page.evaluate(() => ({ keyboard: kbdOn, mode: active.term.textarea.getAttribute('inputmode'),
          textareaFocused: document.activeElement === active.term.textarea }))).toEqual({ keyboard: false, mode: 'none', textareaFocused: false });
        expect(requests.filter(url => url.includes('/api/'))).toEqual([]);
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    });
  }
}

test('native model picker accepts mobile Enter and arrows without the soft keyboard', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    const errors = await openWorkspace(page);
    await selectMobileSession(page, 'demo02');
    await page.evaluate(() => {
      // A synthetic native picker responds to input; no real account/model calls.
      const pane = active, send = pane.ws.send.bind(pane.ws);
      window.picker = { draft: '', open: false, selected: 0, confirmed: null };
      pane.ws.send = raw => {
        send(raw);
        const message = JSON.parse(raw);
        if (message.type !== 'input') return;
        if (!picker.open) {
          if (message.data === '\r' && picker.draft === '/model') {
            picker.open = true;
            pane.term.write('\x1b[?1h\x1b[2J\x1b[HSelect model\r\n\r\n> Demo model A\r\n  Demo model B\r\n');
          } else picker.draft += message.data;
        } else if (/^\x1b(?:\[|O)B$/.test(message.data)) picker.selected = 1;
        else if (message.data === '\r') picker.confirmed = picker.selected;
      };
    });
    await page.locator('#cap-commands').tap();
    await page.locator('.quick-command-row[data-command="/model"]').tap();
    expect(await page.evaluate(() => picker)).toEqual({ draft: '/model', open: false, selected: 0, confirmed: null });
    await page.locator('.aux-primary [aria-label="回车"]').tap();
    await page.waitForFunction(() => picker.open && active.term.modes.applicationCursorKeysMode);
    await expect(page.locator('.xterm-rows')).toContainText('Select model');
    await page.locator('.aux-primary [aria-label="↓"]').tap();
    await page.locator('.aux-primary [aria-label="回车"]').tap();
    expect(await page.evaluate(() => picker.confirmed)).toBe(1);
    expect(await page.evaluate(() => sent.filter(message => message.type === 'input').map(message => message.data))).toEqual(['/model', '\r', '\x1bOB', '\r']);
    expect(await page.evaluate(() => ({ keyboard: kbdOn, mode: active.term.textarea.getAttribute('inputmode') }))).toEqual({ keyboard: false, mode: 'none' });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('command insertion respects native bracketed paste mode without a trailing Enter', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    await openWorkspace(page);
    await selectMobileSession(page, 'demo02');
    await page.evaluate(() => new Promise(resolve => active.term.write('\x1b[?2004h', resolve)));
    await page.locator('#cap-commands').tap();
    await page.locator('.quick-command-row[data-command="/fast"]').tap();
    expect(await page.evaluate(() => sent.filter(message => message.type === 'input').map(message => message.data))).toEqual(['\x1b[200~/fast\x1b[201~']);
    expect(await page.evaluate(() => ({ keyboard: kbdOn, mode: active.term.textarea.getAttribute('inputmode') }))).toEqual({ keyboard: false, mode: 'none' });
    await page.evaluate(() => new Promise(resolve => active.term.write('\x1b[?2004l', resolve)));
    await page.locator('#cap-commands').tap();
    await page.locator('.quick-command-row[data-command="/status"]').tap();
    expect(await page.evaluate(() => sent.filter(message => message.type === 'input').map(message => message.data))).toEqual(['\x1b[200~/fast\x1b[201~', '/status']);
  } finally { await context.close(); }
});

test('command menus use provider-specific names and never clear or submit existing drafts', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 440 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    await openWorkspace(page);
    for (const id of ['demo02', 'demo03', 'demo04']) {
      await selectMobileSession(page, id);
      await page.locator('#cap-commands').tap();
      const expected = id === 'demo04' ? ['/models', '/help', '/'] : ['/model', '/fast', '/status', '/'];
      expect(await page.locator('.quick-command-row').evaluateAll(rows => rows.map(row => row.dataset.command))).toEqual(expected);
      const box = await page.locator('#quick-commands').boundingBox();
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(440);
      await page.locator('#quick-commands-close').tap();
    }
    await selectMobileSession(page, 'demo02');
    await page.evaluate(() => {
      window.draft = 'Existing unsent draft';
      const send = active.ws.send.bind(active.ws);
      active.ws.send = raw => {
        send(raw);
        const message = JSON.parse(raw);
        if (message.type === 'input') draft += message.data;
      };
      ctrlArmed = true;
      updateCtrlCap();
    });
    await page.locator('#cap-commands').tap();
    await page.locator('.quick-command-row[data-command="/fast"]').tap();
    expect(await page.evaluate(() => draft)).toBe('Existing unsent draft/fast');
    expect(await page.evaluate(() => sent.filter(message => message.type === 'input').map(message => message.data))).toEqual(['/fast']);
    expect(await page.evaluate(() => ctrlArmed)).toBe(false);
    await selectMobileSession(page, 'demo01');
    await expect(page.locator('#cap-commands')).toBeDisabled();
  } finally { await context.close(); }
});

test('command routing rejects stale split targets and double activation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await openWorkspace(page);
  await page.evaluate(tabs => {
    attachTerminal(tabs[1], makePane());
    attachTerminal(tabs[2], makePane());
    focusPane(panes[1]);
  }, tabs);
  await page.waitForFunction(() => panes.every(pane => pane.ws?.readyState === 1));
  await page.locator('#cap-commands').click();
  await page.evaluate(() => {
    window.staleCommand = document.querySelector('.quick-command-row[data-command="/model"]');
    focusPane(panes[2]);
  });
  await expect(page.locator('#quick-commands')).toBeHidden();
  await page.locator('#cap-commands').click();
  await page.evaluate(() => staleCommand.onclick());
  await expect(page.locator('#quick-commands')).toBeHidden();
  expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
  await page.locator('#cap-commands').click();
  await page.evaluate(() => {
    const button = document.querySelector('.quick-command-row[data-command="/model"]');
    button.onclick();
    button.onclick();
  });
  expect(await page.evaluate(() => sent.filter(message => message.type === 'input').map(message => ({ data: message.data,
    id: message.socket.split('/').pop().split('?')[0] })))).toEqual([{ data: '/model', id: 'demo03' }]);
});

test('command menu handles keyboard, competing menus, keyboard dismissal and missing icons', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    const errors = await openWorkspace(page, 'light', true);
    await selectMobileSession(page, 'demo02');
    await page.evaluate(() => { kbdOn = true; applyKbdMode(active.term); updateKbdBtn(); active.term.focus(); });
    await page.locator('#cap-commands').tap();
    expect(await page.evaluate(() => kbdOn)).toBe(false);
    await expect(page.locator('#cap-commands')).toHaveText('/');
    await page.keyboard.press('End');
    await expect(page.locator('.quick-command-row').last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.locator('.quick-command-row').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#cap-commands')).toBeFocused();
    await expect(page.locator('#quick-commands')).toBeHidden();
    await page.locator('#cap-commands').tap();
    await page.locator('#recent-toggle').tap();
    await expect(page.locator('#quick-commands')).toBeHidden();
    await expect(page.locator('#recent-sessions')).toBeVisible();
    await page.locator('#cap-commands').tap();
    await expect(page.locator('#recent-sessions')).toBeHidden();
    await page.locator('#hamburger').tap();
    await expect(page.locator('#quick-commands')).toBeHidden();
    expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('command menu refuses closed, reconnected and replaced sockets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page);
  await page.evaluate(tab => attachTerminal(tab), tabs[1]);
  await page.waitForFunction(() => active?.ws?.readyState === 1);
  for (const condition of ['closed', 'reconnected', 'replaced', 'send-error']) {
    await page.locator('#cap-commands').click();
    await page.evaluate(condition => {
      const button = document.querySelector('.quick-command-row[data-command="/model"]');
      if (condition === 'closed') active.ws.readyState = 3;
      else if (condition === 'reconnected') active.gen++;
      else if (condition === 'replaced') active.ws = { readyState: 1, send() { throw new Error('Replaced socket must not receive stale command'); } };
      else active.ws.send = () => { throw new Error('Synthetic send failure'); };
      button.onclick();
    }, condition);
    await expect(page.locator('#quick-commands')).toBeHidden();
    await expect(page.locator('#toast')).toContainText('命令未送出');
    expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
    await page.evaluate(tab => attachTerminal(tab), tabs[1]);
    await page.waitForFunction(() => active?.ws?.readyState === 1);
  }
  await page.locator('#cap-commands').click();
  await page.evaluate(() => {
    active.ws.readyState = 3;
    setStatus('reconnecting', '正在重连', active);
  });
  await expect(page.locator('#quick-commands')).toBeHidden();
  await expect(page.locator('#cap-commands')).toBeDisabled();
});

async function openTools(page) {
  if (!await page.locator('body').evaluate(el => el.classList.contains('tools-open')))
    await page.locator(page.viewportSize().width > 820 ? '#btn-tools' : '#topbar-tools').click();
}

async function assertButtonContrast(button) {
  const ratio = await button.evaluate(el => {
    const luminance = color => {
      const rgb = color.match(/[\d.]+/g).slice(0, 3).map(value => {
        const n = Number(value) / 255;
        return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
      });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const style = getComputedStyle(el);
    const foreground = luminance(style.color), background = luminance(style.backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
}

for (const theme of ['dark', 'light']) {
  for (const width of [1440, 1024, 390, 320]) {
    test(`${theme} glass workspace fits ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width > 820 ? 960 : 844 });
      const errors = await openWorkspace(page, theme);
      await expect(page.locator(width > 820 ? '#btn-tools .ui-icon' : '#topbar-tools .ui-icon')).toBeVisible();
      await assertFits(page);
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => active.term.options.minimumContrastRatio)).toBe(4.5);
      expect(await page.evaluate(() => active.term.options.theme.background)).toBe('#00000000');
      await expect(page.locator('.pane-composer,.pane-input-toggle')).toHaveCount(0);
      await expect(page.locator('#term-header')).toBeVisible();
      for (const id of ['btn-select', 'btn-copy', 'btn-img', 'btn-split', 'btn-dir', 'btn-aux', 'btn-fs', 'btn-stop'])
        await expect(page.locator('#' + id)).toBeVisible();
      if (width <= 820) await expect(page.locator('#btn-kbd')).toBeVisible();
      const toolbarFits = await page.locator('#term-header').evaluate(el => {
        const bar = el.getBoundingClientRect();
        return [...el.querySelectorAll('.hdr-btn,.sizer')].filter(button => getComputedStyle(button).display !== 'none').every(button => {
          const r = button.getBoundingClientRect();
          return r.left >= bar.left && r.right <= bar.right && r.top >= bar.top && r.bottom <= bar.bottom;
        }) && bar.bottom <= document.getElementById('panes').getBoundingClientRect().top;
      });
      expect(toolbarFits).toBe(true);
      if (width === 1440 || width === 390) await page.screenshot({ path: `/tmp/webcc-glass-${theme}-${width}.png` });
    });
  }
}

test('auxiliary keys remain legible in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openWorkspace(page, 'light');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => applyTheme(theme), theme);
    await expect.poll(async () => {
      const contrasts = await page.locator('.aux-primary [aria-label="回车"]').evaluate(el => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        const luminance = color => {
          ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
          const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
            const n = value / 255;
            return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
          });
          return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
        };
        const style = getComputedStyle(el), fg = luminance(style.color);
        return ['--key-top', '--key-bottom'].map(stop => {
          const bg = luminance(style.getPropertyValue(stop));
          return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
        });
      });
      return Math.min(...contrasts);
    }).toBeGreaterThanOrEqual(4.5);
  }
});

test('four panes, active quota, keyboard keys and theme switching stay functional', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const errors = await openWorkspace(page);
  await page.evaluate(tabs => {
    for (const tab of tabs.slice(1)) attachTerminal(tab, makePane());
    focusPane(panes[1]);
  }, tabs);
  await page.waitForFunction(() => panes.length === 4 && panes.every(p => p.ws?.readyState === 1));
  await page.evaluate(async () => {
    for (const [i, pane] of panes.entries()) await new Promise(resolve => pane.term.write(
      '\x1b[?1049h\x1b[2J\x1b[H' + pane.tab.name + '\r\n\r\n' +
      ['npm test\r\n\x1b[32mAll 30 tests passed.\x1b[0m', 'OpenAI Codex\r\n\r\n\x1b[36mReady\x1b[0m\r\nContext 75% left', 'Claude Code\r\n\r\n\x1b[32mUpdated 3 files\x1b[0m', 'OpenCode\r\n\r\n\x1b[33mReviewing changes...\x1b[0m'][i], resolve));
  });
  await expect(page.locator('.codex-usage:not(.hidden)')).toHaveCount(1);
  await openTools(page);
  await page.locator('#btn-aux').click();
  await expect(page.locator('#auxbar')).toBeHidden();
  await page.locator('#btn-aux').click();
  await expect(page.locator('#auxbar')).toBeVisible();
  await assertFits(page);
  await page.locator('#auxbar [aria-label="↑"]').click();
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input').at(-1).data)).toBe('\x1b[A');
  await page.screenshot({ path: '/tmp/webcc-glass-four-panes.png' });
  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => panes.every(p => p.term.options.theme.background === '#00000000'))).toBe(true);
  await expect(page.locator('#theme-toggle .ui-icon')).toBeVisible();
  await assertFits(page);
  await page.locator('.pane-x').last().click();
  await expect(page.locator('.pane')).toHaveCount(3);
  await assertFits(page);
  expect(errors).toEqual([]);
});

test('pane dividers resize, reset and follow the auxiliary toolbar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await openWorkspace(page);
  await page.evaluate(tabs => {
    for (const tab of tabs.slice(1)) attachTerminal(tab, makePane());
  }, tabs);
  await assertFits(page);
  const divider = page.locator('.gutter.v');
  const initial = await page.locator('.pane').first().boundingBox();
  const handle = await divider.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 4);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 100, handle.y + handle.height / 4, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await page.locator('.pane').first().boundingBox()).width).toBeGreaterThan(initial.width + 80);
  await expect(page.locator('body')).not.toHaveClass(/gutter-dragging/);
  await assertFits(page);
  await divider.dblclick({ position: { x: handle.width / 2, y: handle.height / 4 } });
  await expect.poll(async () => Math.abs((await page.locator('.pane').first().boundingBox()).width - initial.width)).toBeLessThan(2);
  await openTools(page);
  await page.locator('#btn-aux').click();
  await page.locator('#btn-aux').click();
  await assertFits(page);
  await expect.poll(() => page.evaluate(() => {
    const top = panes[0].el.getBoundingClientRect(), bottom = panes[2].el.getBoundingClientRect();
    const handle = document.querySelector('.gutter.h').getBoundingClientRect();
    return Math.abs((handle.top + handle.bottom) / 2 - (top.bottom + bottom.top) / 2);
  })).toBeLessThan(1);
  await page.locator('.pane-x').last().click();
  await expect(page.locator('.pane')).toHaveCount(3);
});

for (const width of [1440, 390]) {
  test(`file preview, directory picker and resource monitor fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = await openWorkspace(page);
    await page.locator(width > 820 ? '#nav-files' : '#btn-files-m').click();
    await expect(page.locator('#files-list [data-path]')).toHaveCount(4);
    await expect(page.locator('#files-modal')).not.toHaveClass(/is-opening/);
    await page.screenshot({ path: `/tmp/webcc-glass-files-${width}.png` });
    await page.locator('#files-search').fill('README');
    await expect(page.locator('#files-list [data-path]')).toHaveCount(1);
    await page.locator('#files-list [data-path]').click();
    await expect(page.locator('.fv-text')).toContainText('Demo workspace');
    await page.locator('#fv-close').click();
    await page.locator('#files-close').click();
    if (width <= 820) { await page.locator('#hamburger').click(); await page.locator('#nav-global').click(); }
    await page.locator(width > 820 ? '#header-new' : '#new-term').click();
    await expect(page.locator('#dir-list .dir-row')).not.toHaveCount(0);
    await expect(page.locator('#mode-codex')).toBeVisible();
    await expect(page.locator('#mode-opencode')).toBeVisible();
    await expect(page.locator('#dir-modal')).not.toHaveClass(/is-opening/);
    await page.screenshot({ path: `/tmp/webcc-glass-create-${width}.png` });
    await page.locator('#dir-close').click();
    if (width <= 820) await page.locator('#scrim').click({ position: { x: 370, y: 100 } });
    await page.locator(width > 820 ? '#nav-resources' : '#btn-gpu-m').click();
    await expect(page.locator('.gpu-card')).toHaveCount(1);
    await expect(page.locator('#gpu-modal')).not.toHaveClass(/is-opening/);
    await page.screenshot({ path: `/tmp/webcc-glass-resources-${width}.png` });
    expect(await page.locator('.modal-box:visible').evaluate(el => el.getBoundingClientRect().right <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('Ctrl+C copies the terminal selection without ever sending an interrupt', async ({ page }) => {
  const errors = await openWorkspace(page);
  await page.evaluate(() => { active.term.focus(); active.term.select(0, 0, 14); sent.length = 0; });
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => copied)).toBe('Demo workspace');
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(errors).toEqual([]);
});

test('Ctrl+C with no selection keeps the clipboard and terminal unchanged', async ({ page }) => {
  const errors = await openWorkspace(page);
  await page.evaluate(() => { active.term.clearSelection(); active.term.focus(); window.copied = 'keep clipboard'; sent.length = 0; });
  await page.keyboard.press('Control+c'); await page.keyboard.press('Control+c');
  expect(await page.evaluate(() => copied)).toBe('keep clipboard');
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(errors).toEqual([]);
});

for (const id of ['demo01', 'demo02', 'demo03', 'demo04']) {
  test(`copy-only shortcuts work for ${id} and repeated keydown never sends input`, async ({ page }) => {
    const errors = await openWorkspace(page);
    await page.evaluate(id => { attachTerminal(state.tabs.find(tab => tab.id === id), active); }, id);
    await page.waitForFunction(() => active.ws?.readyState === 1);
    await page.evaluate(async () => {
      await new Promise(resolve => active.term.write('Selected output', resolve));
      active.term.focus(); active.term.select(0, 0, 15); sent.length = 0;
      window.copyCalls = 0;
      navigator.clipboard.writeText = async text => { copied = text; copyCalls++; };
    });
    await page.keyboard.down('Control'); await page.keyboard.down('c');
    await page.keyboard.down('c'); await page.keyboard.up('c'); await page.keyboard.up('Control');
    expect(await page.evaluate(() => copyCalls)).toBe(1);
    await page.keyboard.press('Control+Shift+c');
    await expect.poll(() => page.evaluate(() => copyCalls)).toBe(2);
    expect(await page.evaluate(() => copied)).toBe('Selected output');
    expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('macOS Command+C and Control+C both copy without interrupting', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { value: 'MacIntel' }));
  const errors = await openWorkspace(page);
  await page.evaluate(() => { active.term.focus(); active.term.select(0, 0, 14); sent.length = 0; });
  for (const key of ['Meta+c', 'Control+c', 'Control+Shift+c']) {
    await page.evaluate(() => { copied = ''; });
    await page.keyboard.press(key);
    await expect.poll(() => page.evaluate(() => copied)).toBe('Demo workspace');
  }
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(errors).toEqual([]);
});

test('virtual Ctrl+C copies while other virtual Ctrl combinations retain their native meaning', async ({ page }) => {
  const errors = await openWorkspace(page);
  await page.evaluate(() => { active.term.focus(); active.term.select(0, 0, 14); sent.length = 0; ctrlArmed = true; updateCtrlCap(); });
  await page.keyboard.press('c');
  await expect.poll(() => page.evaluate(() => copied)).toBe('Demo workspace');
  expect(await page.evaluate(() => ctrlArmed)).toBe(false);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  await page.evaluate(() => { deliverTo(active, '\x03'); ctrlArmed = true; deliverTo(active, 'd'); });
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input').map(msg => msg.data))).toEqual(['\x04']);
  expect(errors).toEqual([]);
});

test('copy shortcuts accept native DOM selection and never borrow another pane selection', async ({ page }) => {
  const errors = await openRestartWorkspace(page);
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const term = active.term; term.focus(); term.clearSelection();
    // Keep the native range outside xterm's recycled render-row nodes.
    const source = document.createElement('span'); source.textContent = 'Demo workspace';
    source.style.cssText = 'position:absolute;top:0;left:0;user-select:text;-webkit-user-select:text';
    active.host.append(source);
    window.selectNativeRange = () => {
      const node = source.firstChild;
      const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 14);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    };
    selectNativeRange(); sent.length = 0;
    window.nativeCopied = '';
    document.addEventListener('copy', event => { nativeCopied = String(getSelection()); event.preventDefault(); }, { once: true });
  });
  expect(await page.evaluate(() => String(getSelection()))).toBe('Demo workspace');
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => copied || nativeCopied)).toBe('Demo workspace');
  await page.evaluate(() => { selectNativeRange(); copied = ''; deliverTo(active, '\x03'); });
  await expect.poll(() => page.evaluate(() => copied)).toBe('Demo workspace');
  await page.evaluate(() => { getSelection().removeAllRanges(); active.term.select(0, 0, 14); focusPane(panes[1], true); copied = 'keep'; });
  await page.keyboard.press('Control+c');
  expect(await page.evaluate(() => copied)).toBe('keep');
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(errors).toEqual([]);
});

test('clipboard denial never falls through to Ctrl+C interruption', async ({ page }) => {
  const errors = await openWorkspace(page);
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    document.execCommand = () => false;
    active.term.focus(); active.term.select(0, 0, 14); sent.length = 0;
  });
  await page.keyboard.press('Control+c');
  await expect(page.locator('#toast')).toContainText('复制失败');
  await page.keyboard.press('Control+c');
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(errors).toEqual([]);
});

test('HTTP copy fallback restores terminal focus and does not send control bytes', async ({ page }) => {
  const errors = await openWorkspace(page);
  await page.evaluate(() => {
    Object.defineProperty(window, 'isSecureContext', { value: false });
    document.execCommand = command => { if (command === 'copy') { copied = document.activeElement.value; return true; } return false; };
    active.term.focus(); active.term.select(0, 0, 14); sent.length = 0;
  });
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => copied)).toBe('Demo workspace');
  expect(await page.evaluate(() => document.activeElement === active.term.textarea)).toBe(true);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(errors).toEqual([]);
});

test('copy shortcuts do not override normal form editing', async ({ page }) => {
  const errors = await openWorkspace(page);
  await page.evaluate(() => {
    const input = document.createElement('input'); input.id = 'copy-field'; input.value = 'form text'; document.body.append(input);
    input.focus(); input.select(); window.formCopies = 0;
    input.addEventListener('copy', event => { formCopies++; event.preventDefault(); }); sent.length = 0;
  });
  await page.keyboard.press('Control+c');
  expect(await page.evaluate(() => formCopies)).toBe(1);
  expect(await page.evaluate(() => copied)).toBe('');
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(errors).toEqual([]);
});

test('explicit interruption is confirmed, deduplicated and never stops the tmux session', async ({ page }) => {
  const errors = await openWorkspace(page), posts = [];
  page.on('request', request => { if (request.method() !== 'GET') posts.push(request.url()); });
  await openTools(page);
  await expect(page.locator('#btn-interrupt svg')).toHaveCount(1);
  await page.evaluate(() => { sent.length = 0; });
  await page.getByRole('button', { name: '中断当前程序', exact: true }).click();
  await expect(page.locator('.ui-dialog-msg')).toContainText('不会终止 tmux');
  await page.evaluate(() => requestInterruptActive());
  await expect(page.locator('.ui-dialog')).toHaveCount(1);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('#btn-interrupt')).toBeEnabled();
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  await page.locator('#btn-interrupt').click();
  await page.getByRole('button', { name: '发送中断', exact: true }).click();
  await expect.poll(() => page.evaluate(() => sent.filter(msg => msg.type === 'input').map(msg => msg.data))).toEqual(['\x03']);
  expect(posts.filter(url => /\/api\/sessions\/.+\/(stop|restart)$/.test(url))).toEqual([]);
  expect(errors).toEqual([]);
});

for (const change of ['pane', 'socket', 'restart']) {
  test(`interruption cancels if the ${change} changes during confirmation`, async ({ page }) => {
    const errors = await openRestartWorkspace(page); await openTools(page);
    await page.evaluate(() => { sent.length = 0; });
    await page.locator('#btn-interrupt').click();
    await expect(page.locator('.ui-dialog')).toBeVisible();
    await page.evaluate(change => {
      if (change === 'pane') focusPane(panes[1], false);
      if (change === 'socket') active.ws = { readyState: 1, send: data => sent.push(JSON.parse(data)) };
      if (change === 'restart') restartRequests.set(active.tab.id, 'restarting');
    }, change);
    await page.getByRole('button', { name: '发送中断', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('中断已取消');
    expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('disconnected and restarting terminals disable interruption but still allow copying', async ({ page }) => {
  const errors = await openWorkspace(page); await openTools(page);
  await page.evaluate(() => { active.ws.readyState = 3; setStatus('reconnecting', 'Reconnecting', active); });
  await expect(page.locator('#btn-interrupt')).toBeDisabled();
  await page.evaluate(() => { active.term.focus(); active.term.select(0, 0, 14); sent.length = 0; });
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => copied)).toBe('Demo workspace');
  await page.evaluate(() => { active.ws.readyState = 1; setStatus('connected', 'Connected', active); restartRequests.set(active.tab.id, 'restarting'); updateRestartControls(); });
  await expect(page.locator('#btn-interrupt')).toBeDisabled();
  await page.evaluate(() => requestInterruptActive());
  await expect(page.locator('.ui-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(errors).toEqual([]);
});

for (const width of [320, 390]) {
  test(`mobile interruption confirmation fits ${width}px without opening a keyboard`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors = await openWorkspace(page); await openTools(page);
    await page.locator('#btn-interrupt').click();
    await expect(page.locator('.ui-dialog')).toBeVisible();
    expect(await page.locator('.ui-dialog').evaluate(el => { const box = el.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.ui-dialog input')).toHaveCount(0);
    await page.screenshot({ path: `/tmp/webcc-v97-interrupt-${width}.png` });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect(errors).toEqual([]);
  });
}

test('copy and image staging preserve existing commands', async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(() => active.term.select(0, 0, 14));
  await openTools(page);
  await page.locator('#btn-copy').click();
  await expect.poll(() => page.evaluate(() => copied)).toContain('Demo workspace');
  await openTools(page);
  await page.locator('#btn-img').click();
  await expect(page.locator('#img-modal')).toBeVisible();
  await page.locator('#img-file-input').setInputFiles({
    name: 'demo.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=', 'base64'),
  });
  await expect(page.locator('.img-thumb')).toHaveCount(1);
  await expect(page.locator('#img-send')).toBeEnabled();
  await expect(page.locator('#img-modal')).not.toHaveClass(/is-opening/);
  await page.screenshot({ path: '/tmp/webcc-glass-image.png' });
});

test('missing icon resource does not prevent terminal startup', async ({ page }) => {
  const errors = await openWorkspace(page, 'dark', true);
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await page.locator('#header-split').click();
  await expect(page.locator('.pane')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('mobile drawer after desktop collapse and shorter keyboard viewport stay usable', async ({ page }) => {
  await openWorkspace(page);
  await page.locator('#window-minimise').click();
  await expect(page.locator('body')).toHaveClass(/sb-collapsed/);
  await page.setViewportSize({ width: 390, height: 400 });
  await page.locator('#hamburger').click();
  await expect(page.locator('body')).toHaveClass(/drawer-open/);
  await page.locator('#nav-global').click();
  await expect(page.locator('#new-term')).toBeVisible();
  await page.locator('#scrim').click({ position: { x: 370, y: 100 } });
  await assertFits(page);
});

test('desktop shell uses the reference dimensions and local typefaces', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await openWorkspace(page);
  const metrics = await page.evaluate(() => {
    const rect = id => document.getElementById(id).getBoundingClientRect();
    const app = rect('app');
    const style = getComputedStyle(document.getElementById('app'));
    return {
      x: app.x, y: app.y, width: app.width, height: app.height,
      radius: style.borderRadius, blur: style.backdropFilter,
      sidebar: rect('sidebar').width, header: rect('workspace-header').height,
      footer: rect('workspace-footer').height,
      padding: getComputedStyle(document.getElementById('panes')).padding,
      gap: getComputedStyle(document.getElementById('panes')).gap,
      bar: document.querySelector('.pane-bar').getBoundingClientRect().height,
      mono: active.term.options.fontFamily,
      font: active.term.options.fontSize,
      rowHeight: rowPx(active.term),
    };
  });
  expect(metrics).toMatchObject({ x: 32, y: 32, width: 1376, height: 896, radius: '16px', blur: 'blur(24px)', sidebar: 256, header: 56, footer: 64, padding: '12px', gap: '12px', bar: 33, font: 13 });
  expect(metrics.mono).toContain('CC JetBrains Mono');
  expect(metrics.rowHeight).toBeGreaterThanOrEqual(20);
  expect(metrics.rowHeight).toBeLessThanOrEqual(22);
});

test('reference navigation and search keep sessions reachable', async ({ page }) => {
  await openWorkspace(page);
  await expect(page.locator('#chat-list')).toBeHidden();
  await page.locator('#btn-search').click();
  await expect(page.locator('#session-search')).toBeFocused();
  await expect(page.locator('#nav-global')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#session-search').fill('OpenCode');
  await expect(page.locator('#chat-list .chat-item')).toHaveCount(1);
  await page.locator('#session-search').fill('');
  await expect(page.locator('#chat-list .chat-item')).toHaveCount(4);
  await page.locator('#nav-current').click();
  await expect(page.locator('#chat-list')).toBeHidden();
  await page.locator('#nav-access').click();
  await expect(page.locator('#ips-modal')).toBeVisible();
  await page.locator('#ips-close').click();
  await page.locator('#nav-storage').click();
  await expect(page.locator('#tab-disk')).toHaveAttribute('aria-selected', 'true');
});

test('window controls and terminal tools never stop a task when closing a view', async ({ page }) => {
  const stopped = [];
  page.on('request', req => { if (/\/api\/sessions\/.+\/stop/.test(req.url())) stopped.push(req.url()); });
  await openWorkspace(page);
  await expect(page.locator('#term-header')).toBeVisible();
  await page.locator('#btn-tools').click();
  await expect(page.locator('#term-header')).toBeHidden();
  await page.locator('#btn-tools').click();
  await page.locator('.xterm-helper-textarea').press('Escape');
  await expect(page.locator('#term-header')).toBeVisible();
  await page.locator('#nav-current').click();
  await expect(page.locator('#btn-tools')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#window-minimise').click();
  await expect(page.locator('#btn-sidebar')).toBeVisible();
  await page.locator('#btn-sidebar').click();
  await expect(page.locator('#window-close')).toBeVisible();
  await page.locator('#window-close').click();
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#footer-state')).toHaveText('READY');
  await expect(page.locator('#header-split')).toBeEnabled();
  expect(await page.evaluate(() => panes.length)).toBe(0);
  expect(stopped).toEqual([]);
});

test('all terminal types have only native input and keep per-pane routing', async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(tabs => { for (const tab of tabs.slice(1)) attachTerminal(tab, makePane()); }, tabs);
  await page.waitForFunction(() => panes.every(p => p.ws?.readyState === 1));
  await expect(page.locator('.pane-composer,.pane-draft,.pane-input-toggle,.pane-attachments')).toHaveCount(0);
  for (let i = 0; i < tabs.length; i++) {
    await page.evaluate(i => { window.sent = []; focusPane(panes[i]); }, i);
    await page.locator('.xterm-helper-textarea').nth(i).press('x');
    expect(await page.evaluate(() => sent.filter(m => m.type === 'input').map(m => m.data))).toEqual(['x']);
    expect(await page.evaluate(i => sent.filter(m => m.type === 'input').every(m => m.socket === panes[i].ws.url), i)).toBe(true);
  }
  await assertFits(page);
});

test('native multiline paste uses the application protocol without a web composer', async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(async () => {
    await new Promise(resolve => active.term.write('\x1b[?2004h', resolve));
    window.sent = []; active.term.paste('first\nsecond');
  });
  await page.locator('.xterm-helper-textarea').press('Enter');
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input').map(m => m.data.replace(/\r/g, '\n')))).toEqual(['\x1b[200~first\nsecond\x1b[201~', '\n']);
  await expect(page.locator('.pane-composer')).toHaveCount(0);
});

test('function toolbar stays expanded during native typing, Escape and output clicks', async ({ page }) => {
  await openWorkspace(page);
  await expect(page.locator('#term-header')).toBeVisible();
  await page.locator('.xterm-screen').click({ position: { x: 40, y: 40 } });
  await page.evaluate(() => { window.sent = []; });
  await page.locator('.xterm-helper-textarea').press('Escape');
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input').map(m => m.data))).toEqual(['\x1b']);
  await expect(page.locator('#term-header')).toBeVisible();
  await expect(page.locator('#btn-tools')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#btn-tools').click();
  await expect(page.locator('#term-header')).toBeHidden();
  await assertFits(page);
  await page.reload();
  await page.waitForFunction(() => active?.ws?.readyState === 1);
  await expect(page.locator('#term-header')).toBeHidden();
  await expect(page.locator('#btn-tools')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#btn-tools').click();
  await expect(page.locator('#term-header')).toBeVisible();
  await assertFits(page);
});

test('sidebar always has a hide and restore control and remembers the preference', async ({ page }) => {
  await openWorkspace(page);
  await expect(page.locator('#btn-sidebar')).toBeVisible();
  await expect(page.locator('#btn-sidebar')).toHaveAttribute('aria-expanded', 'true');
  await page.evaluate(() => { window.originalSocket = active.ws; });
  await page.locator('#btn-sidebar').click();
  await expect(page.locator('body')).toHaveClass(/sb-collapsed/);
  await expect(page.locator('#btn-sidebar')).toBeVisible();
  await expect(page.locator('#btn-sidebar')).toHaveAttribute('aria-expanded', 'false');
  await assertFits(page);
  expect(await page.evaluate(() => active.ws === originalSocket)).toBe(true);
  await page.reload();
  await page.waitForFunction(() => active?.ws?.readyState === 1);
  await expect(page.locator('body')).toHaveClass(/sb-collapsed/);
  await page.locator('#btn-sidebar').click();
  await expect(page.locator('body')).not.toHaveClass(/sb-collapsed/);
  await expect(page.locator('#btn-sidebar')).toHaveAttribute('aria-expanded', 'true');
  await assertFits(page);
  await page.locator('#btn-sidebar').click();
  await page.locator('#btn-search').click();
  await expect(page.locator('body')).not.toHaveClass(/sb-collapsed/);
  await expect(page.locator('#session-search')).toBeFocused();
  await expect(page.locator('#chat-list .chat-item')).toHaveCount(4);
});

test('mobile minimise closes the drawer without changing desktop sidebar preference', async ({ page }) => {
  await openWorkspace(page);
  await page.locator('#btn-sidebar').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#hamburger').click();
  await expect(page.locator('body')).toHaveClass(/drawer-open/);
  await page.locator('#window-minimise').click();
  await expect(page.locator('body')).not.toHaveClass(/drawer-open/);
  await expect(page.locator('#hamburger')).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => localStorage.getItem('cc_sb_hidden'))).toBe('1');
  await page.locator('#hamburger').click();
  await expect(page.locator('#nav-files')).toBeVisible();
  await page.locator('#window-minimise').click();
  await assertFits(page);
});

test('single-pane expansion preserves sockets and split sizes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await openWorkspace(page);
  await page.evaluate(tabs => {
    for (const tab of tabs.slice(1)) attachTerminal(tab, makePane());
    window.originalSockets = panes.map(p => p.ws);
  }, tabs);
  await page.waitForFunction(() => panes.every(p => p.ws?.readyState === 1));
  await assertFits(page);
  await page.evaluate(() => { window.originalRows = panes[0].term.rows; });
  const before = await page.locator('.pane').first().boundingBox();
  await page.locator('.pane-expand').first().click();
  await expect(page.locator('.pane:visible')).toHaveCount(1);
  await expect(page.locator('.gutter')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => panes[0].term.rows - originalRows)).toBeGreaterThan(10);
  expect(await page.evaluate(() => panes.every((p, i) => p.ws === originalSockets[i]))).toBe(true);
  await assertFits(page);
  await page.screenshot({ path: '/tmp/webcc-v77-expanded.png' });
  await page.locator('.pane-expand').first().click();
  await expect(page.locator('.pane:visible')).toHaveCount(4);
  await expect(page.locator('.gutter')).toHaveCount(2);
  await expect.poll(async () => Math.abs((await page.locator('.pane').first().boundingBox()).height - before.height)).toBeLessThan(1);
  await assertFits(page);
  await page.screenshot({ path: '/tmp/webcc-v77-four-panes.png' });
});

test('closing an expanded pane restores remaining splits without replacing sockets', async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(tabs => { for (const tab of tabs.slice(1)) attachTerminal(tab, makePane()); }, tabs);
  await page.waitForFunction(() => panes.every(p => p.ws?.readyState === 1));
  await page.evaluate(() => { window.remainingSockets = panes.slice(1).map(p => p.ws); });
  await page.locator('.pane-expand').first().click();
  await page.locator('.pane-x').first().click();
  await expect(page.locator('.pane:visible')).toHaveCount(3);
  expect(await page.evaluate(() => panes.every((p, i) => p.ws === remainingSockets[i]))).toBe(true);
  await assertFits(page);
});

async function stageImage(page) {
  await page.locator('#btn-img').click();
  await page.locator('#img-file-input').setInputFiles({
    name: 'demo.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=', 'base64'),
  });
}

test('visible image control inserts paths into native input without executing', async ({ page }) => {
  await openWorkspace(page);
  await stageImage(page);
  await page.evaluate(() => { window.sent = []; });
  await page.locator('#img-send').click();
  await expect(page.locator('#img-modal')).toBeHidden();
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input').map(m => m.data))).toEqual(['/workspace/demo/.cc-web-images/demo.png ']);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
});

test('pasting an image into the image preview keeps the native path workflow', async ({ page }) => {
  await openWorkspace(page);
  await page.locator('#btn-img').click();
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([1, 2, 3])], 'paste.png', { type: 'image/png' }));
    document.getElementById('img-drop').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.img-thumb')).toHaveCount(1);
  await expect(page.locator('#img-send')).toBeEnabled();
});

for (const replace of [false, true]) {
  test('image upload retains the original native terminal when replaced=' + replace, async ({ page }) => {
    await openWorkspace(page);
    await page.evaluate(tab => { window.imagePane = active; attachTerminal(tab, makePane()); focusPane(imagePane); }, tabs[1]);
    await page.waitForFunction(() => panes.every(p => p.ws?.readyState === 1));
    await stageImage(page);
    await page.route('**/api/term/image*', async route => {
      await page.evaluate(({ replace, tab }) => {
        window.sent = [];
        if (replace) attachTerminal(tab, imagePane);
        focusPane(panes[1]);
      }, { replace, tab: tabs[2] });
      await route.fulfill({ json: { path: '/workspace/demo/.cc-web-images/demo.png' } });
    });
    await page.locator('#img-send').click();
    await expect(page.locator('#img-modal')).toBeHidden();
    const inputs = await page.evaluate(() => sent.filter(m => m.type === 'input'));
    if (replace) expect(inputs).toEqual([]);
    else {
      expect(inputs.map(m => m.data)).toEqual(['/workspace/demo/.cc-web-images/demo.png ']);
      expect(await page.evaluate(() => sent.filter(m => m.type === 'input').every(m => m.socket === imagePane.ws.url))).toBe(true);
    }
    await expect(page.locator('.xterm-helper-textarea').nth(1)).toBeFocused();
  });
}

test('disconnected native input retains staged images until reconnection', async ({ page }) => {
  let uploads = 0;
  await openWorkspace(page);
  await page.route('**/api/term/image*', async route => {
    uploads++;
    await route.fulfill({ json: { path: '/workspace/demo/.cc-web-images/demo.png' } });
  });
  await stageImage(page);
  await page.evaluate(() => { window.sent = []; active.ws.readyState = 0; });
  await page.locator('#img-send').click();
  await expect(page.locator('#toast')).toContainText('终端未连接');
  await expect(page.locator('#img-modal')).toBeVisible();
  await expect(page.locator('.img-thumb')).toHaveCount(1);
  expect(uploads).toBe(0);
  expect(await page.evaluate(() => sent.some(m => m.type === 'input'))).toBe(false);
  await page.evaluate(() => { active.ws.readyState = 1; });
  await page.locator('#img-send').click();
  await expect(page.locator('#img-modal')).toBeHidden();
  expect(uploads).toBe(1);
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input').map(m => m.data))).toEqual(['/workspace/demo/.cc-web-images/demo.png ']);
});

test('a connection lost during image upload cannot silently accept paths', async ({ page }) => {
  await openWorkspace(page);
  await stageImage(page);
  await page.route('**/api/term/image*', async route => {
    await page.evaluate(() => { window.sent = []; active.ws.readyState = 0; });
    await route.fulfill({ json: { path: '/workspace/demo/.cc-web-images/demo.png' } });
  });
  await page.locator('#img-send').click();
  await expect(page.locator('#toast')).toContainText('终端已断线');
  expect(await page.evaluate(() => sent.some(m => m.type === 'input'))).toBe(false);
});

for (const theme of ['dark', 'light']) {
  test(`${theme} uses local fonts, readable confirmation and token controls`, async ({ page }) => {
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await openWorkspace(page, theme);
    expect(requests.every(url => new URL(url).origin === 'http://localhost')).toBe(true);
    expect(await page.evaluate(() => document.fonts.check('12px "CC Inter"'))).toBe(true);
    expect(await page.evaluate(() => document.fonts.check('13px "CC JetBrains Mono"'))).toBe(true);
    await openTools(page);
    await page.locator('#btn-stop').click();
    await expect(page.locator('.ui-dialog')).toBeVisible();
    await expect(page.locator('.ui-dialog-title')).toContainText('Workspace');
    await assertButtonContrast(page.locator('.ui-dialog .primary'));
    expect(requests.some(url => url.endsWith('/stop'))).toBe(false);
    await page.locator('.ui-dialog .ui-btn:not(.primary)').click();
    await expect(page.locator('.ui-dialog')).toHaveCount(0);
    await expect(page.locator('.pane')).toHaveCount(1);
    await page.locator('#set-token').click();
    await expect(page.locator('#login')).toBeVisible();
    await assertButtonContrast(page.locator('#login-go'));
    await page.locator('#login-input').fill('demo-token');
    await expect(page.locator('#login')).not.toHaveClass(/is-opening/);
    await page.screenshot({ path: `/tmp/webcc-glass-login-${theme}.png` });
  });
}

test('touch viewport and reduced motion retain usable key controls', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await openWorkspace(page);
  await openTools(page);
  await expect(page.locator('#btn-kbd')).toBeVisible();
  await expect(page.locator('#term-header')).toBeVisible();
  await expect(page.locator('#auxbar')).toBeVisible();
  expect((await page.locator('#auxbar .keycap').first().boundingBox()).height).toBeGreaterThanOrEqual(38);
  await page.locator('#auxbar [aria-label="↑"]').tap();
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input').at(-1).data)).toBe('\x1b[A');
  await assertFits(page);
  await context.close();
});
