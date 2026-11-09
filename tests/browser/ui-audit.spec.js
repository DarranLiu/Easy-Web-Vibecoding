const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { workspace } = require('./workspace.fixture.cjs');

async function panel(page, name) {
  if (await page.locator('#ws-mobile-deck').isVisible() && await page.locator('#ws-mobile-deck').getAttribute('aria-expanded') !== 'true') await page.locator('#ws-mobile-deck').click();
  await page.locator(`[data-panel="${name}"]`).click();
}

async function editor(page) {
  await panel(page, 'files');
  await page.locator('[data-file="/workspace/demo/index.js"]').click();
  await expect(page.locator('#ws-editor-text')).toBeVisible();
}

test('audit file save is single flight while typing remains editable', async ({ page }) => {
  const fixture = await workspace(page); await editor(page);
  let release, writes = 0;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/fs/edit', async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    writes++; await pending; await route.fulfill({ json: { etag: 'saved-once' } });
  });
  await page.locator('#ws-editor-text').fill('first edit');
  await page.evaluate(() => { const button = document.querySelector('#ws-editor-actions button'); button.click(); button.click(); button.click(); });
  await page.waitForTimeout(100);
  const count = writes;
  await page.locator('#ws-editor-text').fill('continued typing');
  release();
  await expect(page.locator('#ws-editor-state')).toContainText('未保存');
  expect(count).toBe(1);
  expect(fixture.errors).toEqual([]);
});

test('audit editor Ctrl+S saves without terminal input', async ({ page }) => {
  const fixture = await workspace(page); await editor(page);
  await page.locator('#ws-editor-text').fill('saved from keyboard');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fixture.requests.filter(request => request.path === '/api/fs/edit' && request.method === 'PUT').length).toBe(1);
  await expect(page.locator('#ws-editor-state')).toContainText('已保存');
  expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('audit Git filter discards an old in-flight diff', async ({ page }) => {
  const fixture = await workspace(page); await panel(page, 'git');
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/git/diff?*', async route => { await pending; await route.fulfill({ json: { text: '+old working tree diff' } }); });
  await page.locator('#ws-deck-content .ws-row').click();
  await page.locator('#ws-git-staged').click();
  release(); await page.waitForTimeout(150);
  await expect(page.locator('.ws-diff')).toHaveCount(0);
  await expect(page.locator('#ws-deck-content')).toContainText('暂无暂存更改');
  expect(fixture.errors).toEqual([]);
});

test('audit confirmation Enter on Cancel never confirms a destructive action', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(() => { window.answer = null; uiConfirm('Delete synthetic group?', 'The terminal keeps running.', true).then(value => { answer = value; }); });
  await expect(page.locator('.ui-dialog')).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => answer)).toBe(false);
  expect(fixture.errors).toEqual([]);
});

test('audit prompt does not submit a composing Enter', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(() => { window.answer = null; uiPrompt('Rename synthetic group', 'Demo').then(value => { answer = value; }); });
  const input = page.locator('.ui-dialog-input');
  await input.focus();
  await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
  await expect(page.locator('.ui-dialog')).toBeVisible();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => answer)).toBe(null);
  expect(fixture.errors).toEqual([]);
});

