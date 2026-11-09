const { test, expect } = require('@playwright/test');
const { workspace } = require('./workspace.fixture.cjs');

const ids = ['demo01', 'demo02', 'demo03', 'demo04'];

for (const theme of ['dark', 'light']) for (const width of [320, 390, 820, 1024, 1440]) {
  test(`design layout and controls ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await workspace(page, theme, { initial: { panes: width > 820 ? ids : ['demo02'], active: 'demo02' } });
    await page.evaluate(async () => {
      window.designRefs = panes.map(p => ({ p, term: p.term, ws: p.ws }));
      for (const p of panes) if (p.term) await new Promise(resolve => p.term.write(
        '\x1b[2J\x1b[H' + (p.tab.type === 'codex' ? 'OpenAI Codex' : p.tab.type === 'claude' ? 'Claude Code' : p.tab.name) +
        '\r\n\r\nProject: /workspace/demo\r\n\r\nReview the changes and run the checks.\r\n\r\n' +
        '\x1b[32m  PASS\x1b[0m  Layout restoration\r\n\x1b[32m  PASS\x1b[0m  Session continuity\r\n\x1b[32m  PASS\x1b[0m  Keyboard input\r\n\r\n' +
        'Ready for the next task.\r\n\r\n> ', resolve));
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily)).toContain('-apple-system');
    if (width <= 820) {
      const title = await page.locator('#recent-toggle').boundingBox();
      expect(title.width).toBeGreaterThan(160);
      const strip = await page.locator('#ws-screen-strip').boundingBox();
      expect(strip.width).toBeGreaterThan(width - 24);
      for (const id of ['btn-permissions', 'btn-files-m', 'btn-gpu-m', 'btn-versions-m', 'ws-mobile-deck', 'topbar-tools', 'ws-screen-add', 'ws-layout-save']) {
        const box = await page.locator('#' + id).boundingBox();
        expect(box.width, id).toBeGreaterThanOrEqual(44);
        expect(box.height, id).toBeGreaterThanOrEqual(44);
        expect(box.x, id).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, id).toBeLessThanOrEqual(width);
      }
    }
    await page.screenshot({ path: `/tmp/webcc-v132-design-${theme}-${width}.png` });
    if (width <= 820) await page.locator('#hamburger').click();
    const row = page.locator('.ws-session[data-session="demo02"]');
    await row.scrollIntoViewIfNeeded();
    const open = await row.locator('.ws-session-open').boundingBox();
    for (const selector of ['.ws-session-rename', '.ws-session-actions']) {
      const action = await row.locator(selector).boundingBox();
      expect(action.y).toBeGreaterThanOrEqual(open.y + open.height);
    }
    await row.locator('.ws-session-rename').press('Tab');
    await row.locator('.ws-session-rename').focus();
    expect(await row.locator('.ws-session-rename').evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
    await page.screenshot({ path: `/tmp/webcc-v132-sidebar-${theme}-${width}.png` });
    expect(await page.evaluate(() => designRefs.every(({ p, term, ws }) => p.term === term && p.ws === ws))).toBe(true);
    expect(await page.evaluate(() => sent.filter(v => ['input', 'paste'].includes(v.type)))).toEqual([]);
    expect(f.errors).toEqual([]);
  });
}

test('theme and breakpoint changes retain terminals, preferences and the optional glass surface', async ({ page }) => {
  const f = await workspace(page, 'light', { initial: { panes: ['demo01', 'demo02'], active: 'demo02' } });
  await page.evaluate(() => {
    window.font = active.term.options.fontFamily;
  });
  for (const width of [390, 1440, 820, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('#btn-permissions')).toHaveCount(1);
    await expect(page.locator('#btn-copy')).toHaveCount(1);
    await page.waitForFunction(() => ccWorkspace.ready && active?.ws?.readyState === 1);
    await page.evaluate(() => {
      window.refs = panes.map(p => ({ p, term: p.term, ws: p.ws }));
      window.size = active.term.options.fontSize;
    });
    await page.evaluate(() => toggleTheme());
    expect(await page.evaluate(() => refs.every(({ p, term, ws }) => p.term === term && p.ws === ws))).toBe(true);
    expect(await page.evaluate(() => active.term.options.fontFamily === font && active.term.options.fontSize === size)).toBe(true);
  }
  await page.evaluate(() => { localStorage.setItem('cc_terminal_style', 'glass'); window.dispatchEvent(new StorageEvent('storage', { key: 'cc_terminal_style', storageArea: localStorage })); });
  expect(await page.locator('html').getAttribute('data-terminal-style')).toBe('glass');
  expect(f.requests.filter(r => r.method !== 'GET' && /\/api\/(sessions|agents)\b/.test(r.path))).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('reduced motion and system high contrast retain visible controls', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await workspace(page);
  await page.locator('#btn-files').focus();
  expect(await page.locator('#btn-files').evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
  expect(await page.locator('#btn-files').evaluate(el => parseFloat(getComputedStyle(el).transitionDuration))).toBeLessThanOrEqual(.00001);
  await page.screenshot({ path: '/tmp/webcc-v132-high-contrast.png' });
});

test('short mobile viewport preserves a usable terminal and scrollable tools', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 400 });
  const f = await workspace(page, 'dark');
  await expect(page.locator('body')).toHaveClass(/ws-compact-height/);
  expect((await page.locator('.pane-host').boundingBox()).height).toBeGreaterThan(150);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#btn-files-m').scrollIntoViewIfNeeded();
  await page.locator('#btn-files-m').click();
  await expect(page.locator('#files-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#files-modal')).toBeHidden();
  await page.waitForTimeout(200);
  await page.screenshot({ path: '/tmp/webcc-v132-short-mobile.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('body')).not.toHaveClass(/ws-compact-height/);
  expect(f.errors).toEqual([]);
});
