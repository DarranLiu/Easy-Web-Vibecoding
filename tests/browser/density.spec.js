const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { workspace } = require('./workspace.fixture.cjs');

for (const theme of ['dark', 'light']) for (const width of [821, 900, 1440, 1920]) {
  test(`compact desktop density ${theme} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 960 });
    const f = await workspace(page, theme, { deck: null, initial: { panes: ['demo02', 'demo03'], active: 'demo02' } });
    const metrics = await page.evaluate(() => Object.fromEntries([
      'body', '#workspace-header', '#ws-screen-bar', '.workbench-search', '.ws-session',
      '.ws-session-name', '.ws-workspace', '.pane-bar', '#workspace-footer',
    ].map(selector => {
      const el = document.querySelector(selector), r = el.getBoundingClientRect(), style = getComputedStyle(el);
      return [selector, { height: r.height, font: style.fontSize, zoom: style.zoom, transform: style.transform }];
    })));
    fs.writeFileSync(info.outputPath(`metrics-${theme}-${width}.json`), JSON.stringify(metrics, null, 2));
    expect(metrics['#workspace-header'].height).toBe(40);
    expect(metrics['#ws-screen-bar'].height).toBe(width < 900 ? 68 : 36);
    expect(metrics['.workbench-search'].height).toBe(28);
    expect(metrics['.ws-session'].height).toBeLessThanOrEqual(50);
    expect(metrics['.ws-session-name'].font).toBe('11px');
    expect(metrics['.pane-bar'].height).toBe(28);
    expect(metrics.body.transform).toBe('none');
    expect(Number(metrics.body.zoom)).toBe(1);
    expect(await page.evaluate(() => active.term.options.fontSize)).toBe(12);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const row = page.locator('.ws-session[data-session="demo02"]');
    const open = await row.locator('.ws-session-open').boundingBox();
    for (const selector of ['.ws-session-rename', '.ws-session-actions', '.ws-session-split']) {
      const action = await row.locator(selector).boundingBox();
      expect(action.y).toBeGreaterThanOrEqual(open.y + open.height);
      expect(action.height).toBeGreaterThanOrEqual(24);
    }
    await page.evaluate(async () => {
      for (const p of panes) await new Promise(resolve => p.term.write('\x1b[2J\x1b[H' + p.tab.name + '\r\n\r\n/workspace/demo\r\n\r\nReview the changes and run the checks.\r\n\r\n\x1b[32mPASS\x1b[0m  Session continuity\r\n\x1b[32mPASS\x1b[0m  Layout restoration\r\n\r\nReady for the next task.\r\n\r\n> ', resolve));
    });
    await page.screenshot({ path: info.outputPath(`compact-${theme}-${width}.png`) });
    expect(f.errors).toEqual([]);
  });
}

test('compact UI does not overwrite an explicit terminal font or resize it on theme change', async ({ page }) => {
  await workspace(page, 'dark', { deck: null });
  await page.evaluate(() => setFont(15));
  await page.reload(); await page.waitForFunction(() => ccWorkspace.ready && active?.term);
  expect(await page.evaluate(() => active.term.options.fontSize)).toBe(15);
  await page.evaluate(() => { window.keptTerm = active.term; toggleTheme(); });
  expect(await page.evaluate(() => active.term === keptTerm && active.term.options.fontSize === 15)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('cc_fontsize'))).toBe('15');
});

test('mobile keeps touch targets and non-zooming form inputs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workspace(page);
  expect(await page.evaluate(() => active.term.options.fontSize)).toBe(11);
  for (const id of ['btn-permissions', 'btn-files-m', 'ws-screen-add']) {
    const box = await page.locator('#' + id).boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.locator('#hamburger').click();
  expect(await page.locator('.ws-tree-search input').evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
});

test.describe('high pixel density', () => {
  test.use({ deviceScaleFactor: 2 });
  test('retains CSS dimensions and a correctly fitted terminal', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await workspace(page, 'dark', { deck: null });
    expect((await page.locator('#workspace-header').boundingBox()).height).toBe(40);
    expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
    const host = await page.locator('.pane-host').boundingBox();
    const screen = await page.locator('.xterm-screen').boundingBox();
    expect(screen.x + screen.width).toBeLessThanOrEqual(host.x + host.width);
    expect(screen.y + screen.height).toBeLessThanOrEqual(host.y + host.height);
    expect(await page.evaluate(() => active.term.cols)).toBeGreaterThan(60);
  });
});