test('audit palette has a real empty state and combobox semantics', async ({ page }) => {
  const fixture = await workspace(page);
  await page.locator('#ws-command').click();
  await page.locator('#ws-palette-input').fill('no-matching-entry-12345');
  await expect(page.locator('#ws-palette-empty')).toBeVisible();
  await expect(page.locator('#ws-palette-input')).toHaveAttribute('role', 'combobox');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('audit pending save blocks navigation and keeps new edits after completion', async ({ page }) => {
  const fixture = await workspace(page); await editor(page);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/fs/edit', async route => { await pending; await route.fulfill({ json: { etag: 'saved-once' } }); });
  await page.locator('#ws-editor-text').fill('first'); await page.locator('#ws-editor-save').click();
  await page.locator('#ws-editor-text').fill('second');
  await page.locator('[data-panel="git"]').click();
  await expect(page.locator('#ws-editor-text')).toHaveValue('second');
  await expect(page.locator('.ui-dialog')).toHaveCount(0);
  release(); await expect(page.locator('#ws-editor-save')).toBeEnabled();
  await expect(page.locator('#ws-editor-state')).toHaveText('未保存');
  expect(fixture.errors).toEqual([]);
});

test('audit modal focus returns to its trigger and nested Escape affects only the top dialog', async ({ page }) => {
  const fixture = await workspace(page);
  await page.locator('#ws-command').click();
  await expect(page.locator('#ws-palette-input')).toBeFocused();
  await page.evaluate(() => { void uiPrompt('Synthetic confirmation', 'Demo'); });
  await page.locator('.ui-dialog-input').focus();
  await page.keyboard.press('Control+Shift+p');
  await expect(page.locator('.ui-dialog-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ui-dialog')).toHaveCount(0);
  await expect(page.locator('#ws-palette-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#ws-command')).toBeFocused();
  expect(fixture.errors).toEqual([]);
});

test('audit two confirmations cannot both be dismissed by one Escape', async ({ page }) => {
  await workspace(page);
  await page.evaluate(() => { window.answers = []; void uiConfirm('First', '').then(v => answers.push(['first', v])); });
  await page.waitForTimeout(50);
  await page.evaluate(() => { void uiConfirm('Second', '').then(v => answers.push(['second', v])); });
  await page.waitForTimeout(50); await page.keyboard.press('Escape');
  await expect(page.locator('.ui-dialog')).toHaveCount(1);
  expect(await page.evaluate(() => answers)).toEqual([['second', false]]);
});

for (const base of ['dir', 'files', 'gpu', 'ips', 'img']) test(`audit nested prompt Escape preserves the ${base} dialog`, async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(base => { openLayer(document.getElementById(base + '-modal')); void uiPrompt('Nested prompt', 'Demo'); }, base);
  await page.locator('.ui-dialog-input').focus(); await page.keyboard.press('Escape');
  await expect(page.locator('.ui-dialog')).toHaveCount(0);
  await expect(page.locator('#' + base + '-modal')).toBeVisible();
  expect(fixture.errors).toEqual([]);
});

test('audit panel tabs have roving focus without sending terminal keys', async ({ page }) => {
  const fixture = await workspace(page);
  await page.locator('#ws-panel-tab-fleet').focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('#ws-panel-tab-files')).toBeFocused();
  await expect(page.locator('#ws-deck-content')).toHaveAttribute('aria-labelledby', 'ws-panel-tab-files');
  await expect(page.locator('#ws-panel-tab-fleet')).toHaveAttribute('tabindex', '-1');
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('audit history over the command palette closes and restores focus one layer at a time', async ({ page }) => {
  await workspace(page);
  await page.locator('#ws-command').click(); await expect(page.locator('#ws-palette-input')).toBeFocused();
  await page.keyboard.press('Control+Shift+f'); await expect(page.locator('#ws-history-input')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.locator('#ws-history-modal')).toBeHidden();
  await expect(page.locator('#ws-palette-input')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.locator('#ws-palette-modal')).toBeHidden();
  await expect(page.locator('#ws-command')).toBeFocused();
});

test('audit reopening the palette above history keeps pointer and keyboard layers consistent', async ({ page }) => {
  await workspace(page);
  await page.keyboard.press('Control+Shift+f'); await expect(page.locator('#ws-history-input')).toBeFocused();
  await page.keyboard.press('Control+Shift+p'); await expect(page.locator('#ws-palette-input')).toBeFocused();
  expect(await page.locator('#ws-palette-input').evaluate(el => {
    const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
  })).toBe(true);
  await page.keyboard.press('Escape'); await expect(page.locator('#ws-history-input')).toBeFocused();
});

test('audit failed activity acknowledgement can be retried without automatic writes', async ({ page }) => {
  await workspace(page); await panel(page, 'activity');
  let writes = 0;
  await page.route('**/api/fleet/ack', route => { writes++; return route.fulfill({ status: 503, json: { detail: 'Temporary failure' } }); });
  const mark = page.getByRole('button', { name: '全部标为已读', exact: true });
  await mark.click(); await expect(page.locator('#toast')).toContainText('Temporary failure');
  await expect(mark).toBeEnabled(); expect(writes).toBe(1);
  await mark.click(); await expect.poll(() => writes).toBe(2); await expect(mark).toBeEnabled();
});

test('audit a late workspace rename never switches back from another workspace', async ({ page }) => {
  const fixture = await workspace(page); await panel(page, 'settings');
  let release, started = false;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/workspaces/ws_demo', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    started = true; await pending; await route.fallback();
  });
  await page.locator('.ws-setting', { hasText: '工作区名称' }).getByRole('button').click();
  await page.locator('.ui-dialog-input').fill('Renamed workspace'); await page.keyboard.press('Enter');
  await expect.poll(() => started).toBe(true);
  await page.locator('#ws-tree-heading-ws_tools').click();
  await expect.poll(() => page.evaluate(() => ccWorkspace.current.id)).toBe('ws_tools');
  release();
  await expect(page.locator('#ws-tree-heading-ws_demo')).toContainText('Renamed workspace');
  expect(await page.evaluate(() => ccWorkspace.current.id)).toBe('ws_tools');
  expect(fixture.errors).toEqual([]);
});

