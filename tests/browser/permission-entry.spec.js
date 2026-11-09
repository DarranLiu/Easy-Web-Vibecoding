const { test, expect } = require('@playwright/test');
const { workspace } = require('./workspace.fixture.cjs');

for (const width of [320,390,1440]) test(`permissions remain accessible with collapsed tools at ${width}px`, async ({page}) => {
  await page.setViewportSize({width,height:900});
  const f = await workspace(page,'dark',{initial:{panes:['demo02'],active:'demo02'}});
  await page.evaluate(() => { window.savedPermissionTerm=active.term; window.savedPermissionSocket=active.ws; toggleTools(false); });
  await expect(page.locator('#term-header')).toBeHidden();
  await expect(page.locator('#btn-permissions')).toBeVisible();
  const bounds = await page.locator('#btn-permissions').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  await page.locator('#btn-permissions').click();
  await expect(page.locator('#permissions-modal')).toBeVisible();
  await expect(page.locator('#permission-approval')).toHaveValue('on-request');
  await page.locator('#permissions-close').click();
  await expect(page.locator('#permissions-modal')).toBeHidden();
  expect(await page.evaluate(() => active.term===savedPermissionTerm && active.ws===savedPermissionSocket)).toBe(true);
  expect(f.requests.filter(r=>r.method!=='GET' && /\/api\/(sessions|agents)\b/.test(r.path))).toEqual([]);
  expect(f.errors).toEqual([]);
  await page.screenshot({path:`/tmp/webcc-v128-toolbar-${width}.png`});
});

test('the permission control is unique across breakpoint changes and disabled for plain shells', async ({page}) => {
  await workspace(page);
  for (const width of [320,1440,390,1024]) {
    await page.setViewportSize({width,height:900});
    await expect(page.locator('#btn-permissions')).toHaveCount(1);
    await expect(page.locator('#btn-permissions')).toBeVisible();
    await expect(page.locator('#btn-permissions')).toBeDisabled();
  }
});
