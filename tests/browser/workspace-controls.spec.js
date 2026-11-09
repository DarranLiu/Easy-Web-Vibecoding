const { test, expect } = require('@playwright/test');
const { workspace } = require('./workspace.fixture.cjs');

const stopped = (type = 'codex') => ({ id: 'saved', name: 'Saved task', cwd: '/workspace/demo', type, alive: false });
const check = (page, id) => page.locator(`#ws-split-list input[data-session="${id}"]`);
const order = page => page.locator('#ws-workspace-list > .ws-tree-group').evaluateAll(els => els.map(el => el.dataset.group));
const mutations = fixture => fixture.requests.filter(r => r.path.startsWith('/api/sessions') && r.method !== 'GET');
const ids = page => page.evaluate(() => panes.map(p => p.tab?.id || p.savedId));
const noInput = async page => expect(await page.evaluate(() => sent.filter(m => m.type === 'input'))).toEqual([]);

async function picker(page) {
  const trigger = page.locator(page.viewportSize().width <= 820 ? '#btn-split' : '#header-split');
  await trigger.scrollIntoViewIfNeeded(); await trigger.click();
  await expect(page.locator('#ws-split-modal')).toBeVisible();
}
async function apply(page) {
  await page.locator('#ws-split-apply').click();
  await expect(page.locator('#ws-split-modal')).toBeHidden();
  await page.evaluate(() => ccWorkspace.persist());
}
async function rename(page, name) {
  await page.locator('.ui-dialog-input').fill(name);
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await expect(page.locator('.ui-dialog')).toHaveCount(0);
}

for (const type of ['codex', 'claude', 'opencode', 'shell']) {
  test(`stopped ${type} is selectable and persists without starting it`, async ({ page }) => {
    const fixture = await workspace(page, 'dark', { extraTabs: [stopped(type)] });
    await page.evaluate(() => { window.kept = { pane: active, term: active.term, ws: active.ws }; });
    await picker(page); await expect(check(page, 'saved')).toBeEnabled();
    await check(page, 'saved').check(); await apply(page);
    expect(await ids(page)).toEqual(['demo01', 'saved']);
    await expect(page.locator('.ws-offline-pane')).toContainText('会话已停止');
    expect(await page.evaluate(() => panes[0] === kept.pane && panes[0].term === kept.term && panes[0].ws === kept.ws)).toBe(true);
    if (type === 'codex') await page.screenshot({ path: '/tmp/webcc-v113-offline-split.png' });
    await picker(page); await expect(check(page, 'saved')).toBeChecked();
    if (type === 'codex') {
      await expect(page.locator('#ws-split-modal')).not.toHaveClass(/is-opening/);
      await page.screenshot({ path: '/tmp/webcc-v113-stopped-picker.png' });
    }
    await page.locator('#ws-split-search').fill('Saved');
    await page.locator('#ws-split-directions [data-direction="col"]').click();
    await expect(check(page, 'saved')).toBeChecked(); await apply(page);
    await page.reload(); await page.waitForFunction(() => ccWorkspace?.ready && panes.length === 2);
    expect(await ids(page)).toEqual(['demo01', 'saved']);
    await expect(page.locator('.ws-offline-pane')).toHaveCount(1);
    expect(mutations(fixture)).toEqual([]); await noInput(page);
    expect(fixture.errors).toEqual([]);
  });
}

test('stopped selection cancels without replacing panes and counts toward the four-pane limit', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraTabs: [stopped()] });
  await picker(page);
  for (const id of ['demo02', 'demo03', 'saved']) await check(page, id).check();
  await check(page, 'demo04').click();
  await expect(check(page, 'demo04')).not.toBeChecked();
  await expect(page.locator('#ws-split-state')).toHaveText('最多 4 个终端');
  await page.locator('#ws-split-close button').click();
  expect(await ids(page)).toEqual(['demo01']); expect(mutations(fixture)).toEqual([]);
  await noInput(page); expect(fixture.errors).toEqual([]);
});