test('audit late activity acknowledgement cannot overwrite the file panel', async ({ page }) => {
  const fixture = await workspace(page); await panel(page, 'activity');
  let release, started = false;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/fleet/ack', async route => { started = true; await pending; await route.fallback(); });
  await page.getByRole('button', { name: '全部标为已读', exact: true }).click();
  await expect.poll(() => started).toBe(true); await panel(page, 'files'); release();
  await expect(page.locator('[data-file="/workspace/demo/index.js"]')).toBeVisible();
  await page.waitForTimeout(150); await expect(page.locator('#ws-events-actions')).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test('audit file listing failure can be retried and an empty directory is explicit', async ({ page }) => {
  const fixture = await workspace(page);
  let failed = true;
  await page.route('**/api/fs?*', route => failed ? route.fulfill({ status: 503, json: { detail: 'Temporary failure' } }) :
    route.fulfill({ json: { path: '/workspace/demo', entries: [] } }));
  await panel(page, 'files'); await expect(page.locator('#ws-deck-content')).toContainText('Temporary failure');
  failed = false; await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await expect(page.locator('#ws-deck-content')).toContainText('此文件夹为空');
  expect(fixture.errors).toEqual([]);
});

test('audit mobile deck traps focus, allows foreground dialogs and restores terminal access', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await workspace(page);
  await page.locator('#ws-mobile-deck').click();
  await expect(page.locator('#ws-deck')).toHaveAttribute('aria-modal', 'true');
  expect(await page.locator('#main').evaluate(el => el.inert)).toBe(true);
  for (let i = 0; i < 18; i++) { await page.keyboard.press('Tab'); expect(await page.evaluate(() => document.querySelector('#ws-deck').contains(document.activeElement))).toBe(true); }
  await panel(page, 'settings');
  await page.locator('.ws-setting', { hasText: '工作区名称' }).getByRole('button').click();
  await expect(page.locator('.ui-dialog-input')).toBeFocused(); await page.keyboard.press('Escape');
  await expect(page.locator('.ui-dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#ws-mobile-deck')).toBeFocused();
  expect(await page.locator('#main').evaluate(el => el.inert)).toBe(false);
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const theme of ['dark', 'light']) for (const width of [1440, 390]) {
  test(`ui audit diagnostics ${theme} ${width}`, async ({ page }) => {
    test.skip(!process.env.WEBCC_UI_AUDIT, 'Opt-in visual and axe audit');
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: width < 800 ? 844 : 900 });
    const fixture = await workspace(page, theme, { initial: { panes: ['demo01', 'demo02', 'demo03'], active: 'demo02' } });
    const output = process.env.WEBCC_AUDIT_OUTPUT || '/tmp/webcc-ui-audit';
    fs.mkdirSync(output, { recursive: true });
    const AxeBuilder = require(process.env.WEBCC_AXE).default;
    const report = [];
    for (const view of ['workspace', 'files', 'git', 'settings', 'split', 'palette', 'confirm']) {
      if (['files', 'git', 'settings'].includes(view)) await panel(page, view);
      if (view === 'split') await page.evaluate(() => ccWorkspace.openSplitPicker());
      if (view === 'palette') await page.keyboard.press('Control+Shift+p');
      if (view === 'confirm') await page.evaluate(() => { void uiPrompt('Rename workspace', 'API workspace'); });
      await page.waitForTimeout(250);
      // ANSI output is supplied by external programs, not the web UI's color tokens.
      const result = await new AxeBuilder({ page }).exclude('.xterm-rows').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth > innerWidth,
        dialogs: [...document.querySelectorAll('.modal:not(.hidden) .modal-box,.ui-dialog')].filter(el => el.getClientRects().length).map(el => {
          const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight };
        }) }));
      report.push({ view, overflow, violations: result.violations.map(item => ({ id: item.id, impact: item.impact,
        nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })) });
      await page.screenshot({ path: path.join(output, `${theme}-${width}-${view}.png`) });
      if (['split', 'palette', 'confirm'].includes(view)) { await page.keyboard.press('Escape'); await page.waitForTimeout(180); }
    }
    fs.writeFileSync(path.join(output, `${theme}-${width}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ theme, width, issues: report.map(item => ({ view: item.view, rules: item.violations.map(rule => `${rule.id}:${rule.nodes.length}`), overflow: item.overflow })) }));
    if (process.env.WEBCC_AUDIT_STRICT) {
      expect(report.flatMap(item => item.violations)).toEqual([]);
      expect(report.some(item => item.overflow.page || item.overflow.dialogs.some(dialog => !dialog.fits))).toBe(false);
    }
    expect(fixture.errors).toEqual([]);
  });
}
