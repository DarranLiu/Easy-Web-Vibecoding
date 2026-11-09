const { test, expect } = require('@playwright/test');
const { workspace } = require('./workspace.fixture.cjs');

test('desktop exposes primary tools while secondary toolbar is collapsed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await workspace(page);
  for (const id of ['btn-copy', 'btn-copy-session-id', 'btn-img', 'btn-reference', 'btn-files', 'btn-gpu', 'header-split', 'header-new']) {
    await expect(page.locator('#' + id)).toBeVisible();
  }
  await page.evaluate(() => { window.beforeToolbar = { term: active.term, socket: active.ws }; });
  await page.locator('#btn-tools').click();
  await expect(page.locator('#term-header')).toBeHidden();
  for (const id of ['btn-copy', 'btn-copy-session-id', 'btn-img', 'btn-reference', 'btn-files', 'btn-gpu', 'header-split']) await expect(page.locator('#' + id)).toBeVisible();
  await page.locator('#btn-reference').click();
  await expect(page.locator('#reference-modal')).toBeVisible();
  await page.locator('#reference-close').click();
  await expect(page.locator('#reference-modal')).toBeHidden();
  expect(await page.evaluate(() => active.term === beforeToolbar.term && active.ws === beforeToolbar.socket)).toBe(true);
  expect(fixture.errors).toEqual([]);
  await page.screenshot({ path: '/tmp/webcc-v122-toolbar-desktop.png' });
});

for (const width of [320, 390, 820]) test(`mobile toolbar keeps actions usable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const fixture = await workspace(page);
  for (const id of ['btn-files-m', 'btn-gpu-m', 'btn-versions-m']) await expect(page.locator('#' + id)).toBeVisible();
  await expect(page.locator('#term-header #btn-reference')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#btn-gpu-m').click();
  await expect(page.locator('#gpu-modal')).toBeVisible();
  await page.locator('#gpu-close').click();
  await expect(page.locator('#gpu-modal')).toBeHidden();
  expect(fixture.errors).toEqual([]);
  await page.screenshot({ path: `/tmp/webcc-v122-toolbar-mobile-${width}.png` });
});

test('narrow desktop with the task deck open keeps toolbar scrollable without overlapping the page', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await workspace(page);
  await page.evaluate(() => localStorage.setItem('cc_workspace_deck', '1'));
  await page.reload();
  await page.waitForFunction(() => ccWorkspace.ready && active?.ws?.readyState === 1);
  const bounds = await page.evaluate(() => {
    const header = document.getElementById('workspace-header');
    return { page: document.documentElement.scrollWidth <= innerWidth, scroll: header.scrollWidth >= header.clientWidth };
  });
  expect(bounds.page).toBe(true);
  await page.locator('#btn-gpu').scrollIntoViewIfNeeded();
  await page.locator('#btn-gpu').click();
  await expect(page.locator('#gpu-modal')).toBeVisible();
});