test('stopped selection survives canceling the new-terminal subdialog', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraTabs: [stopped()] });
  await picker(page); await check(page, 'saved').check();
  await page.locator('#ws-split-create').click();
  await expect(page.locator('#dir-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#ws-split-modal')).toBeVisible();
  await expect(check(page, 'saved')).toBeChecked();
  await expect(page.locator('#ws-split-state')).toHaveText('2 / 4');
  expect(mutations(fixture)).toEqual([]); expect(fixture.errors).toEqual([]);
});

test('last multi-window selection can include stopped placeholders', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraTabs: [stopped()] });
  await picker(page); await check(page, 'saved').check(); await apply(page);
  await picker(page); await check(page, 'saved').uncheck(); await apply(page);
  expect(await ids(page)).toEqual(['demo01']);
  await picker(page); await page.locator('#ws-split-backup button').click();
  await expect(check(page, 'saved')).toBeChecked(); await apply(page);
  expect(await ids(page)).toEqual(['demo01', 'saved']);
  expect(mutations(fixture)).toEqual([]); expect(fixture.errors).toEqual([]);
});

test('stopped placeholder restores the exact bound session only after confirmation', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraTabs: [stopped()] });
  await picker(page); await check(page, 'saved').check(); await apply(page);
  await page.locator('.ws-offline-pane button').click();
  await expect(page.locator('.ui-dialog')).toContainText('12345678-1234-4234-8234-123456789abc');
  expect(mutations(fixture)).toEqual([]);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !openingTab);
  await expect(page.locator('.ws-offline-pane')).toHaveCount(1);
  await page.locator('.ws-offline-pane button').click();
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await page.waitForFunction(() => active?.tab?.id === 'saved' && active.ws?.readyState === 1);
  expect(await ids(page)).toEqual(['demo01', 'saved']);
  expect(mutations(fixture).map(r => r.path)).toEqual(['/api/sessions/saved/start']);
  await noInput(page); expect(fixture.errors).toEqual([]);
});

test('unbound stopped placeholder opens history choices without guessing or starting', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraTabs: [stopped('claude')] });
  await page.route('**/api/sessions/saved/restart', r => r.fulfill({ status: 409, json: { detail: 'No binding' } }));
  await page.route('**/api/sessions/saved/recovery?*', r => r.fulfill({ json: { candidates: [], total: 0, expected: 'old', hasMore: false } }));
  await picker(page); await check(page, 'saved').check(); await apply(page);
  await page.locator('.ws-offline-pane button').click();
  await expect(page.locator('#recovery-state')).toContainText('未找到');
  await expect(page.locator('#recovery-apply')).toBeDisabled();
  await page.locator('#recovery-close').click();
  expect(await ids(page)).toEqual(['demo01', 'saved']);
  expect(mutations(fixture)).toEqual([]); await noInput(page); expect(fixture.errors).toEqual([]);
});

test('moving a stopped selection to another screen removes its former placement', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraTabs: [stopped()] });
  await picker(page); await check(page, 'saved').check(); await apply(page);
  await page.locator('#ws-screen-add').click(); await picker(page);
  await expect(check(page, 'saved').locator('..')).toContainText('其他屏幕已打开');
  await check(page, 'saved').check(); await apply(page);
  const layout = Object.values(fixture.layouts).find(v => v.screens?.length === 2);
  expect(layout.screens.map(s => s.panes)).toEqual([['demo01'], ['saved']]);
  await page.reload(); await page.waitForFunction(() => ccWorkspace?.ready);
  expect(await ids(page)).toEqual(['saved']);
  expect(mutations(fixture)).toEqual([]); expect(fixture.errors).toEqual([]);
});

