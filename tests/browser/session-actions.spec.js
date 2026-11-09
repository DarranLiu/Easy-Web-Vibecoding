const { test, expect } = require('@playwright/test');
const { workspace } = require('./workspace.fixture.cjs');
const menu = page => page.locator('[data-group="ws_demo"] [data-session="demo01"] .ws-session-actions').click();
const native = f => f.requests.filter(r => r.method !== 'GET' && /\/api\/(sessions|session-lookup|agents)\b/.test(r.path));

test('close control is visible without hover and closing a view never stops the task', async ({ page }) => {
  const f = await workspace(page);
  await page.mouse.move(0, 0);
  expect(await page.locator('.pane-x').evaluate(el => Number(getComputedStyle(el).opacity))).toBeGreaterThan(.5);
  await menu(page);
  await page.getByRole('button', { name: '关闭当前分屏（后台继续运行）', exact: true }).click();
  await expect.poll(() => page.evaluate(() => panes.length)).toBe(0);
  expect(native(f)).toEqual([]);
});

test('stopping a session requires an explicit confirmation and cancel sends nothing', async ({ page }) => {
  const f = await workspace(page);
  await menu(page);
  await page.getByRole('button', { name: '停止后台会话…', exact: true }).click();
  await expect(page.locator('.ui-dialog')).toContainText('终止服务器上的 tmux 会话');
  await page.locator('.ui-dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect(native(f)).toEqual([]);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
});

test('moving a session uses one atomic request and preserves live terminals and paths', async ({ page }) => {
  const f = await workspace(page);
  await page.evaluate(() => { window.oldPane = active; window.oldTerm = active.term; window.oldSocket = active.ws; });
  await menu(page);
  await page.locator('#ws-session-target').selectOption('ws_tools');
  await page.locator('.ws-session-move-form [type="submit"]').click();
  await expect(page.locator('#ws-session-actions-modal')).toHaveCount(0);
  await expect(page.locator('[data-group="ws_tools"] [data-session="demo01"]')).toBeVisible();
  await expect(page.locator('[data-group="ws_demo"] [data-session="demo01"]')).toHaveCount(0);
  expect(await page.evaluate(() => active === oldPane && active.term === oldTerm && active.ws === oldSocket && active.tab.cwd === '/workspace/demo')).toBe(true);
  expect(f.requests.filter(r => r.path.endsWith('/move-session'))).toHaveLength(1);
  expect(native(f)).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('a concurrent membership change does not remove either sidebar entry', async ({ page }) => {
  const f = await workspace(page, 'dark', {moveFailure:true});
  await menu(page); await page.locator('.ws-session-move-form [type="submit"]').click();
  await expect(page.locator('.ws-session-action-state')).toContainText('未执行移动');
  await expect(page.locator('[data-group="ws_demo"] [data-session="demo01"]')).toBeVisible();
  await expect(page.locator('[data-group="ws_tools"] [data-session="demo01"]')).toHaveCount(0);
  expect(native(f)).toEqual([]);
});

test('an unassigned stopped session can be grouped without starting it', async ({ page }) => {
  const f = await workspace(page, 'dark', {extraTabs:[{id:'stopped01',name:'Stopped sample',type:'codex',alive:false,cwd:'/workspace/stopped'}]});
  await page.locator('[data-workspace="_unassigned"]').click();
  await page.locator('[data-group="_unassigned"] .ws-stopped-toggle').click();
  await page.locator('[data-session="stopped01"] .ws-session-actions').click();
  await expect(page.getByRole('button',{name:'删除已停止的会话标签…',exact:true})).toBeVisible();
  await page.locator('#ws-session-target').selectOption('ws_tools');
  await page.locator('.ws-session-move-form [type="submit"]').click();
  await expect(page.locator('[data-group="ws_tools"] [data-session="stopped01"]')).toBeVisible();
  expect(native(f)).toEqual([]);
});

for (const width of [320, 1440]) test(`session controls fit ${width}px`, async ({ page }) => {
  await page.setViewportSize({width,height:850});
  const f = await workspace(page);
  if (width < 821) await page.evaluate(() => setDrawer(true));
  await menu(page);
  await page.waitForTimeout(250);
  const box = await page.locator('#ws-session-actions-modal .modal-box').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(await page.locator('#ws-session-actions-modal .modal-box').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({path:`/tmp/webcc-v127-session-${width}.png`});
  await page.keyboard.press('Escape');
  await expect(page.locator('#ws-session-actions-modal')).toHaveCount(0);
  expect(native(f)).toEqual([]);
});
