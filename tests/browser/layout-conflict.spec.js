const { test, expect } = require('@playwright/test');
const { workspace } = require('./workspace.fixture.cjs');
const path = '/api/layouts/desktop_merge';
const screen = (id, panes = []) => ({ id, name: id, panes, active: panes[0] || null, direction: 'auto', ratios: { cols: [1, 1], rows: [1, 1, 1, 1] }, maximized: null });
function layout() {
  const screens = [screen('first', ['demo01']), screen('second', ['demo02'])];
  return { ...screens[0], screens, activeScreen: 'first', revision: 3, screenSchema: 1 };
}
async function setup(page, extra = {}) {
  return workspace(page, 'dark', { identity: 'merge', layouts: { [path]: layout() }, ...extra });
}
const add = page => page.getByRole('button', { name: '新建屏幕', exact: true }).click();
function noNative(f) {
  expect(f.errors).toEqual([]);
  expect(f.requests.filter(r => r.method !== 'GET' && /\/api\/(sessions|session-lookup|agents)\b/.test(r.path))).toEqual([]);
}

test('concurrent new screens merge without overwriting either browser', async ({ page }) => {
  const f = await setup(page);
  f.layouts[path].screens.push(screen('remote'));
  f.layouts[path].revision++;
  await add(page);
  await expect(page.locator('#ws-screen-tabs > button')).toHaveCount(4);
  await expect(page.locator('#ws-save-indicator')).not.toHaveClass(/error/);
  expect(f.layouts[path].screens.map(s => s.id)).toContain('remote');
  expect(f.layouts[path].screens).toHaveLength(4);
  await expect(page.locator('#ws-conflict-modal')).toHaveCount(0);
  await page.reload(); await page.waitForFunction(() => ccWorkspace.canResume);
  await expect(page.locator('#ws-screen-tabs > button')).toHaveCount(4);
  noNative(f);
});

test('legacy conflict offers a choice; cancel keeps local and remote intact', async ({ page }) => {
  const local = layout(); local.screens[0].name = 'local title';
  const f = await setup(page, { journal: { device: 'desktop_merge', value: { layout: local, pending: true, baseRevision: 1 } } });
  await add(page);
  await expect(page.locator('#ws-conflict-modal')).toBeVisible();
  await page.locator('#ws-conflict-modal').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('#ws-conflict-modal')).toHaveCount(0);
  expect(f.layouts[path].screens[0].name).toBe('first');
  await expect(page.locator('[data-screen="first"]')).toContainText('local title');
  noNative(f);
});

test('adopting server backs up local and then completes the requested creation', async ({ page }) => {
  const local = layout(); local.screens[0].name = 'local title';
  const f = await setup(page, { journal: { device: 'desktop_merge', value: { layout: local, pending: true, baseRevision: 1 } } });
  await add(page);
  await page.getByRole('button', { name: '采用服务器布局', exact: true }).click();
  await expect(page.locator('#ws-screen-tabs > button')).toHaveCount(3);
  expect(f.layouts[path].screens[0].name).toBe('first');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cc_screens_conflict_desktop_merge')).layout.screens[0].name)).toBe('local title');
  noNative(f);
});

test('fork creates an independent server layout and explicitly switches the Token binding', async ({ page }) => {
  const local = layout(); local.screens[0].name = 'local title';
  const bindings = { 'test-token:desktop': { enabled: true, device: 'desktop_merge', revision: 1 } };
  const f = await setup(page, { tokenBindings: bindings, journal: { device: 'desktop_merge', value: { layout: local, pending: true, baseRevision: 1 } } });
  await add(page);
  await page.getByRole('button', { name: '另存并切换', exact: true }).click();
  await expect.poll(() => bindings['test-token:desktop'].device).toMatch(/^desktop_copy_/);
  await expect.poll(() => page.evaluate(() => ccWorkspace.canResume)).toBe(true);
  expect(f.layouts[path].screens[0].name).toBe('first');
  expect(f.layouts['/api/layouts/' + bindings['test-token:desktop'].device].screens[0].name).toBe('local title');
  await add(page);
  await expect(page.locator('#ws-screen-tabs > button')).toHaveCount(3);
  noNative(f);
});

test('an intervening write during merge is not retried or overwritten', async ({ page }) => {
  const f = await setup(page);
  f.layouts[path].screens.push(screen('remote')); f.layouts[path].revision++;
  let writes = 0;
  await page.route('**/api/layouts/desktop_merge', route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    writes++;
    return route.fulfill({ status: 409, json: { detail: 'Concurrent write' } });
  });
  await add(page);
  await expect(page.locator('#ws-save-indicator')).toContainText('可重试');
  expect(writes).toBe(2);
  expect(f.layouts[path].screens).toHaveLength(3);
  noNative(f);
});

for (const width of [320, 1440]) {
  test(`same-screen edits require a choice and the dialog fits ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    const base = layout(), local = layout(), remote = layout();
    local.screens[0].name = 'Local change'; remote.screens[0].name = 'Remote change'; remote.revision = 4;
    const device = width < 900 ? 'mobile_merge' : 'desktop_merge';
    const f = await workspace(page, 'dark', { identity: 'merge', layouts: { ['/api/layouts/' + device]: remote },
      journal: { device, value: { layout: local, base, pending: true, baseRevision: 3 } } });
    await add(page);
    await expect(page.locator('#ws-conflict-modal')).toBeVisible();
    await page.waitForTimeout(250);
    const box = await page.locator('#ws-conflict-modal .modal-box').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await page.locator('#ws-conflict-modal .modal-box').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/webcc-v125-conflict-${width}.png` });
    await page.keyboard.press('Escape');
    await expect(page.locator('#ws-conflict-modal')).toHaveCount(0);
    noNative(f);
  });
}