test('removed selection fails safely instead of changing the current panes', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraTabs: [stopped()] });
  await picker(page); await check(page, 'saved').check();
  await page.evaluate(() => { state.tabs = state.tabs.filter(t => t.id !== 'saved'); });
  await page.locator('#ws-split-apply').click();
  await expect(page.locator('#toast')).toContainText('已移除');
  expect(await ids(page)).toEqual(['demo01']);
  expect(mutations(fixture)).toEqual([]); expect(fixture.errors).toEqual([]);
});

test('a selected session stopping while the picker is open remains selected', async ({ page }) => {
  const fixture = await workspace(page);
  await picker(page); await check(page, 'demo02').check();
  fixture.tabs.find(t => t.id === 'demo02').alive = false;
  await page.evaluate(() => loadTabs());
  await page.locator('#ws-split-search').fill('Codex');
  await expect(check(page, 'demo02')).toBeChecked(); await apply(page);
  expect(await ids(page)).toEqual(['demo01', 'demo02']);
  await expect(page.locator('.ws-offline-pane')).toHaveCount(1);
  expect(mutations(fixture)).toEqual([]); expect(fixture.errors).toEqual([]);
});

for (const method of ['double-click', 'F2']) {
  test(`screen rename via ${method} persists the label without terminal mutations`, async ({ page }) => {
    const fixture = await workspace(page);
    const tab = page.locator('#ws-screen-tabs [aria-selected="true"]');
    if (method === 'double-click') await tab.dblclick();
    else { await tab.focus(); await page.keyboard.press('F2'); }
    await rename(page, 'Research <1>');
    await expect(tab).toContainText('Research <1>');
    await page.evaluate(() => ccWorkspace.persist());
    await page.reload(); await page.waitForFunction(() => ccWorkspace?.ready);
    await expect(tab).toContainText('Research <1>');
    expect(mutations(fixture)).toEqual([]); await noInput(page); expect(fixture.errors).toEqual([]);
  });
}

test('canceling or submitting an invalid screen name preserves its saved name', async ({ page }) => {
  const fixture = await workspace(page);
  const tab = page.locator('#ws-screen-tabs [aria-selected="true"]');
  const before = await tab.textContent();
  await page.locator('.ws-screen-rename').click(); await page.keyboard.press('Escape');
  await expect(page.locator('.ui-dialog')).toHaveCount(0);
  await page.locator('.ws-screen-rename').click(); await rename(page, 'a'.repeat(81));
  await expect(page.locator('#toast')).toContainText('最多80');
  await expect(tab).toHaveText(before);
  expect(mutations(fixture)).toEqual([]); expect(fixture.errors).toEqual([]);
});

test('name sorting is natural, pinned-first and stable during activity and refresh', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraSpaces: [
    { id: 'ten', name: 'Project 10', members: [], pinned: false, revision: 1 },
    { id: 'two', name: 'Project 2', members: [], pinned: false, revision: 1 },
    { id: 'pin', name: 'Z pinned', members: [], pinned: true, revision: 1 },
  ] });
  await page.evaluate(() => { window.kept = { pane: active, term: active.term, ws: active.ws, count: socketCount }; });
  await page.locator('#ws-workspace-sort').selectOption('name');
  const expected = ['pin', 'ws_demo', 'two', 'ten', 'ws_tools'];
  expect(await order(page)).toEqual(expected);
  await page.locator('[data-workspace="ws_tools"]').click();
  expect(await order(page)).toEqual(expected);
  expect(await page.evaluate(() => active === kept.pane && active.term === kept.term && active.ws === kept.ws && socketCount === kept.count)).toBe(true);
  await page.reload(); await page.waitForFunction(() => ccWorkspace?.ready);
  await expect(page.locator('#ws-workspace-sort')).toHaveValue('name');
  expect(await order(page)).toEqual(expected);
  await page.locator('#ws-workspace-sort').selectOption('activity');
  expect((await order(page)).slice(0, 2)).toEqual(['pin', 'ws_tools']);
  expect(mutations(fixture)).toEqual([]); await noInput(page); expect(fixture.errors).toEqual([]);
});

