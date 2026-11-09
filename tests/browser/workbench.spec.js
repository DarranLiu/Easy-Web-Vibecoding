const { test, expect } = require('@playwright/test');
const { workspace } = require('./workspace.fixture.cjs');

for (const theme of ['dark', 'light']) for (const width of [320, 390, 820, 821, 850, 900, 1024, 1440, 1920]) {
  test(`reference workbench bounds ${theme} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 960 });
    const f = await workspace(page, theme, { deck: null, initial: { panes: width > 820 ? ['demo02', 'demo03'] : ['demo02'], active: 'demo02' } });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width > 820) {
      await expect(page.locator('body')).toHaveClass(/deck-closed/);
      expect(await page.locator('#workspace-header').evaluate(el => el.parentElement.id)).toBe('app');
      expect(await page.locator('#ws-screen-bar').evaluate(el => el.parentElement.id)).toBe('app');
      for (const id of ['workbench-lookup', 'ws-command', 'header-new', 'header-split', 'btn-reference', 'btn-permissions', 'btn-files', 'btn-versions', 'btn-gpu', 'btn-tools', 'ws-layout-save']) {
        const box = await page.locator('#' + id).boundingBox();
        expect(box, id).not.toBeNull();
        expect(box.x, id).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, id).toBeLessThanOrEqual(width);
        expect(box.width, id).toBeGreaterThanOrEqual(26);
      }
      const header = await page.locator('#workspace-header').boundingBox();
      const bar = await page.locator('#ws-screen-bar').boundingBox();
      const pane = await page.locator('.pane').first().boundingBox();
      expect(bar.y).toBeGreaterThanOrEqual(header.y + header.height);
      expect(pane.y).toBeGreaterThan(bar.y + bar.height);
    }
    await page.evaluate(async () => {
      for (const p of panes) if (p.term) await new Promise(resolve => p.term.write('\x1b[2J\x1b[H' + p.tab.name + '\r\n\r\n/workspace/demo\r\n\r\nReview the changes and run the checks.\r\n\r\n\x1b[32mPASS\x1b[0m  Session continuity\r\n\x1b[32mPASS\x1b[0m  Layout restoration\r\n\r\nReady for the next task.\r\n\r\n> ', resolve));
    });
    expect(await page.evaluate(() => active.term.options.theme.background)).toBe(theme === 'dark' ? '#0c0d0f' : '#ffffff');
    expect(await page.evaluate(() => active.term.options.minimumContrastRatio)).toBe(4.5);
    await page.screenshot({ path: info.outputPath(`workbench-${theme}-${width}.png`) });
    expect(f.errors).toEqual([]);
  });
}

test('reference controls open real workflows without native input or duplicate controls', async ({ page }) => {
  await page.setViewportSize({width: 1440, height: 960});
  const f = await workspace(page, 'dark', { deck: null });
  for (const [button, modal] of [['workbench-lookup', 'session-lookup-modal'], ['ws-command', 'ws-palette-modal'], ['header-new', 'dir-modal'], ['header-split', 'ws-split-modal'], ['btn-reference', 'reference-modal'], ['btn-files', 'files-modal']]) {
    await page.locator('#' + button).click();
    await expect(page.locator('#' + modal)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#' + modal)).toBeHidden();
  }
  const duplicateIds = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
    return ids.filter((id, i) => ids.indexOf(id) !== i);
  });
  expect(duplicateIds).toEqual([]);
  expect(await page.evaluate(() => sent.filter(v => v.type === 'input'))).toEqual([]);
  expect(f.requests.filter(r => r.method !== 'GET' && /\/api\/(sessions|agents)\b/.test(r.path))).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('direction control persists the actual screen and restores after reload', async ({ page }) => {
  const f = await workspace(page, 'dark', { deck: null, profile: 'synthetic', layouts: {
    '/api/layouts/desktop_user_synthetic': {panes: ['demo01', 'demo02'], active: 'demo02', direction: 'row', ratios: {}, revision: 1},
  } });
  await page.evaluate(() => { window.original = panes.map(p => ({p, term: p.term, ws: p.ws})); });
  await page.locator('#workbench-direction-col').click();
  await expect(page.locator('#workbench-direction-col')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => f.layouts['/api/layouts/desktop_user_synthetic']?.direction).toBe('col');
  expect(await page.evaluate(() => original.every(({p, term, ws}) => p.term === term && p.ws === ws))).toBe(true);
  await page.reload();
  await page.waitForFunction(() => ccWorkspace.ready);
  await expect(page.locator('#panes')).toHaveAttribute('data-eff', 'col');
  expect(f.errors).toEqual([]);
});

test('breakpoint round trips retain all original action handlers and placements', async ({ page }) => {
  const f = await workspace(page, 'dark', {deck: null});
  for (const width of [390, 1440, 820, 1024, 320, 1440]) {
    await page.setViewportSize({width, height: 900});
    await page.waitForFunction(() => ccWorkspace.ready && active?.ws?.readyState === 1);
    for (const id of ['btn-sidebar', 'btn-copy', 'btn-permissions', 'btn-reference', 'theme-toggle']) await expect(page.locator('#' + id)).toHaveCount(1);
    expect(await page.locator('#workspace-header').evaluate(el => el.parentElement.id)).toBe(width > 820 ? 'app' : 'main');
    await page.evaluate(() => { window.refs = panes.map(p => ({p, term:p.term, ws:p.ws})); toggleTheme(); });
    expect(await page.evaluate(() => refs.every(({p, term, ws}) => p.term === term && p.ws === ws))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(f.errors).toEqual([]);
});

test('untrusted workspace names remain text, reference never loads remote assets', async ({ page }) => {
  const urls = []; page.on('request', r => urls.push(r.url()));
  const f = await workspace(page, 'dark', { extraSpaces: [{ id: 'ws_hostile', name: '<img src=x onerror="window.injected=1">', cwd: '/workspace/demo', members: [], revision: 1 }] });
  await expect(page.locator('[data-workspace="ws_hostile"]')).toContainText('<img');
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  expect(urls.filter(url => !url.startsWith('http://workspace.test/') && !url.startsWith('data:'))).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('opaque light terminal contrast and optional glass theme use their actual backgrounds', async ({ page }) => {
  await workspace(page, 'light', {deck: null});
  expect(await page.evaluate(() => termTheme().foreground)).toBe('#242426');
  expect(await page.evaluate(() => active.term.options.theme.background)).toBe('#ffffff');
  await page.evaluate(() => { localStorage.setItem('cc_terminal_style', 'glass'); window.dispatchEvent(new StorageEvent('storage', {key: 'cc_terminal_style', storageArea: localStorage})); });
  expect(await page.evaluate(() => active.term.options.theme.background)).toBe('#00000000');
  await page.evaluate(() => { localStorage.setItem('cc_terminal_style', 'graphite'); window.dispatchEvent(new StorageEvent('storage', {key: 'cc_terminal_style', storageArea: localStorage})); });
  expect(await page.evaluate(() => active.term.options.theme.background)).toBe('#ffffff');
});