test('known baseline survives restart and allows independent changes to merge', async ({ page }) => {
  const base = layout(), local = layout(), remote = layout();
  local.screens[1].name = 'Local second'; remote.screens[0].name = 'Remote first'; remote.revision = 4;
  const f = await setup(page, { layouts: { [path]: remote }, journal: { device: 'desktop_merge', value: { layout: local, base, pending: true, baseRevision: 3 } } });
  await add(page);
  await expect(page.locator('#ws-screen-tabs > button')).toHaveCount(3);
  expect(f.layouts[path].screens.slice(0, 2).map(s => s.name)).toEqual(['Remote first', 'Local second']);
  noNative(f);
});

test('network failure while resolving preserves the journal and never adopts a layout', async ({ page }) => {
  const local = layout(); local.screens[0].name = 'local title';
  const f = await setup(page, { journal: { device: 'desktop_merge', value: { layout: local, pending: true, baseRevision: 1 } } });
  await page.route('**/api/layouts/desktop_merge', route => route.fulfill({ status: 503, json: { detail: 'Offline' } }));
  await add(page);
  await expect(page.locator('#ws-save-indicator')).toContainText('可重试');
  await expect(page.locator('[data-screen="first"]')).toContainText('local title');
  expect(f.layouts[path].revision).toBe(3);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cc_screens_recovery_desktop_merge')).pending)).toBe(true);
  noNative(f);
});

test('a fork cannot steal a Token binding changed by another browser', async ({ page }) => {
  const local = layout(); local.screens[0].name = 'local title';
  const bindings = { 'test-token:desktop': { enabled: true, device: 'desktop_merge', revision: 1 } };
  const f = await setup(page, { tokenBindings: bindings, journal: { device: 'desktop_merge', value: { layout: local, pending: true, baseRevision: 1 } } });
  await add(page);
  bindings['test-token:desktop'] = { enabled: true, device: 'desktop_elsewhere', revision: 2 };
  await page.getByRole('button', { name: '另存并切换', exact: true }).click();
  await expect(page.locator('#ws-save-indicator')).toContainText('可重试');
  expect(bindings['test-token:desktop'].device).toBe('desktop_elsewhere');
  expect(f.layouts[path].screens[0].name).toBe('first');
  const copy = Object.keys(f.layouts).find(key => key.includes('desktop_copy_'));
  expect(f.layouts[copy].screens[0].name).toBe('local title');
  await expect(page.locator('[data-screen="first"]')).toContainText('local title');
  noNative(f);
});

test('merging beyond the screen limit requires an explicit choice', async ({ page }) => {
  const f = await setup(page);
  for (let i = 0; i < 14; i++) f.layouts[path].screens.push(screen('remote' + i));
  f.layouts[path].revision++;
  await add(page);
  await expect(page.locator('#ws-conflict-modal')).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(f.layouts[path].screens).toHaveLength(16);
  await expect(page.locator('#ws-screen-tabs > button')).toHaveCount(3);
  noNative(f);
});

test('explicit save preserves every visible pane and clears a legacy conflict across reload', async ({ page }) => {
  const local = layout(); local.screens[0].name = 'My exact layout';
  local.screens[0].panes = ['demo01', 'demo03']; local.screens[0].direction = 'row';
  const bindings = { 'test-token:desktop': { enabled: true, device: 'desktop_merge', revision: 1 } };
  const f = await setup(page, { tokenBindings: bindings, journal: { device: 'desktop_merge', value: { layout: local, pending: true, baseRevision: 1 } } });
  await page.evaluate(() => { window.originalSavePanes = panes.map(p => ({ pane: p, term: p.term, ws: p.ws })); });
  await page.locator('#ws-layout-save').click();
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await expect(page.locator('#ws-save-indicator')).toHaveText('已同步');
  expect(await page.evaluate(() => originalSavePanes.every((p, i) => panes[i] === p.pane && panes[i].term === p.term && panes[i].ws === p.ws))).toBe(true);
  expect(f.layouts[path].screens[0].name).toBe('first');
  const copyPath = '/api/layouts/' + bindings['test-token:desktop'].device;
  expect(f.layouts[copyPath].screens[0].name).toBe('My exact layout');
  expect(f.layouts[copyPath].screens[0].panes).toEqual(['demo01', 'demo03']);
  await page.reload(); await page.waitForFunction(() => ccWorkspace.canResume);
  await expect(page.locator('[data-screen="first"]')).toContainText('My exact layout');
  await expect(page.locator('#ws-save-indicator')).not.toHaveClass(/error/);
  noNative(f);
});

test('canceling explicit save performs no writes and keeps the current layout', async ({ page }) => {
  const f = await setup(page), before = f.requests.length;
  await page.locator('#ws-layout-save').click();
  await page.locator('.ui-dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect(f.requests.slice(before).filter(r => r.method === 'PUT')).toEqual([]);
  await expect(page.locator('[data-screen="first"]')).toHaveAttribute('aria-selected', 'true');
  noNative(f);
});

test('failed explicit save never changes the current layout or binding', async ({ page }) => {
  const f = await setup(page);
  await page.route('**/api/layouts/desktop_copy_*', route => route.fulfill({ status: 503, json: { detail: 'Copy failed' } }));
  await page.locator('#ws-layout-save').click();
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await expect(page.locator('#ws-save-indicator')).toContainText('可重试');
  expect(await page.evaluate(() => localStorage.getItem('cc_workspace_device'))).toBe('merge');
  await expect(page.locator('[data-screen="first"]')).toHaveAttribute('aria-selected', 'true');
  noNative(f);
});