test('sort preference is isolated by the locally bound layout profile', async ({ page }) => {
  const fixture = await workspace(page);
  await page.locator('#ws-workspace-sort').selectOption('name');
  await page.locator('#ws-layout-user').click();
  await page.locator('#ws-user-input').fill('demo'); await page.locator('#ws-user-bind').click();
  await expect(page.locator('#ws-user-modal')).toBeHidden();
  await expect(page.locator('#ws-workspace-sort')).toHaveValue('activity');
  await page.locator('#ws-layout-user').click(); await page.locator('#ws-user-local').click();
  await expect(page.locator('#ws-user-modal')).toBeHidden();
  await expect(page.locator('#ws-workspace-sort')).toHaveValue('name');
  expect(fixture.errors).toEqual([]);
});

test('screen rename opened on desktop cannot rename the mobile layout after resizing', async ({ page }) => {
  const fixture = await workspace(page);
  await page.locator('.ws-screen-rename').click();
  await page.locator('.ui-dialog-input').fill('Wrong device');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => Object.keys(fixture.layouts).some(k => k.includes('/mobile_'))).toBe(true);
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await expect(page.locator('#toast')).toContainText('布局已切换');
  await expect(page.locator('#ws-screen-tabs [aria-selected="true"]')).not.toContainText('Wrong device');
  expect(Object.values(fixture.layouts).flatMap(v => v.screens || []).some(s => s.name === 'Wrong device')).toBe(false);
  expect(fixture.errors).toEqual([]);
});

for (const theme of ['dark', 'light']) {
  for (const width of [320, 390, 1440]) {
    test(`${theme} workspace controls fit ${width}px with separate group and child surfaces`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await workspace(page, theme, { extraTabs: [stopped()] });
      await expect(page.locator('.ws-screen-rename')).toBeVisible();
      await page.locator('.ws-screen-rename').click(); await rename(page, 'Daily');
      await expect(page.locator('#ws-screen-tabs [aria-selected="true"]')).toContainText('Daily');
      if (width < 821) {
        await page.locator('#hamburger').click();
        await expect(page.locator('#sidebar')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
      }
      await expect(page.locator('#ws-workspace-sort')).toBeVisible();
      await page.locator('#ws-workspace-sort').selectOption('name');
      await page.locator('#ws-session-search').fill('');
      await expect(page.locator('[data-workspace="ws_demo"]')).toHaveAttribute('aria-expanded', 'true');
      const colors = await page.locator('[data-group="ws_demo"]').evaluate(el => ({
        parent: getComputedStyle(el.querySelector('.ws-workspace')).backgroundColor,
        child: getComputedStyle(el.querySelector('.ws-tree-children')).backgroundColor,
      }));
      expect(colors.parent).not.toBe(colors.child);
      expect(colors.parent).not.toBe('rgba(0, 0, 0, 0)');
      for (const selector of ['#ws-workspace-sort', '.ws-section-head', '#ws-screen-bar', '.ws-screen-rename']) {
        const box = await page.locator(selector).boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `/tmp/webcc-v113-${theme}-${width}.png` });
      expect(mutations(fixture)).toEqual([]); expect(fixture.errors).toEqual([]);
    });
  }
}

test('mobile can select and reopen one stopped placeholder without starting it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await workspace(page, 'dark', { extraTabs: [stopped()] });
  await picker(page); await check(page, 'demo01').uncheck(); await check(page, 'saved').check(); await apply(page);
  expect(await ids(page)).toEqual(['saved']);
  await page.reload(); await page.waitForFunction(() => ccWorkspace?.ready);
  await expect(page.locator('.ws-offline-pane')).toHaveCount(1);
  expect(mutations(fixture)).toEqual([]); await noInput(page); expect(fixture.errors).toEqual([]);
});
