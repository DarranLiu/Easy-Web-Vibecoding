const { test, expect } = require('@playwright/test');
const { workspace } = require('./workspace.fixture.cjs');

const recoveryId = '11111111-2222-4333-8444-555555555555';

function demoScreens(revision = 3) {
  return { revision, screenSchema: 1, activeScreen: 'screen2', panes: ['demo03'], active: 'demo03', direction: 'auto', ratios: {}, screens: [
    { id: 'screen1', name: 'Screen 1', panes: ['demo01', 'demo02', 'demo04'], active: 'demo02', direction: 'row', ratios: { cols: [1, 2], rows: [1, 1, 1, 1] }, maximized: 1 },
    { id: 'screen2', name: 'Screen 2', panes: ['demo03'], active: 'demo03', direction: 'auto', ratios: {}, maximized: null },
  ] };
}

async function bindProfile(page, user) {
  await page.locator('#ws-layout-user').click();
  await page.locator('#ws-user-input').fill(user);
  await page.locator('#ws-user-bind').click();
  await expect(page.locator('#ws-user-modal')).toBeHidden();
}

function moveScreens() {
  const value = demoScreens();
  value.activeScreen = 'screen1'; value.screens[0].maximized = null;
  return value;
}

for (const kind of ['device', 'user']) {
  test(`restore ${kind} binding survives a fresh browser through its recovery address`, async ({ page, browser }) => {
    const key = kind === 'user' ? 'desktop_user_demo' : 'desktop_restartdemo';
    const url = 'http://workspace.test/?' + (kind === 'user' ? 'layoutUser=demo' : 'layoutDevice=restartdemo');
    const fixture = await workspace(page, 'dark', { url, layouts: { ['/api/layouts/' + key]: demoScreens() } });
    await page.locator('#ws-screen-tabs [data-screen="screen1"]').click();
    await page.evaluate(() => ccWorkspace.persist());
    const context = await browser.newContext();
    try {
      const other = await context.newPage();
      const second = await workspace(other, 'light', { url: page.url(), layouts: fixture.layouts });
      expect(await other.evaluate(() => ({ count: panes.length, active: active.tab.id, max: maximizedPane?.tab.id }))).toEqual({ count: 3, active: 'demo02', max: 'demo02' });
      await expect(other.locator('#ws-screen-tabs [role="tab"]')).toHaveCount(2);
      expectNoNativeChanges(second);
    } finally { await context.close(); }
    expectNoNativeChanges(fixture);
  });

  test(`restore ${kind} binding falls back to a persistent cookie when local storage is cleared`, async ({ page, browser }) => {
    const key = kind === 'user' ? 'desktop_user_demo' : 'desktop_restartdemo';
    const url = 'http://workspace.test/?' + (kind === 'user' ? 'layoutUser=demo' : 'layoutDevice=restartdemo');
    const fixture = await workspace(page, 'dark', { url, layouts: { ['/api/layouts/' + key]: demoScreens() } });
    const storage = await page.context().storageState();
    const context = await browser.newContext({ storageState: { cookies: storage.cookies, origins: [] } });
    try {
      const other = await context.newPage();
      const second = await workspace(other, 'light', { layouts: fixture.layouts });
      expect(await other.evaluate(() => active.tab.id)).toBe('demo03');
      await expect(other.locator('#ws-screen-tabs [role="tab"]')).toHaveCount(2);
      expect(new URL(other.url()).searchParams.get(kind === 'user' ? 'layoutUser' : 'layoutDevice')).toBe(kind === 'user' ? 'demo' : 'restartdemo');
      expectNoNativeChanges(second);
    } finally { await context.close(); }
    expectNoNativeChanges(fixture);
  });
}

test('restore a clean local screen set when the server record is missing instead of migrating only one pane', async ({ page }) => {
  const value = demoScreens(7);
  const fixture = await workspace(page, 'dark', { identity: 'cleanrestore', journal: { device: 'desktop_cleanrestore', value: { baseRevision: 7, pending: false, layout: value } } });
  await expect(page.locator('#ws-screen-tabs [role="tab"]')).toHaveCount(2);
  await expect.poll(() => fixture.layouts['/api/layouts/desktop_cleanrestore']?.screens.length).toBe(2);
  expect(fixture.layouts['/api/layouts/desktop_cleanrestore'].activeScreen).toBe('screen2');
  expect(fixture.layouts['/api/layouts/desktop_cleanrestore'].screens[0].panes).toEqual(['demo01', 'demo02', 'demo04']);
  expectNoNativeChanges(fixture);
});

test('restore cached screens while offline then automatically read the newer server layout without overwriting it', async ({ page }) => {
  const server = moveScreens(), cached = demoScreens(2);
  const options = { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': server }, journal: { device: 'desktop_user_demo', value: { baseRevision: 2, pending: false, layout: cached } }, layoutReadFailure: 503 };
  const fixture = await workspace(page, 'dark', options);
  await expect(page.locator('#ws-save-indicator')).toContainText('网络恢复后自动同步');
  expect(await page.evaluate(() => active.tab.id)).toBe('demo03');
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
  expect(await page.evaluate(() => JSON.parse(localStorage.cc_screens_recovery_desktop_user_demo).pending)).toBe(false);
  options.layoutReadFailure = 0;
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await expect.poll(() => page.evaluate(() => panes.length)).toBe(3);
  await expect(page.locator('#ws-save-indicator')).toContainText('已保存');
  expect(fixture.requests.filter(r => r.method === 'PUT')).toEqual([]);
  expectNoNativeChanges(fixture);
});

test('restore pending cached screens after network recovery using the verified base revision', async ({ page }) => {
  const cached = moveScreens();
  const options = { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': demoScreens() }, journal: { device: 'desktop_user_demo', value: { baseRevision: 3, pending: true, layout: cached } }, layoutReadFailure: 503 };
  const fixture = await workspace(page, 'dark', options);
  await expect(page.locator('#ws-save-indicator')).toContainText('网络恢复后自动同步');
  options.layoutReadFailure = 0;
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await expect.poll(() => fixture.layouts['/api/layouts/desktop_user_demo'].revision).toBe(4);
  expect(fixture.layouts['/api/layouts/desktop_user_demo'].activeScreen).toBe('screen1');
  expectNoNativeChanges(fixture);
});

for (const offline of [false, true]) {
  test(`restore conflicts keep the original base revision across client restarts (offline=${offline})`, async ({ page, browser }) => {
    const options = { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': demoScreens(4) },
      journal: { device: 'desktop_user_demo', value: { baseRevision: 3, pending: true, layout: moveScreens() } }, layoutReadFailure: offline ? 503 : 0 };
    const fixture = await workspace(page, 'dark', options);
    if (offline) {
      await expect(page.locator('#ws-save-indicator')).toContainText('网络恢复后自动同步');
      options.layoutReadFailure = 0;
      await page.evaluate(() => dispatchEvent(new Event('online')));
    }
    await expect(page.locator('#ws-save-indicator')).toContainText('冲突');
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
    const cached = await page.evaluate(() => JSON.parse(localStorage.cc_screens_recovery_desktop_user_demo));
    expect(cached.baseRevision).toBe(3);
    expect(cached.pending).toBe(true);
    const context = await browser.newContext();
    try {
      const other = await context.newPage();
      const second = await workspace(other, 'dark', { profile: 'demo', layouts: fixture.layouts, journal: { device: 'desktop_user_demo', value: cached } });
      await expect(other.locator('#ws-save-indicator')).toContainText('冲突');
      expect(second.requests.filter(r => r.method === 'PUT')).toEqual([]);
      expect(second.layouts['/api/layouts/desktop_user_demo'].revision).toBe(4);
      expectNoNativeChanges(second);
    } finally { await context.close(); }
    expect(fixture.requests.filter(r => r.method === 'PUT')).toEqual([]);
    expectNoNativeChanges(fixture);
  });
}

test('restore screens does not depend on workspace metadata being available', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': moveScreens() }, workspacesFailure: true });
  await expect(page.locator('.pane')).toHaveCount(3);
  await expect(page.locator('#ws-screen-tabs [role="tab"]')).toHaveCount(2);
  expectNoNativeChanges(fixture);
});

test('restore committed saves after a lost response by reading first rather than repeating the write', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': demoScreens() } });
  await page.evaluate(() => ccWorkspace.persist());
  let writes = 0;
  await page.route('**/api/layouts/desktop_user_demo', async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    writes++;
    const body = route.request().postDataJSON();
    fixture.layouts['/api/layouts/desktop_user_demo'] = { ...body, revision: body.revision + 1 };
    return route.abort();
  });
  await page.locator('#ws-screen-add').click();
  await expect(page.locator('#ws-screen-tabs [role="tab"]')).toHaveCount(3);
  await page.evaluate(() => dispatchEvent(new Event('online')));
  // A successful read-back may reconcile before an intermediate failure paints.
  await expect(page.locator('#ws-save-indicator')).toHaveText(/已保存|已同步/);
  expect(writes).toBe(1);
  await expect(page.locator('#ws-screen-tabs [role="tab"]')).toHaveCount(3);
  expectNoNativeChanges(fixture);
});

test('restore catalog requires explicit selection and reads the old profile without overwriting it', async ({ page }) => {
  const layouts = { '/api/layouts/desktop_olddevice': moveScreens(), '/api/layouts/mobile_other': demoScreens() };
  const fixture = await workspace(page, 'dark', { layouts });
  expect(fixture.requests.filter(r => r.path === '/api/layouts')).toEqual([]);
  await page.locator('#ws-layout-user').click(); await page.locator('#ws-layout-history').click();
  await expect(page.locator('#ws-layout-catalog [data-layout="desktop_olddevice"]')).toBeVisible();
  await expect(page.locator('#ws-layout-catalog [data-layout="mobile_other"]')).toHaveCount(0);
  expect(await page.evaluate(() => panes.length)).toBe(1);
  await page.locator('#ws-layout-catalog [data-layout="desktop_olddevice"]').click();
  await expect(page.locator('#ws-user-modal')).toBeHidden();
  expect(await page.evaluate(() => panes.length)).toBe(3);
  expect(new URL(page.url()).searchParams.get('layoutDevice')).toBe('olddevice');
  expect(fixture.requests.filter(r => r.path === '/api/layouts/desktop_olddevice' && r.method === 'PUT')).toEqual([]);
  expectNoNativeChanges(fixture);
});

test('restore link contains the chosen profile but no URL credentials or unrelated query values', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { url: 'http://workspace.test/?layoutUser=demo&token=private-test-only#secret', layouts: { '/api/layouts/desktop_user_demo': demoScreens() } });
  await page.evaluate(() => { copyText = async value => { window.copiedLayoutLink = value; return true; }; });
  await page.locator('#ws-layout-user').click(); await page.locator('#ws-layout-link').click();
  const link = await page.evaluate(() => copiedLayoutLink);
  expect(link).toBe('http://workspace.test/?ui=bridge&layoutUser=demo');
  expectNoNativeChanges(fixture);
});

for (const width of [390, 1440]) {
  test(`split opened markers distinguish current other and unopened sessions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': moveScreens() }, extraTabs: [{ id: 'extra', name: 'Unopened', type: 'shell', alive: true }] });
    await page.evaluate(() => ccWorkspace.openSplitPicker());
    const row = id => page.locator('.ws-split-row').filter({ has: page.locator(`input[data-session="${id}"]`) });
    await expect(row('demo02')).toHaveAttribute('data-open-state', 'current');
    await expect(row('demo02')).toContainText('当前屏幕已打开');
    await expect(row('demo03')).toHaveAttribute('data-open-state', 'other');
    await expect(row('demo03')).toContainText('Screen 2');
    await expect(row('extra')).toHaveAttribute('data-open-state', 'closed');
    await row('demo02').locator('input').uncheck();
    await expect(row('demo02')).toContainText('当前屏幕已打开');
    await row('demo03').locator('input').check();
    await expect(row('demo03')).toContainText('其他屏幕已打开');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/webcc-v108-split-status-${width}.png` });
    await page.keyboard.press('Escape');
    expectNoNativeChanges(fixture);
  });
}

async function openMove(page, sid) {
  await page.evaluate(id => {
    const pane = panes.find(p => (p.tab?.id || p.savedId) === id);
    if (!pane) throw new Error('Pane missing');
    pane.el.dataset.testMove = id;
  }, sid);
  await page.locator(`.pane[data-test-move="${sid}"] .ws-pane-move`).click();
  await expect(page.locator('#ws-move-modal')).toBeVisible();
  await expect(page.locator('#ws-move-modal')).not.toHaveClass(/is-opening/);
}

function expectNoNativeChanges(fixture) {
  expect(fixture.requests.filter(request => request.path.startsWith('/api/sessions') && request.method !== 'GET')).toEqual([]);
  expect(fixture.errors).toEqual([]);
}

for (const width of [390, 1440]) for (const entry of ['picker', 'sidebar', 'direct']) {
  test(`exclusive screens transfer a session through ${entry} at ${width}px and retain ownership after reopening`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const key = '/api/layouts/' + (width < 820 ? 'mobile' : 'desktop') + '_user_demo';
    const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { [key]: moveScreens() } });
    if (entry === 'picker') {
      if (width < 820) {
        await page.evaluate(() => ccWorkspace.openSplitPicker());
        await page.locator('#ws-split-list input:checked').uncheck();
        await page.locator('#ws-split-list input[data-session="demo03"]').check();
        await page.locator('#ws-split-apply').click();
        await expect(page.locator('#ws-split-modal')).toBeHidden();
      } else await chooseSplits(page, ['demo01', 'demo02', 'demo04', 'demo03']);
    } else if (entry === 'sidebar') {
      if (width < 820) await page.locator('#hamburger').click();
      await page.locator('[data-workspace="ws_tools"]').click();
      await (width < 820 ? treeOpen(page, 'demo03') : treeSplit(page, 'demo03')).click();
    } else {
      await page.evaluate(() => openTab(state.tabs.find(tab => tab.id === 'demo03')));
    }
    await page.evaluate(() => ccWorkspace.persist());
    const saved = fixture.layouts[key];
    expect(saved.screens[0].panes).toContain('demo03');
    expect(saved.screens[1]).toMatchObject({ panes: [], active: null, maximized: null });
    const ids = saved.screens.flatMap(screen => screen.panes).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    await page.reload(); await page.waitForFunction(() => ccWorkspace.ready && active?.ws?.readyState === 1);
    await page.locator('#ws-screen-tabs [data-screen="screen2"]').click();
    await expect(page.locator('.pane')).toHaveCount(0);
    expectNoNativeChanges(fixture);
  });
}

test('exclusive screens cancelled picker leaves the source untouched and shows an explicit move action', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': moveScreens() } });
  const before = JSON.stringify(fixture.layouts);
  await page.locator('#header-split').click();
  await page.locator('#ws-split-list input[data-session="demo03"]').check();
  await expect(page.locator('#ws-split-apply')).toHaveText('移入并分屏');
  await expect(page.locator('#ws-split-state')).toContainText('移入 1 个');
  await page.screenshot({ path: '/tmp/webcc-v109-move-selection.png' });
  await page.keyboard.press('Escape');
  expect(JSON.stringify(fixture.layouts)).toBe(before);
  expectNoNativeChanges(fixture);
});

test('exclusive screens keep a single local owner after failed saves and sync it on reconnect', async ({ page }) => {
  const key = '/api/layouts/desktop_user_demo';
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { [key]: moveScreens() } });
  let offline = true;
  await page.route('**/api/layouts/*', route => route.request().method() === 'PUT' && offline ? route.abort() : route.fallback());
  await page.locator('#header-split').click();
  await page.locator('#ws-split-list input[data-session="demo03"]').check();
  await page.locator('#ws-split-apply').click();
  await expect(page.locator('#ws-save-indicator')).toContainText('布局未保存');
  const cached = await page.evaluate(() => JSON.parse(localStorage.cc_screens_recovery_desktop_user_demo));
  expect(cached.layout.screens[1].panes).toEqual([]);
  expect(cached.layout.screens[0].panes).toContain('demo03');
  expect(fixture.layouts[key].screens[1].panes).toEqual(['demo03']);
  await page.keyboard.press('Escape'); offline = false;
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await expect(page.locator('#ws-save-indicator')).toHaveText('已保存');
  expect(fixture.layouts[key].screens[1].panes).toEqual([]);
  expectNoNativeChanges(fixture);
});

test('exclusive screens clean hidden duplicates and preserve offline identities, empty slots and maximized index', async ({ page }) => {
  const value = demoScreens();
  value.screens[0] = { ...value.screens[0], panes: ['demo03', null, 'demo02', 'demo04'], active: 'demo02', maximized: 2 };
  value.screens[1].panes = ['demo03', 'stopped', 'missing'];
  value.screens.push({ id: 'screen3', name: 'Third', panes: ['demo02', 'stopped', 'missing', 'demo01'], active: 'demo02', maximized: 0 });
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': value }, extraTabs: [{ id: 'stopped', name: 'Stopped', type: 'claude', alive: false }] });
  await page.locator('#ws-screen-tabs [data-screen="screen1"]').click();
  const saved = fixture.layouts['/api/layouts/desktop_user_demo'];
  expect(saved.screens[0]).toMatchObject({ panes: [null, 'demo02', 'demo04'], active: 'demo02', maximized: 1, ratios: {} });
  expect(saved.screens[1].panes).toEqual(['demo03', 'stopped', 'missing']);
  expect(saved.screens[2]).toMatchObject({ panes: ['demo01'], active: 'demo01', maximized: null });
  expectNoNativeChanges(fixture);
});

test('screens move picker transfers a live pane atomically and preserves its socket and history', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': moveScreens() } });
  await page.evaluate(() => {
    window.movingPane = panes.find(p => p.tab.id === 'demo02'); window.movingSocket = movingPane.ws;
    movingPane.term.write('PRESERVED MOVE HISTORY\r\n');
  });
  await openMove(page, 'demo02');
  await page.locator('#ws-move-list [data-move-screen="screen2"]').click();
  await expect(page.locator('#ws-move-modal')).toBeHidden();
  expect(await page.evaluate(() => ({ ids: panes.map(p => p.tab.id), active: active.tab.id, samePane: active === movingPane, sameSocket: active.ws === movingSocket })))
    .toEqual({ ids: ['demo03', 'demo02'], active: 'demo02', samePane: true, sameSocket: true });
  expect(await page.evaluate(() => Array.from({ length: active.term.buffer.active.length }, (_, i) => active.term.buffer.active.getLine(i).translateToString()).join('\n'))).toContain('PRESERVED MOVE HISTORY');
  const saved = fixture.layouts['/api/layouts/desktop_user_demo'];
  expect(saved.screens.map(s => s.panes)).toEqual([['demo01', 'demo04'], ['demo03', 'demo02']]);
  expect(saved.activeScreen).toBe('screen2');
  await page.reload(); await page.waitForFunction(() => ccWorkspace.ready && active?.ws?.readyState === 1);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo02');
  expectNoNativeChanges(fixture);
  expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
});

for (const destination of ['screen2', 'new']) {
  test(`screens drag a title bar to ${destination} without restarting the terminal`, async ({ page }) => {
    const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': moveScreens() } });
    await page.evaluate(() => { window.movingPane = panes[0]; window.movingSocket = panes[0].ws; });
    await page.locator('.pane-bar').first().dragTo(page.locator(destination === 'new' ? '#ws-screen-add' : '#ws-screen-tabs [data-screen="screen2"]'));
    await expect.poll(() => fixture.layouts['/api/layouts/desktop_user_demo'].activeScreen).not.toBe('screen1');
    expect(await page.evaluate(() => active === movingPane && active.ws === movingSocket)).toBe(true);
    expect(fixture.layouts['/api/layouts/desktop_user_demo'].screens[0].panes).toEqual(['demo02', 'demo04']);
    expect(fixture.layouts['/api/layouts/desktop_user_demo'].screens).toHaveLength(destination === 'new' ? 3 : 2);
    expectNoNativeChanges(fixture);
    expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
  });
}

test('screens move refuses full targets both in the picker and at drop time', async ({ page }) => {
  const value = moveScreens(); value.screens[1].panes = ['extra1', 'demo03', 'extra2', 'extra3'];
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': value }, extraTabs: [1, 2, 3].map(n => ({ id: 'extra' + n, name: 'Extra ' + n, type: 'shell', alive: true })) });
  await page.evaluate(() => ccWorkspace.persist());
  const before = JSON.stringify(fixture.layouts);
  await openMove(page, 'demo02');
  await expect(page.locator('#ws-move-list [data-move-screen="screen2"]')).toBeDisabled();
  await expect(page.locator('#ws-move-list')).toContainText('目标屏幕已满');
  await page.keyboard.press('Escape'); await expect(page.locator('#ws-move-modal')).toBeHidden();
  await page.evaluate(() => {
    const pane = panes.find(p => p.tab.id === 'demo02'), dataTransfer = new DataTransfer();
    pane.el.querySelector('.pane-bar').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
    document.querySelector('[data-screen="screen2"]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
  await expect(page.locator('#toast')).toContainText('目标屏幕已满');
  expect(JSON.stringify(fixture.layouts)).toBe(before);
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo02', 'demo04']);
  expectNoNativeChanges(fixture);
});

for (const duplicate of [false, true]) {
  test(`screens move ${duplicate ? 'cleans an old duplicate target' : 'fills an empty target slot'} without replacing another session`, async ({ page }) => {
    const value = moveScreens(); value.screens[1].panes = ['demo03', duplicate ? 'demo02' : null, 'extra1', 'extra2'];
    value.screens[1].maximized = 0;
    const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': value }, extraTabs: [1, 2].map(n => ({ id: 'extra' + n, name: 'Extra ' + n, type: 'shell', alive: true })) });
    await openMove(page, 'demo02');
    await page.locator('#ws-move-list [data-move-screen="screen2"]').click();
    await expect(page.locator('#ws-move-modal')).toBeHidden();
    const saved = fixture.layouts['/api/layouts/desktop_user_demo'];
    expect(saved.screens[1].panes).toEqual(duplicate ? ['demo03', 'extra1', 'extra2', 'demo02'] : ['demo03', 'demo02', 'extra1', 'extra2']);
    expect(saved.screens[1].maximized).toBeNull();
    expect(await page.evaluate(() => active.tab.id)).toBe('demo02');
    expectNoNativeChanges(fixture);
  });
}

test('screens move keeps stopped and missing references without starting native programs', async ({ page }) => {
  const value = moveScreens(); value.screens[0].panes = ['demo01', 'stopped', 'missing'];
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': value }, extraTabs: [{ id: 'stopped', name: 'Stopped', type: 'codex', alive: false }] });
  await openMove(page, 'stopped'); await page.locator('#ws-move-list [data-move-screen="screen2"]').click();
  await expect(page.locator('#ws-move-modal')).toBeHidden();
  expect(await page.evaluate(() => active.tab.id)).toBe('stopped');
  await page.locator('#ws-screen-tabs [data-screen="screen1"]').click();
  await openMove(page, 'missing'); await page.locator('#ws-move-list [data-move-screen="screen2"]').click();
  await expect(page.locator('#ws-move-modal')).toBeHidden();
  expect(await page.evaluate(() => active.savedId)).toBe('missing');
  expect(fixture.layouts['/api/layouts/desktop_user_demo'].screens[1].panes).toEqual(['demo03', 'stopped', 'missing']);
  expectNoNativeChanges(fixture);
});

test('screens move on mobile can create a destination without replacing a full screen or changing desktop', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const value = moveScreens(), before = JSON.stringify(value);
  const fixture = await workspace(page, 'light', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': value } });
  await openMove(page, 'demo02');
  await expect(page.locator('#ws-move-list [data-move-screen="screen2"]')).toBeDisabled();
  expect(await page.locator('#ws-move-list [data-move-screen=""]').evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/webcc-v107-move-mobile.png' });
  await page.locator('#ws-move-list [data-move-screen=""]').click();
  await expect(page.locator('#ws-move-modal')).toBeHidden();
  expect(fixture.layouts['/api/layouts/mobile_user_demo'].screens.map(s => s.panes)).toEqual([[], ['demo03'], ['demo02']]);
  expect(JSON.stringify(fixture.layouts['/api/layouts/desktop_user_demo'])).toBe(before);
  expectNoNativeChanges(fixture);
});

test('screens move cancellation and stale picker never move a different screen or send Escape to the terminal', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': moveScreens() } });
  await openMove(page, 'demo02'); await page.keyboard.press('Escape');
  await expect(page.locator('#ws-move-modal')).toBeHidden();
  expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
  await openMove(page, 'demo02');
  await page.evaluate(() => document.querySelector('#ws-screen-tabs [data-screen="screen2"]').click());
  await expect(page.locator('#ws-screen-tabs [data-screen="screen2"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#ws-move-list [data-move-screen=""]')).toBeDisabled();
  await page.locator('#ws-move-list [data-move-screen=""]').dispatchEvent('click');
  await expect(page.locator('#toast')).toContainText('窗口或屏幕已变化');
  expect(fixture.layouts['/api/layouts/desktop_user_demo'].screens.map(s => s.panes)).toEqual([['demo01', 'demo02', 'demo04'], ['demo03']]);
  expectNoNativeChanges(fixture);
});

test('screens move save failure preserves both local layouts and does not claim a successful sync', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': moveScreens() } });
  await page.evaluate(() => ccWorkspace.persist());
  await page.route('**/api/layouts/desktop_user_demo', route => route.request().method() === 'PUT' ? route.fulfill({ status: 409, json: { detail: 'Layout changed' } }) : route.fallback());
  await openMove(page, 'demo02'); await page.locator('#ws-move-list [data-move-screen="screen2"]').click();
  await expect(page.locator('#ws-move-modal')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('布局未同步');
  const local = await page.evaluate(() => JSON.parse(localStorage.cc_screens_recovery_desktop_user_demo));
  expect(local.pending).toBe(true);
  expect(local.layout.screens.map(s => s.panes)).toEqual([['demo01', 'demo04'], ['demo03', 'demo02']]);
  expect(fixture.layouts['/api/layouts/desktop_user_demo'].screens[0].panes).toContain('demo02');
  expectNoNativeChanges(fixture);
});

test('screens move waits for unsaved edits and refuses to discard them on a preflight failure', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': moveScreens() } });
  await page.evaluate(() => ccWorkspace.persist());
  await page.route('**/api/layouts/desktop_user_demo', route => route.request().method() === 'PUT' ? route.fulfill({ status: 503, json: { detail: 'Offline' } }) : route.fallback());
  await openMove(page, 'demo02');
  await page.evaluate(() => {
    // Make an actual unsaved edit, not only a dirty flag for unchanged data.
    gridFr.cols = [2, 1];
    ccWorkspace.layoutChanged();
    document.querySelector('#ws-move-list [data-move-screen="screen2"]').click();
  });
  await expect(page.locator('#ws-move-state')).toContainText('布局未同步');
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo02', 'demo04']);
  expect(await page.evaluate(() => gridFr.cols)).toEqual([2, 1]);
  expect(fixture.layouts['/api/layouts/desktop_user_demo'].activeScreen).toBe('screen1');
  expectNoNativeChanges(fixture);
});

test('screens move final window to a new screen leaves an empty source that survives reopening', async ({ page }) => {
  const value = moveScreens(); value.screens[0].panes = ['demo02']; value.screens[0].maximized = 0;
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': value } });
  await openMove(page, 'demo02'); await page.locator('#ws-move-list [data-move-screen=""]').click();
  await expect(page.locator('#ws-move-modal')).toBeHidden();
  expect(fixture.layouts['/api/layouts/desktop_user_demo'].screens[0]).toMatchObject({ panes: [], active: null, maximized: null });
  await page.locator('#ws-screen-tabs [data-screen="screen1"]').click();
  await page.evaluate(() => ccWorkspace.persist());
  await page.reload(); await page.waitForFunction(() => ccWorkspace.ready);
  await expect(page.locator('.pane')).toHaveCount(0);
  expectNoNativeChanges(fixture);
});

test('screens move respects the sixteen screen limit and viewport changes close an old picker', async ({ page }) => {
  const value = moveScreens();
  value.screens = [...value.screens, ...Array.from({ length: 14 }, (_, i) => ({ ...value.screens[1], id: 'extra' + i, name: 'Extra ' + i }))];
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': value } });
  await openMove(page, 'demo02');
  await expect(page.locator('#ws-move-list [data-move-screen=""]')).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#ws-move-modal')).toBeHidden();
  await expect.poll(() => fixture.layouts['/api/layouts/mobile_user_demo']?.screens.length).toBe(16);
  expect(fixture.layouts['/api/layouts/desktop_user_demo'].screens[0].panes).toEqual(['demo01', 'demo02', 'demo04']);
  expectNoNativeChanges(fixture);
});

test('screens move ignores external drag data and leaves same-screen swapping available', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': moveScreens() } });
  await page.evaluate(() => {
    const dataTransfer = new DataTransfer(); dataTransfer.setData('text/plain', 'cc-pane');
    document.querySelector('[data-screen="screen2"]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
  await page.locator('.pane-bar').first().dragTo(page.locator('.pane').nth(2));
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo04', 'demo02', 'demo01']);
  await expect(page.locator('#ws-screen-tabs [data-screen="screen1"]')).toHaveAttribute('aria-selected', 'true');
  expectNoNativeChanges(fixture);
});

test('screens migrate four panes and selecting them on another screen transfers ownership', async ({ page }) => {
  const ids = ['demo01', 'demo02', 'demo03', 'demo04'];
  const fixture = await workspace(page, 'dark', { initial: { panes: ids, active: 'demo02' } });
  await expect(page.locator('#ws-screen-tabs [role="tab"]')).toHaveCount(1);
  await expect(page.locator('#ws-screen-tabs')).toContainText('屏幕1');
  await page.locator('#ws-screen-add').click();
  await expect(page.locator('.pane')).toHaveCount(0);
  await chooseSplits(page, ids.slice().reverse());
  await page.locator('#ws-screen-tabs [role="tab"]').first().click();
  expect(await page.evaluate(() => panes.length)).toBe(0);
  await expect(treeOpen(page, 'demo02')).toBeEnabled({ timeout: 1000 });
  await page.locator('#ws-screen-tabs [role="tab"]').nth(1).click();
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(ids.slice().reverse());
  await page.evaluate(() => ccWorkspace.persist());
  const saved = Object.values(fixture.layouts)[0];
  expect(saved.screens.map(screen => screen.panes.length)).toEqual([0, 4]);
  expect(fixture.requests.filter(request => /\/api\/sessions(?:\/|$)/.test(request.path) && request.method !== 'GET')).toEqual([]);
  expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const width of [320, 1440]) for (const theme of ['dark', 'light']) {
  test(`screens add button follows the last tab ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await workspace(page, theme);
    const add = page.locator('#ws-screen-add');
    const checkPosition = async () => {
      const tab = await page.locator('#ws-screen-tabs [role="tab"]').last().boundingBox();
      const plus = await add.boundingBox();
      const strip = await page.locator('#ws-screen-strip').boundingBox();
      expect(plus.x - tab.x - tab.width).toBeCloseTo(4, 0);
      expect(plus.x).toBeGreaterThanOrEqual(strip.x);
      expect(plus.x + plus.width).toBeLessThanOrEqual(strip.x + strip.width + 1);
      expect(plus.height).toBeGreaterThanOrEqual(width === 320 ? 44 : 28);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };
    await checkPosition();
    await page.locator('#ws-screen-tabs [role="tab"]').focus();
    await page.keyboard.press('Tab');
    await expect(add).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#ws-screen-tabs [role="tab"]')).toHaveCount(2);
    await expect(add).toBeEnabled();
    await checkPosition();
    await page.screenshot({ path: `/tmp/webcc-v106-inline-add-${theme}-${width}.png` });
    expect(fixture.errors).toEqual([]);
    expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
  });
}

for (const width of [320, 1440]) {
  test(`screens overflowing tabs keep the trailing add button reachable ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const value = demoScreens();
    value.screens = Array.from({ length: 15 }, (_, i) => ({ ...value.screens[1], id: 'screen' + (i + 1), name: 'Screen ' + (i + 1) + ' long label' }));
    const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': value } });
    expect(await page.locator('#ws-screen-strip').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    await page.locator('#ws-screen-add').scrollIntoViewIfNeeded();
    await page.locator('#ws-screen-add').click();
    await expect(page.locator('#ws-screen-tabs [role="tab"]')).toHaveCount(16);
    await expect(page.locator('#ws-screen-add')).toBeDisabled();
    await expect(page.locator('#ws-screen-tabs [role="tab"]').last()).toBeEnabled();
    const plus = await page.locator('#ws-screen-add').boundingBox();
    const strip = await page.locator('#ws-screen-strip').boundingBox();
    expect(plus.x).toBeGreaterThanOrEqual(strip.x);
    expect(plus.x + plus.width).toBeLessThanOrEqual(strip.x + strip.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(fixture.errors).toEqual([]);
  });
}

test('screens restore selected screen ratios focus and maximized pane after reopening', async ({ page }) => {
  const layouts = { '/api/layouts/desktop_user_demo': demoScreens() };
  const fixture = await workspace(page, 'dark', { layouts, profile: 'demo' });
  expect(await page.evaluate(() => active.tab.id)).toBe('demo03');
  await page.locator('#ws-screen-tabs [data-screen="screen1"]').click();
  await expect.poll(() => page.evaluate(() => maximizedPane?.tab.id)).toBe('demo02');
  expect(await page.evaluate(() => gridFr.cols)).toEqual([1, 2]);
  await page.evaluate(() => ccWorkspace.persist());
  await page.reload();
  await page.waitForFunction(() => ccWorkspace.ready && active?.ws?.readyState === 1);
  expect(await page.evaluate(() => ({ panes: panes.map(p => p.tab.id), active: active.tab.id, max: maximizedPane?.tab.id, cols: gridFr.cols }))).toEqual({ panes: ['demo01', 'demo02', 'demo04'], active: 'demo02', max: 'demo02', cols: [1, 2] });
  await page.locator('.pane.focused .pane-expand').click();
  await page.evaluate(() => ccWorkspace.persist());
  expect(layouts['/api/layouts/desktop_user_demo'].screens[0].maximized).toBeNull();
  expect(fixture.errors).toEqual([]);
});

test('screens rename and deletion preserve tasks and last screen cannot be deleted', async ({ page }) => {
  const fixture = await workspace(page, 'dark');
  await expect(page.locator('#ws-screen-tools [aria-label="删除当前屏幕"]')).toBeDisabled();
  await page.locator('#ws-screen-add').click();
  await page.locator('#ws-screen-tools [aria-label="重命名屏幕"]').click();
  await page.locator('.ui-dialog-input').fill('Research');
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await expect(page.locator('#ws-screen-tabs [aria-selected="true"]')).toContainText('Research');
  await page.locator('#ws-screen-tools [aria-label="删除当前屏幕"]').click();
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await expect(page.locator('#ws-screen-tabs [role="tab"]')).toHaveCount(1);
  await expect(page.locator('.pane')).toHaveCount(1);
  expect(fixture.requests.filter(request => request.path.startsWith('/api/sessions/') && request.method !== 'GET')).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('screens bind a new named profile then another browser recovers the same screen set', async ({ page, browser }) => {
  const fixture = await workspace(page, 'dark');
  await chooseSplits(page, ['demo01', 'demo02']);
  await page.locator('#ws-screen-add').click();
  await chooseSplits(page, ['demo03', 'demo04']);
  await bindProfile(page, 'DEMO');
  expect(await page.evaluate(() => localStorage.cc_layout_user)).toBe('demo');
  await expect(treeOpen(page, 'demo03')).toBeEnabled({ timeout: 1000 });
  expect(fixture.layouts['/api/layouts/desktop_user_demo'].screens).toHaveLength(2);
  const second = await browser.newPage();
  try {
    const other = await workspace(second, 'light', { layouts: fixture.layouts });
    await bindProfile(second, 'demo');
    expect(await second.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo03', 'demo04']);
    await expect(second.locator('#ws-screen-tabs [role="tab"]')).toHaveCount(2);
    await second.reload(); await second.waitForFunction(() => ccWorkspace.ready && active?.term);
    expect(await second.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo03', 'demo04']);
    expect(other.errors).toEqual([]);
  } finally { await second.close(); }
  expect(fixture.errors).toEqual([]);
});

test('screens binding an existing profile reads before saving and unbinding restores local layout', async ({ page }) => {
  const layouts = { '/api/layouts/desktop_user_demo': demoScreens() };
  const fixture = await workspace(page, 'dark', { layouts });
  await bindProfile(page, 'demo');
  expect(await page.evaluate(() => active.tab.id)).toBe('demo03');
  expect(layouts['/api/layouts/desktop_user_demo'].revision).toBe(3);
  await page.locator('#ws-layout-user').click();
  await page.locator('#ws-user-local').click();
  await expect(page.locator('#ws-user-modal')).toBeHidden();
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  await expect(page.locator('#ws-screen-tabs [role="tab"]')).toHaveCount(1);
  expect(fixture.requests.filter(request => request.path === '/api/layouts/desktop_user_demo' && request.method === 'PUT')).toEqual([]);
});

test('screens failed binding leaves original user and panes intact', async ({ page }) => {
  const fixture = await workspace(page, 'dark');
  await page.route('**/api/layouts/desktop_user_demo', route => route.fulfill({ status: 503, json: { detail: 'Profile unavailable' } }));
  await page.locator('#ws-layout-user').click(); await page.locator('#ws-user-input').fill('demo'); await page.locator('#ws-user-bind').click();
  await expect(page.locator('#ws-user-state')).toContainText('Profile unavailable');
  expect(await page.evaluate(() => localStorage.cc_layout_user || '')).toBe('');
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  await expect(page.locator('#ws-user-modal')).toBeVisible();
  expect(fixture.errors).toEqual([]);
});

test('screens keep stopped and deleted slots without starting or guessing a conversation', async ({ page }) => {
  const value = demoScreens();
  value.screens[1] = { ...value.screens[1], panes: ['stopped', 'deleted', 'demo03'], active: 'demo03' };
  const fixture = await workspace(page, 'dark', { layouts: { '/api/layouts/desktop_user_demo': value }, profile: 'demo', extraTabs: [{ id: 'stopped', name: 'My stopped task', type: 'codex', alive: false }] });
  await expect(page.locator('.pane')).toHaveCount(3);
  await expect(page.locator('.ws-offline-pane')).toHaveCount(2);
  expect(await page.evaluate(() => panes.map(p => p.tab?.id || p.savedId))).toEqual(['stopped', 'deleted', 'demo03']);
  await page.evaluate(() => ccWorkspace.persist());
  expect(fixture.requests.filter(request => /\/api\/sessions(?:\/|$)/.test(request.path) && request.method !== 'GET')).toEqual([]);
  fixture.tabs.find(tab => tab.id === 'stopped').alive = true;
  await page.locator('.ws-offline-pane [aria-label="恢复原对话"]').click();
  await page.waitForFunction(() => panes.some(p => p.tab?.id === 'stopped' && p.term));
  expect(fixture.requests.filter(request => /\/api\/sessions(?:\/|$)/.test(request.path) && request.method !== 'GET')).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('screens pending local journal recovers unsent changes after immediate client shutdown', async ({ page }) => {
  const value = demoScreens(0); value.activeScreen = 'screen1';
  const fixture = await workspace(page, 'dark', { identity: 'journaltest', journal: { device: 'desktop_journaltest', value: { baseRevision: 0, pending: true, layout: value } } });
  await expect(page.locator('#ws-screen-tabs [role="tab"]')).toHaveCount(2);
  await expect.poll(() => fixture.layouts['/api/layouts/desktop_journaltest']?.activeScreen).toBe('screen1');
  expect(await page.evaluate(() => JSON.parse(localStorage.cc_screens_recovery_desktop_journaltest).pending)).toBe(false);
  expect(fixture.errors).toEqual([]);
});

test('screens conflicting local journal is retained without overwriting server state', async ({ page }) => {
  const server = demoScreens(4), local = demoScreens(3); local.activeScreen = 'screen1';
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': server }, journal: { device: 'desktop_user_demo', value: { baseRevision: 3, pending: true, layout: local } } });
  await expect(page.locator('#ws-save-indicator')).toContainText('冲突');
  expect(await page.evaluate(() => active.tab.id)).toBe('demo02');
  expect(fixture.requests.filter(request => request.method === 'PUT')).toEqual([]);
  expect(fixture.layouts['/api/layouts/desktop_user_demo'].revision).toBe(4);
  await page.locator('#ws-screen-tools [aria-label="重新载入屏幕布局"]').click();
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await expect.poll(() => page.evaluate(() => active.tab.id)).toBe('demo03');
  expect(await page.evaluate(() => JSON.parse(localStorage.cc_screens_conflict_desktop_user_demo).layout.activeScreen)).toBe('screen1');
  expect(fixture.errors).toEqual([]);
});

test('screens empty selection remains empty after reopen and never attaches the previous browser terminal', async ({ page }) => {
  const value = demoScreens(); value.screens[1] = { ...value.screens[1], panes: [], active: null };
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': value }, initial: { panes: ['demo01'], active: 'demo01' }, allowEmpty: true });
  expect(await page.evaluate(() => socketCount)).toBe(0);
  await expect(page.locator('#empty')).toBeVisible();
  await page.reload(); await page.waitForFunction(() => ccWorkspace.ready);
  expect(await page.evaluate(() => socketCount)).toBe(0);
  await expect(page.locator('#ws-screen-tabs [aria-selected="true"]')).toContainText('Screen 2');
  await page.locator('#ws-screen-tabs [data-screen="screen1"]').click();
  await expect(page.locator('.pane')).toHaveCount(3);
  expect(fixture.errors).toEqual([]);
});

test('screens restoring a maximized empty slot never focuses a hidden running terminal', async ({ page }) => {
  const value = demoScreens(); value.activeScreen = 'screen1';
  value.screens[0] = { ...value.screens[0], panes: ['demo01', null], active: null, maximized: 1 };
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': value }, allowEmpty: true });
  expect(await page.evaluate(() => active === maximizedPane && !active.tab && panes.length === 2)).toBe(true);
  await expect(page.locator('#btn-interrupt')).toBeDisabled();
  await page.locator('#ws-screen-tabs [data-screen="screen2"]').click();
  await page.locator('#ws-screen-tabs [data-screen="screen1"]').click();
  expect(await page.evaluate(() => active === maximizedPane && !active.tab)).toBe(true);
  await page.reload(); await page.waitForFunction(() => ccWorkspace.ready);
  expect(await page.evaluate(() => active === maximizedPane && !active.tab)).toBe(true);
  await expect(page.locator('#btn-interrupt')).toBeDisabled();
  expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('screens clean legacy shared references and retain the current owner across reload', async ({ page }) => {
  const value = demoScreens(); value.screens[1].panes.push('demo02');
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': value } });
  await page.evaluate(() => { window.sharedPane = paneOfTab('demo02'); window.sharedSocket = sharedPane.ws; });
  await page.evaluate(() => ccWorkspace.sessionsChanged());
  expect(await page.evaluate(() => paneOfTab('demo02') === sharedPane && sharedPane.ws === sharedSocket)).toBe(true);
  await page.locator('#ws-screen-tabs [data-screen="screen1"]').click();
  expect(await page.evaluate(() => paneOfTab('demo02'))).toBeNull();
  expect(await page.evaluate(() => sharedSocket.readyState)).toBe(3);
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo04']);
  await page.reload(); await page.waitForFunction(() => ccWorkspace.ready && active?.ws?.readyState === 1);
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo04']);
  expectNoNativeChanges(fixture);
});

test('screens edits during an in-flight save are journaled then saved with the new revision', async ({ page }) => {
  const fixture = await workspace(page, 'dark');
  let release, arrived;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { arrived = resolve; });
  let held = false;
  await page.route('**/api/layouts/*', async route => {
    if (route.request().method() === 'PUT' && !held) { held = true; arrived(); await gate; }
    return route.fallback();
  });
  await page.evaluate(() => { splitPane(); void ccWorkspace.persist(); });
  await started;
  await page.evaluate(() => { gridFr.cols = [1, 3]; savePaneLayout(); });
  expect(await page.evaluate(() => JSON.parse(localStorage[Object.keys(localStorage).find(key => key.startsWith('cc_screens_recovery_'))]).layout.ratios.cols)).toEqual([1, 3]);
  release();
  await page.evaluate(() => ccWorkspace.persist());
  expect(Object.values(fixture.layouts)[0].ratios.cols).toEqual([1, 3]);
  expect(await page.evaluate(() => JSON.parse(localStorage[Object.keys(localStorage).find(key => key.startsWith('cc_screens_recovery_'))]).pending)).toBe(false);
  expect(fixture.errors).toEqual([]);
});

test('screens refusing an old backend preserves local state instead of claiming successful saves', async ({ page }) => {
  const fixture = await workspace(page, 'dark');
  await page.route('**/api/layouts/*', route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { panes: body.panes, active: body.active, direction: body.direction, ratios: body.ratios, revision: body.revision + 1 } });
  });
  await page.locator('#ws-screen-add').click();
  await expect(page.locator('#ws-save-indicator')).toContainText('布局未保存');
  await expect(page.locator('#ws-screen-tabs [role="tab"]')).toHaveCount(2);
  expect(await page.evaluate(() => JSON.parse(localStorage[Object.keys(localStorage).find(key => key.startsWith('cc_screens_recovery_'))]).layout.screens.length)).toBe(2);
  expect(fixture.errors).toEqual([]);
});

test('screens binding does not commit a new profile when its initial save fails', async ({ page }) => {
  const fixture = await workspace(page, 'dark');
  await page.route('**/api/layouts/desktop_user_demo', route => route.request().method() === 'PUT' ? route.fulfill({ status: 409, json: { detail: 'Concurrent profile creation' } }) : route.fallback());
  await page.locator('#ws-layout-user').click(); await page.locator('#ws-user-input').fill('demo'); await page.locator('#ws-user-bind').click();
  await expect(page.locator('#ws-user-state')).toContainText('Concurrent profile creation');
  expect(await page.evaluate(() => localStorage.cc_layout_user || '')).toBe('');
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  expect(fixture.errors).toEqual([]);
});

test('screens desktop to mobile and back keeps separate screen sets and four desktop panes', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': demoScreens() } });
  await page.locator('#ws-screen-tabs [data-screen="screen1"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => Object.values(fixture.layouts).find(value => value.screens?.[0].panes.length === 1)?.screens.length).toBe(2);
  expect(await page.evaluate(() => panes.length)).toBe(1);
  expect(fixture.layouts['/api/layouts/desktop_user_demo'].screens[0].panes).toEqual(['demo01', 'demo02', 'demo04']);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => page.evaluate(() => panes.length)).toBe(3);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo02');
  expect(fixture.errors).toEqual([]);
});

test('screens support arrow navigation without sending terminal input', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': demoScreens() } });
  await page.locator('#ws-screen-tabs [aria-selected="true"]').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#ws-screen-tabs [data-screen="screen1"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#ws-screen-tabs [data-screen="screen1"]')).toBeEnabled();
  await expect(page.locator('#ws-screen-tabs [data-screen="screen1"]')).toBeFocused();
  // A late socket-open callback must not steal keyboard navigation focus.
  await page.evaluate(() => active.ws.onopen?.());
  await expect(page.locator('#ws-screen-tabs [data-screen="screen1"]')).toBeFocused();
  expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('screens enforce the screen limit and deleting a screen frees a slot without native changes', async ({ page }) => {
  const value = demoScreens();
  value.screens = Array.from({ length: 16 }, (_, i) => ({ ...value.screens[1], id: 'screen' + (i + 1), name: 'Screen ' + (i + 1) }));
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': value } });
  await expect(page.locator('#ws-screen-add')).toBeDisabled();
  await page.locator('#ws-screen-tools [aria-label="删除当前屏幕"]').click();
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('#ws-screen-tabs [role="tab"]')).toHaveCount(15);
  await expect(page.locator('#ws-screen-add')).toBeEnabled();
  expect(fixture.requests.filter(request => request.path.startsWith('/api/sessions/') && request.method !== 'GET')).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('screens resizing during a pending layout read finishes in the correct device profile', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': demoScreens() } });
  let release, arrived;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { arrived = resolve; });
  let held = false;
  await page.route('**/api/layouts/desktop_user_demo', async route => {
    if (route.request().method() === 'GET' && !held) { held = true; arrived(); await gate; }
    return route.fallback();
  });
  await page.locator('#ws-screen-tools [aria-label="重新载入屏幕布局"]').click();
  await started;
  await page.setViewportSize({ width: 390, height: 844 });
  release();
  await expect.poll(() => fixture.layouts['/api/layouts/mobile_user_demo']?.screens.length).toBe(2);
  expect(await page.evaluate(() => panes.length)).toBe(1);
  await expect(page.locator('#ws-layout-user')).toBeEnabled();
  expect(fixture.errors).toEqual([]);
});

for (const theme of ['dark', 'light']) for (const width of [320, 1440]) {
  test(`screens preview ${theme} ${width} has visible terminals and no page overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const value = demoScreens(); value.activeScreen = 'screen1'; value.screens[0].maximized = null;
    value.screens[0].name = '屏幕1'; value.screens[1].name = '屏幕2';
    const fixture = await workspace(page, theme, { profile: 'demo', layouts: { '/api/layouts/desktop_user_demo': value } });
    await page.evaluate(() => Promise.all(panes.map((p, i) => new Promise(resolve => p.term.write('\r\n\x1b[32mPASS\x1b[0m workspace ' + (i + 1) + '\r\n\r\n~/workspace/demo $\r\n', resolve)))));
    await expect(page.locator('#ws-screen-bar')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => panes.every(p => p.term.cols > 10 && p.term.rows > 4 && p.host.clientHeight > 100))).toBe(true);
    await page.screenshot({ path: `/tmp/webcc-v106-preview-${theme}-${width}.png` });
    expect(fixture.errors).toEqual([]);
  });
}

for (const width of [390, 700, 1024, 1440]) {
  test(`screens toolbar and profile fit viewport ${width} and device layouts stay independent`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const value = demoScreens();
    const layouts = { '/api/layouts/desktop_user_demo': value };
    const fixture = await workspace(page, 'dark', { profile: 'demo', layouts });
    await expect(page.locator('#ws-screen-bar')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const mobile = await page.evaluate(() => mqMobile.matches);
    if (mobile) {
      expect(await page.evaluate(() => panes.length)).toBe(1);
      expect(layouts['/api/layouts/desktop_user_demo'].revision).toBe(3);
      await expect.poll(() => layouts['/api/layouts/mobile_user_demo']?.screens.length).toBe(2);
    } else {
      await page.locator('#ws-screen-tabs [data-screen="screen1"]').click();
      expect(await page.evaluate(() => panes.length)).toBe(3);
    }
    await page.locator('#ws-layout-user').click();
    await expect(page.locator('#ws-user-modal')).toBeVisible();
    await expect(page.locator('#ws-user-modal')).not.toHaveClass(/is-opening/);
    expect(fixture.errors).toEqual([]);
    await page.screenshot({ path: `/tmp/webcc-v106-screens-${width}.png` });
  });
}

async function legacyRecovery(page, theme = 'dark', options = {}) {
  const fixture = await workspace(page, theme, { extraTabs: [{ id: 'legacy', name: 'Stopped task', type: options.agent || 'claude', cwd: '/workspace/old', alive: false }] });
  const choices = options.choices || [{ sessionId: recoveryId, title: 'Original conversation', updatedAt: 1800000000, candidateKey: 'candidate-one', inUse: false }];
  const mutations = [];
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/sessions(?:\/|$)/.test(new URL(request.url()).pathname)) mutations.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
  await page.route('**/api/sessions/legacy/restart', route => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 409, json: { detail: '此终端没有已记录的原生会话' } });
    if (options.restartFailure) return route.abort();
    const tab = fixture.tabs.find(item => item.id === 'legacy'); tab.alive = true;
    return route.fulfill({ json: { ...tab, resumed: true } });
  });
  await page.route('**/api/sessions/legacy/recovery?*', async route => {
    if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
    if (options.readFailure) return route.fulfill({ status: options.readFailure, json: { detail: '此窗口已运行，请刷新后直接打开，不会修改其绑定' } });
    const url = new URL(route.request().url()), q = url.searchParams.get('q'), offset = Number(url.searchParams.get('offset'));
    const filtered = choices.filter(item => (item.title + ' ' + item.sessionId).includes(q));
    return route.fulfill({ json: { expected: 'binding-challenge', agent: options.agent || 'claude', cwd: '/workspace/old', defaultsUsed: true,
      candidates: filtered.slice(offset, offset + 2), total: filtered.length, hasMore: filtered.length > offset + 2 } });
  });
  await page.route('**/api/sessions/legacy/recovery/bind', route => options.bindFailure ? route.fulfill({ status: 409, json: { detail: '历史记录已改变，请重新选择' } }) :
    route.fulfill({ json: { ready: true, expected: 'bound-challenge', sessionId: recoveryId } }));
  if (await page.evaluate(() => mqMobile.matches)) await page.locator('#hamburger').click();
  if (options.action === 'restart') await page.evaluate(() => { void requestRestartTab(state.tabs.find(tab => tab.id === 'legacy')); });
  else {
    await page.locator('[data-workspace="_unassigned"]').click();
    await page.locator('[data-group="_unassigned"] .ws-stopped-toggle').click();
    await page.locator('.ws-session[data-session="legacy"] .ws-session-open').click();
  }
  await expect(page.locator('#recovery-modal')).toBeVisible();
  await expect(page.locator('#recovery-modal')).not.toHaveClass(/is-opening/);
  return { ...fixture, mutations };
}

for (const agent of ['codex', 'claude', 'opencode']) {
  test(`stale stopped ${agent} entry attaches the live terminal without recovery or restart`, async ({ page }) => {
    const fixture = await workspace(page, 'dark', { extraTabs: [{ id: 'legacy', type: agent, cwd: '/workspace/old', alive: false }] });
    const requests = [];
    page.on('request', request => { if (/\/api\/sessions(?:\/|$)/.test(new URL(request.url()).pathname)) requests.push({ path: new URL(request.url()).pathname, method: request.method() }); });
    fixture.tabs.find(tab => tab.id === 'legacy').alive = true;
    expect(await page.evaluate(() => openTab(state.tabs.find(tab => tab.id === 'legacy')))).toBe(true);
    await page.waitForFunction(() => active?.tab?.id === 'legacy' && active.ws?.readyState === 1);
    await expect(page.locator('#recovery-modal')).toBeHidden();
    await expect(page.locator('.ui-dialog')).toHaveCount(0);
    expect(requests.every(request => request.method === 'GET' && request.path === '/api/sessions')).toBe(true);
    expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

for (const stage of ['restart-conflict', 'restart-running', 'history-conflict']) {
  test(`terminal becoming live during ${stage} attaches without changing its binding`, async ({ page }) => {
    const fixture = await workspace(page, 'dark', { extraTabs: [{ id: 'legacy', type: 'claude', cwd: '/workspace/old', alive: false }] });
    const requests = [];
    page.on('request', request => { if (/\/api\/sessions(?:\/|$)/.test(new URL(request.url()).pathname)) requests.push({ path: new URL(request.url()).pathname, method: request.method() }); });
    await page.route('**/api/sessions/legacy/restart', route => {
      if (stage !== 'history-conflict') fixture.tabs.find(tab => tab.id === 'legacy').alive = true;
      return route.fulfill(stage === 'restart-running' ? { json: { ready: true, running: true, sessionId: recoveryId } } :
        { status: 409, json: { detail: '此终端没有已记录的原生会话' } });
    });
    await page.route('**/api/sessions/legacy/recovery?*', route => {
      fixture.tabs.find(tab => tab.id === 'legacy').alive = true;
      return route.fulfill({ status: 409, json: { detail: '此窗口已运行，请刷新后直接打开，不会修改其绑定' } });
    });
    expect(await page.evaluate(() => openTab(state.tabs.find(tab => tab.id === 'legacy')))).toBe(true);
    await page.waitForFunction(() => active?.tab?.id === 'legacy' && active.ws?.readyState === 1);
    await expect(page.locator('#recovery-modal')).toBeHidden();
    await expect(page.locator('.ui-dialog')).toHaveCount(0);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test('a stale stopped entry focuses its existing connected split without replacing either terminal', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraTabs: [{ id: 'legacy', type: 'claude', cwd: '/workspace/old', alive: false }] });
  await page.evaluate(() => {
    attachTerminal({ ...state.tabs.find(tab => tab.id === 'legacy'), alive: true }, makePane());
    focusPane(panes[0], false);
    window.keptPanes = panes.map(pane => ({ pane, term: pane.term, ws: pane.ws, gen: pane.gen }));
  });
  await page.waitForFunction(() => panes.every(pane => pane.ws?.readyState === 1));
  fixture.tabs.find(tab => tab.id === 'legacy').alive = true;
  const count = await page.evaluate(() => socketCount);
  expect(await page.evaluate(() => openTab(state.tabs.find(tab => tab.id === 'legacy')))).toBe(true);
  expect(await page.evaluate(() => active.tab.id)).toBe('legacy');
  expect(await page.evaluate(() => keptPanes.every(({ pane, term, ws, gen }) => panes.includes(pane) && pane.term === term && pane.ws === ws && pane.gen === gen))).toBe(true);
  expect(await page.evaluate(() => socketCount)).toBe(count);
  expect(fixture.requests.filter(request => request.method === 'POST' && /^\/api\/sessions(?:\/|$)/.test(request.path))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('recovery read errors hide the optional search and allow a read-only live-window refresh', async ({ page }) => {
  const fixture = await legacyRecovery(page, 'dark', { readFailure: 409 });
  await expect(page.locator('#recovery-state')).toContainText('读取未完成');
  await expect(page.locator('#recovery-query')).toBeHidden();
  await expect(page.locator('#recovery-apply')).toBeDisabled();
  fixture.tabs.find(tab => tab.id === 'legacy').alive = true;
  await page.locator('#recovery-refresh').click();
  await page.waitForFunction(() => active?.tab?.id === 'legacy' && active.ws?.readyState === 1);
  await expect(page.locator('#recovery-modal')).toBeHidden();
  expect(fixture.mutations).toEqual([]);
  expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('failed state checks never start, bind or present a guessed history selection', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraTabs: [{ id: 'legacy', type: 'claude', cwd: '/workspace/old', alive: false }] });
  const mutations = [];
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/sessions(?:\/|$)/.test(new URL(request.url()).pathname)) mutations.push(request.url()); });
  await page.route('**/api/sessions', route => route.abort());
  expect(await page.evaluate(() => openTab(state.tabs.find(tab => tab.id === 'legacy')))).toBe(false);
  await expect(page.locator('#recovery-modal')).toBeHidden();
  expect(mutations).toEqual([]);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  expect(fixture.errors).toEqual([]);
});

test('a changed active pane cancels a stale stopped entry before attaching its live terminal', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraTabs: [{ id: 'legacy', type: 'claude', cwd: '/workspace/old', alive: false }] });
  fixture.tabs.find(tab => tab.id === 'legacy').alive = true;
  await page.route('**/api/sessions', async route => {
    await page.evaluate(() => attachTerminal(state.tabs.find(tab => tab.id === 'demo02'), active));
    return route.fulfill({ json: { sessions: fixture.tabs } });
  });
  expect(await page.evaluate(() => openTab(state.tabs.find(tab => tab.id === 'legacy')))).toBe(false);
  await expect(page.locator('#recovery-modal')).toBeHidden();
  expect(await page.evaluate(() => active.tab.id)).toBe('demo02');
  expect(fixture.requests.filter(request => request.method === 'POST' && /^\/api\/sessions(?:\/|$)/.test(request.path))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('a recovery conflict followed by a failed status read never assumes the window is running', async ({ page }) => {
  const fixture = await legacyRecovery(page, 'dark', { readFailure: 409 });
  await expect(page.locator('#recovery-state')).toContainText('读取未完成');
  await page.route('**/api/sessions', route => route.fulfill({ status: 503, json: { detail: 'Status unavailable' } }));
  await page.locator('#recovery-refresh').click();
  await expect(page.locator('#recovery-state')).toContainText('Status unavailable');
  await expect(page.locator('#recovery-modal')).toBeVisible();
  await expect(page.locator('#recovery-apply')).toBeDisabled();
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  expect(fixture.mutations).toEqual([]);
  await page.locator('#recovery-close').click();
  expect(fixture.errors).toEqual([]);
});

for (const theme of ['dark', 'light']) for (const width of [320, 1440]) {
  test(`stopped recovery selection fits ${theme} ${width}px and never auto-selects`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await legacyRecovery(page, theme, { choices: [{ sessionId: recoveryId, title: '<img src=x onerror=alert(1)> ' + 'Long title '.repeat(12), candidateKey: 'safe' }] });
    await expect(page.locator('#recovery-list input')).toHaveCount(1);
    await expect(page.locator('#recovery-list input')).not.toBeChecked();
    await expect(page.locator('#recovery-query')).toHaveAttribute('placeholder', /选填/);
    await expect(page.locator('#recovery-apply')).toBeDisabled();
    await expect(page.locator('#recovery-list img')).toHaveCount(0);
    expect(await page.locator('.recovery-box').evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth;
    })).toBe(true);
    expect(fixture.mutations).toEqual([]);
    await page.screenshot({ path: `/tmp/webcc-v101-recovery-${theme}-${width}.png` });
    await page.locator('#recovery-close').click();
    await expect(page.locator('#recovery-modal')).toBeHidden();
    expect(fixture.errors).toEqual([]);
  });
}

test('stopped legacy recovery binds only the confirmed ID and resumes once without terminal input', async ({ page }) => {
  const fixture = await legacyRecovery(page);
  await page.screenshot({ path: '/tmp/webcc-v101-recovery-desktop.png' });
  await page.locator('#recovery-list input').check();
  await page.locator('#recovery-apply').click();
  await expect(page.locator('.ui-dialog-msg')).toContainText(recoveryId);
  expect(fixture.mutations).toEqual([]);
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await expect(page.locator('#recovery-modal')).toBeHidden();
  await page.waitForFunction(() => active?.tab?.id === 'legacy');
  expect(fixture.mutations.map(item => item.path)).toEqual(['/api/sessions/legacy/recovery/bind', '/api/sessions/legacy/restart']);
  expect(fixture.mutations[0].body).toEqual({ expected: 'binding-challenge', sessionId: recoveryId, candidateKey: 'candidate-one', confirmed: true });
  expect(fixture.mutations[1].body.expected).toBe('bound-challenge');
  expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('cancelled or changed-target recovery cannot bind or launch', async ({ page }) => {
  const fixture = await legacyRecovery(page);
  await page.locator('#recovery-list input').check(); await page.locator('#recovery-apply').click();
  await page.locator('.ui-dialog .ui-btn:not(.primary)').click();
  expect(fixture.mutations).toEqual([]);
  await page.locator('#recovery-apply').click();
  await page.evaluate(() => attachTerminal(state.tabs.find(tab => tab.id === 'demo02'), active));
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await expect(page.locator('#recovery-state')).toContainText('目标窗口或屏幕布局已改变');
  expect(fixture.mutations).toEqual([]);
  await page.locator('#recovery-close').click();
  expect(fixture.errors).toEqual([]);
});

test('recovery shows occupied conversations but requires a new unoccupied selection', async ({ page }) => {
  const fixture = await legacyRecovery(page, 'dark', { choices: [{ sessionId: recoveryId, title: 'Busy', inUse: true }] });
  await expect(page.locator('#recovery-list input')).toBeDisabled();
  await expect(page.locator('#recovery-list')).toContainText('正在其他窗口运行');
  await expect(page.locator('#recovery-apply')).toBeDisabled();
  expect(fixture.mutations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('#recovery-modal')).toBeHidden();
});

test('missing history can open a separate shell without deleting or rebinding the original window', async ({ page }) => {
  const fixture = await legacyRecovery(page, 'dark', { choices: [] });
  await expect(page.locator('#recovery-state')).toContainText('未找到');
  await page.locator('#recovery-shell').click();
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await page.waitForFunction(() => active?.tab?.type === 'shell' && active.tab.id === 'new001');
  expect(fixture.tabs.find(tab => tab.id === 'legacy').alive).toBe(false);
  expect(fixture.mutations).toEqual([{ path: '/api/sessions', body: { cwd: '/workspace/old', type: 'shell', mode: 'new' } }]);
  expect(fixture.errors).toEqual([]);
});

for (const failure of ['bindFailure', 'restartFailure']) {
  test(`uncertain recovery ${failure} never automatically retries or launches another session`, async ({ page }) => {
    const fixture = await legacyRecovery(page, 'dark', { [failure]: true });
    await page.locator('#recovery-list input').check(); await page.locator('#recovery-apply').click();
    await page.locator('.ui-dialog .ui-btn.primary').click();
    await expect(page.locator('#recovery-state')).toContainText('不会自动重试');
    await expect(page.locator('#recovery-apply')).toBeDisabled();
    expect(fixture.mutations.map(item => item.path)).toEqual(failure === 'bindFailure' ? ['/api/sessions/legacy/recovery/bind'] : ['/api/sessions/legacy/recovery/bind', '/api/sessions/legacy/restart']);
    expect(fixture.errors).toEqual([]);
  });
}

test('recovery supports searching and paging local history without selecting or starting a dialogue', async ({ page }) => {
  const choices = Array.from({ length: 5 }, (_, index) => ({ sessionId: recoveryId.slice(0, -1) + index, title: 'Conversation ' + index, candidateKey: 'key' + index }));
  const fixture = await legacyRecovery(page, 'dark', { choices });
  await expect(page.locator('#recovery-list input')).toHaveCount(2);
  await page.locator('#recovery-more').click(); await expect(page.locator('#recovery-list input')).toHaveCount(4);
  await page.locator('#recovery-query').fill('Conversation 4'); await page.locator('#recovery-search button').click();
  await expect(page.locator('#recovery-list input')).toHaveCount(1);
  await expect(page.locator('#recovery-list')).toContainText('Conversation 4');
  await expect(page.locator('#recovery-apply')).toBeDisabled();
  expect(fixture.mutations).toEqual([]);
});

test('workspace activity sorting persists usage while retaining pinned order and terminal identities', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraSpaces: [{ id: 'pinned', name: 'Pinned', members: [], pinned: true }] });
  const order = () => page.locator('#ws-workspace-list > .ws-tree-group').evaluateAll(elements => elements.map(el => el.dataset.group));
  await expect.poll(order).toEqual(['pinned', 'ws_demo', 'ws_tools']);
  await page.evaluate(() => { window.kept = { pane: active, term: active.term, ws: active.ws, sockets: socketCount }; });
  await page.locator('[data-workspace="ws_tools"]').click();
  expect(await order()).toEqual(['pinned', 'ws_tools', 'ws_demo']);
  expect(await page.evaluate(() => active === kept.pane && active.term === kept.term && active.ws === kept.ws && socketCount === kept.sockets)).toBe(true);
  expect(fixture.requests.filter(item => item.path.endsWith('/activate'))).toHaveLength(1);
  await page.reload(); await page.waitForFunction(() => ccWorkspace?.ready);
  // Screen restoration is independent of the later workspace metadata request.
  await expect.poll(order).toEqual(['pinned', 'ws_tools', 'ws_demo']);
  expect(fixture.requests.filter(item => item.path.endsWith('/activate'))).toHaveLength(1);
  expect(fixture.requests.filter(item => item.path.startsWith('/api/sessions/') && item.method !== 'GET')).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('workspace activity uses actual interaction timestamps and throttles input touches', async ({ page }) => {
  const fixture = await workspace(page);
  fixture.tabs.find(item => item.id === 'demo03').activity.updatedAt = Date.now() / 1000;
  await page.evaluate(() => loadTabs());
  await expect(page.locator('#ws-workspace-list > .ws-tree-group').first()).toHaveAttribute('data-group', 'ws_tools');
  const original = fixture.requests.filter(item => item.path.endsWith('/activate')).length;
  await page.evaluate(() => { for (let index = 0; index < 20; index++) sendInputTo(active, 'a'); });
  await expect.poll(() => fixture.requests.filter(item => item.path.endsWith('/activate')).length).toBe(original + 1);
  await expect(page.locator('#ws-workspace-list > .ws-tree-group').first()).toHaveAttribute('data-group', 'ws_demo');
  expect(fixture.errors).toEqual([]);
});

test('stopped restart action offers explicit legacy recovery without starting automatically', async ({ page }) => {
  const fixture = await legacyRecovery(page, 'dark', { action: 'restart' });
  await expect(page.locator('#recovery-list input')).toHaveCount(1);
  expect(fixture.mutations).toEqual([]);
  await page.locator('#recovery-close').click();
  await page.waitForFunction(() => !openingTab && restartRequests.size === 0);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  expect(fixture.errors).toEqual([]);
});

test('a rejected stopped restart mutation does not reopen recovery or retry its POST', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraTabs: [{ id: 'saved', type: 'codex', name: 'Saved task', cwd: '/workspace/demo', alive: false }] });
  let reads = 0, posts = 0;
  await page.route('**/api/sessions/saved/restart', route => {
    if (route.request().method() === 'GET') {
      reads++; return route.fulfill({ json: { ready: true, running: false, expected: 'saved', sessionId: recoveryId } });
    }
    posts++; return route.fulfill({ status: 409, json: { detail: '旧后台尚未退出，没有启动第二个会话' } });
  });
  await page.evaluate(() => { void requestRestartTab(state.tabs.find(tab => tab.id === 'saved')); });
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await expect(page.locator('#toast')).toContainText('没有启动第二个会话');
  await expect(page.locator('#recovery-modal')).toBeHidden();
  expect({ reads, posts }).toEqual({ reads: 1, posts: 1 });
  expect(fixture.errors).toEqual([]);
});

test('workspace activity with equal or absent usage ranks live groups above dormant ones', async ({ page }) => {
  const fixture = await workspace(page);
  fixture.spaces.unshift({ id: 'dormant', name: 'Dormant', members: [], pinned: false, revision: 1 });
  await expect.poll(async () => {
    await page.evaluate(() => ccWorkspace.sessionsChanged());
    return page.locator('[data-workspace="dormant"]').count();
  }).toBe(1);
  expect(await page.locator('#ws-workspace-list > .ws-tree-group').evaluateAll(elements => elements.map(el => el.dataset.group))).toEqual(['ws_demo', 'ws_tools', 'dormant']);
  expect(fixture.errors).toEqual([]);
});

test('touch recovery selects the original conversation without opening the soft keyboard', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 650 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    const fixture = await legacyRecovery(page, 'light');
    await expect(page.locator('#recovery-list input')).toHaveCount(1);
    await expect(page.locator('#recovery-more')).toBeHidden();
    await page.locator('#recovery-list input').tap();
    await expect(page.locator('#recovery-apply')).toBeEnabled();
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA');
    expect(fixture.mutations).toEqual([]);
    await page.screenshot({ path: '/tmp/webcc-v101-recovery-mobile.png' });
    await page.locator('#recovery-close').tap();
    expect(fixture.errors).toEqual([]);
  } finally { await context.close(); }
});

for (const theme of ['dark', 'light']) {
  for (const width of [320, 1440]) {
    test(`permission settings fit ${theme} ${width}px without native input`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await workspace(page, theme, { initial: { panes: ['demo02'], active: 'demo02' } });
      await page.locator('#btn-permissions').click();
      await expect(page.locator('#permissions-current')).toContainText('工作目录可写');
      await expect(page.locator('#permission-approval')).toHaveValue('on-request');
      await expect(page.locator('#permission-sandbox')).toHaveValue('workspace-write');
      const geometry = await page.locator('.permissions-box').evaluate(el => {
        const r = el.getBoundingClientRect();
        return { inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
          fit: [...el.querySelectorAll('select,button')].every(child => { const c = child.getBoundingClientRect(); return c.left >= r.left && c.right <= r.right; }),
          overflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(geometry).toEqual({ inside: true, fit: true, overflow: false });
      await expect(page.locator('#permissions-modal')).not.toHaveClass(/is-opening/);
      await page.screenshot({ path: `/tmp/webcc-v100-permissions-${theme}-${width}.png` });
      await page.locator('#permissions-close').click();
      await expect(page.locator('#permissions-modal')).toBeHidden();
      expect(fixture.requests.filter(r => r.method === 'POST' && r.path.startsWith('/api/sessions'))).toEqual([]);
      expect(await page.evaluate(() => sent.filter(m => m.type === 'input'))).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  }
}

test('permission apply keeps the same terminal and websocket and posts once', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo02'], active: 'demo02' } });
  await page.evaluate(() => { window.permissionOriginal = { term: active.term, ws: active.ws, count: socketCount }; });
  await page.locator('#btn-permissions').click();
  await page.locator('#permission-approval').selectOption('never');
  await page.locator('#permissions-apply').click();
  await expect(page.locator('.ui-dialog-msg')).toContainText('12345678-1234-4234-8234-123456789abc');
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('#permissions-modal')).toBeHidden();
  const posts = fixture.requests.filter(r => r.method === 'POST' && r.path.endsWith('/restart'));
  expect(posts).toHaveLength(1);
  expect(posts[0].path).toBe('/api/sessions/demo02/restart');
  expect(posts[0].body).toMatchObject({ expected: 'permission-challenge-demo02', confirmed: true, confirmDangerous: false,
    permissions: { approval: 'never', sandbox: 'workspace-write' } });
  expect(await page.evaluate(() => active.term === permissionOriginal.term && active.ws === permissionOriginal.ws && socketCount === permissionOriginal.count)).toBe(true);
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('full access requires a second explicit confirmation', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo02'], active: 'demo02' } });
  await page.locator('#btn-permissions').click();
  await page.locator('#permission-sandbox').selectOption('danger-full-access');
  await expect(page.locator('#permissions-note')).toHaveClass('warning');
  await page.locator('#permissions-apply').click();
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('.ui-dialog-title')).toContainText('确认高风险权限');
  expect(fixture.requests.filter(r => r.method === 'POST' && r.path.startsWith('/api/sessions'))).toEqual([]);
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('#permissions-modal')).toBeHidden();
  expect(fixture.requests.filter(r => r.path.endsWith('/restart'))[0].body.confirmDangerous).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test('cancelling a permission change never posts or sends native input', async ({ page }) => {
  const fixture = await workspace(page, 'light', { initial: { panes: ['demo03'], active: 'demo03' } });
  await page.locator('#btn-permissions').click();
  await page.locator('#permission-mode').selectOption('dontAsk');
  await page.locator('#permissions-apply').click();
  await page.locator('.ui-dialog .ui-btn').first().click();
  await expect(page.locator('.ui-dialog')).toHaveCount(0);
  await expect(page.locator('#permissions-apply')).toBeEnabled();
  expect(fixture.requests.filter(r => r.method === 'POST' && r.path.startsWith('/api/sessions'))).toEqual([]);
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input'))).toEqual([]);
});

test('switching active pane during permission confirmation cancels mutation', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo02', 'demo03'], active: 'demo02' } });
  await page.locator('#btn-permissions').click();
  await page.locator('#permission-approval').selectOption('never');
  await page.locator('#permissions-apply').click();
  await page.evaluate(() => focusPane(panes.find(p => p.tab.id === 'demo03'), false));
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('.ui-dialog')).toHaveCount(0);
  expect(fixture.requests.filter(r => r.method === 'POST' && r.path.startsWith('/api/sessions'))).toEqual([]);
  await expect(page.locator('#permissions-apply')).toBeDisabled();
});

test('unsupported OpenCode permission overrides are disabled', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo04'], active: 'demo04' } });
  await page.locator('#btn-permissions').click();
  await expect(page.locator('#permissions-note')).toContainText('暂不在网页中覆盖');
  await expect(page.locator('#permissions-apply')).toBeDisabled();
  expect(fixture.requests.filter(r => r.method === 'POST' && r.path.startsWith('/api/sessions'))).toEqual([]);
});

test('uncertain permission response is not retried and requires reading fresh state', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo02'], active: 'demo02' }, permissionFailure: true });
  await page.locator('#btn-permissions').click();
  await page.locator('#permission-approval').selectOption('never');
  await page.locator('#permissions-apply').click();
  await page.locator('.ui-dialog .primary').click();
  await expect(page.locator('#permissions-note')).toContainText('不会自动重试');
  await expect(page.locator('#permissions-apply')).toBeDisabled();
  expect(fixture.requests.filter(r => r.method === 'POST' && r.path.startsWith('/api/sessions'))).toHaveLength(1);
  await page.locator('#permissions-refresh').click();
  await expect(page.locator('#permission-approval')).toHaveValue('on-request');
  expect(fixture.errors).toEqual([]);
});

for (const theme of ['dark', 'light']) {
  for (const width of [320, 390, 821, 1024, 1440]) {
    test(`quota battery fits ${theme} ${width}px toolbar without a terminal shelf`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await workspace(page, theme, { initial: { panes: ['demo02'], active: 'demo02' } });
      const quota = page.locator('.quota-battery:visible');
      await expect(quota.locator('.quota-battery-value')).toHaveText('73%');
      await expect(quota.locator('.quota-battery-reset')).toHaveText('4d21h后重置');
      await expect(page.locator('.quota-battery:visible')).toHaveCount(1);
      await expect(page.locator('.codex-usage,[role="progressbar"]')).toHaveCount(0);
      const geometry = await quota.evaluate(el => {
        const r = el.getBoundingClientRect();
        const host = document.querySelector('.pane-host').getBoundingClientRect();
        const pane = document.querySelector('.pane').getBoundingClientRect();
        return { inside: r.left >= 0 && r.right <= innerWidth && r.bottom <= host.top,
          contentsFit: [...el.querySelectorAll('span')].every(child => {
            const c = child.getBoundingClientRect();
            return c.left >= r.left && c.right <= r.right && c.top >= r.top && c.bottom <= r.bottom;
          }), bottomGap: pane.bottom - host.bottom, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(geometry.inside).toBe(true);
      expect(geometry.contentsFit).toBe(true);
      expect(geometry.bottomGap).toBeLessThanOrEqual(1);
      expect(geometry.overflow).toBe(false);
      const before = await page.locator('#panes').boundingBox();
      await quota.click();
      await expect(page.locator('#toast')).toContainText('4d21h后重置');
      expect(await page.locator('#panes').boundingBox()).toEqual(before);
      expect(fixture.requests.filter(r => r.path === '/api/codex/usage')).toHaveLength(1);
      expect(await page.evaluate(() => sent.filter(m => m.type === 'input'))).toEqual([]);
      if ([390, 1440].includes(width)) await page.screenshot({ path: `/tmp/webcc-v99-quota-${theme}-${width}.png` });
      expect(fixture.errors).toEqual([]);
    });
  }
}

test('quota battery thresholds and missing values keep stable geometry', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo02'], active: 'demo02' } });
  await expect(page.locator('#codex-quota .quota-battery-value')).toHaveText('73%');
  const box = await page.locator('#codex-quota').boundingBox();
  for (const [raw, expected, tone] of [[100, '100%', ''], [55.5, '55.5%', ''], [30, '30%', 'warning'], [10, '10%', 'critical'],
    [0, '0%', 'critical'], [-2, '0%', 'critical'], [120, '100%', ''], [null, '--', ''], ['', '--', ''], ['oops', '--', ''], [false, '--', '']]) {
    await page.evaluate(raw => { codexUsageData.window.remainingPercent = raw; renderAllCodexUsage(); }, raw);
    await expect(page.locator('#codex-quota .quota-battery-value')).toHaveText(expected);
    expect(await page.locator('#codex-quota').evaluate(el => el.classList.contains('warning') ? 'warning' : el.classList.contains('critical') ? 'critical' : '')).toBe(tone);
    expect(await page.locator('#codex-quota').boundingBox()).toEqual(box);
  }
  expect(fixture.requests.filter(r => r.path === '/api/codex/usage')).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test('quota battery countdown rounds hours and handles missing or expired resets', async ({ page }) => {
  await workspace(page);
  const labels = await page.evaluate(() => {
    const now = Date.now(), original = Date.now;
    Date.now = () => now;
    try { return [null, 0, 'bad', (now - 1000) / 1000, (now + 1000) / 1000, (now + 25 * 3600000) / 1000,
      (now + 4 * 86400000 + 21 * 3600000) / 1000].map(at => codexResetLabel(at).short); }
    finally { Date.now = original; }
  });
  expect(labels).toEqual(['重置时间未知', '重置时间未知', '重置时间未知', '等待刷新', '0d1h后重置', '1d1h后重置', '4d21h后重置']);
});

test('quota battery countdown repaints locally without requests or terminal resize', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo02'], active: 'demo02' } });
  await expect(page.locator('#codex-quota .quota-battery-value')).toHaveText('73%');
  await page.clock.install();
  await page.evaluate(() => {
    codexUsageData.window.resetsAt = Date.now() / 1000 + 25 * 3600 + 30;
    renderAllCodexUsage(); window.quotaResizeCount = sent.filter(m => m.type === 'resize').length;
  });
  await expect(page.locator('.quota-battery:visible .quota-battery-reset')).toHaveText('1d2h后重置');
  const box = await page.locator('#panes').boundingBox();
  await page.clock.fastForward(61000);
  await expect(page.locator('.quota-battery:visible .quota-battery-reset')).toHaveText('1d1h后重置');
  expect(await page.locator('#panes').boundingBox()).toEqual(box);
  expect(await page.evaluate(() => sent.filter(m => m.type === 'resize').length)).toBe(await page.evaluate(() => quotaResizeCount));
  expect(fixture.requests.filter(r => r.path === '/api/codex/usage')).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test('quota battery shares one cached request across Codex panes and hides for other tools', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo02', 'demo03'], active: 'demo02' },
    extraTabs: [{ id: 'demo05', name: 'Other Codex', cwd: '/workspace/demo', type: 'codex', alive: true }] });
  await expect(page.locator('#codex-quota .quota-battery-value')).toHaveText('73%');
  await page.evaluate(() => { attachTerminal(state.tabs.find(t => t.id === 'demo05'), makePane()); });
  await page.waitForFunction(() => panes.length === 3 && panes.every(p => p.ws?.readyState === 1));
  for (const id of ['demo03', 'demo02', 'demo05', 'demo03', 'demo05']) {
    await page.evaluate(id => focusPane(panes.find(p => p.tab.id === id), false), id);
    await expect(page.locator('.quota-battery:visible')).toHaveCount(id === 'demo03' ? 0 : 1);
  }
  await page.locator('#codex-quota').hover();
  await expect(page.locator('#tooltip')).toContainText('后重置');
  for (let n = 0; n < 3; n++) await page.locator('#codex-quota').click();
  expect(fixture.requests.filter(r => r.path === '/api/codex/usage')).toHaveLength(1);
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input'))).toEqual([]);
  const identity = await page.evaluate(() => { window.quotaTerms = panes.map(p => p.term); return socketCount; });
  await page.locator('#btn-tools').click();
  await expect(page.locator('#codex-quota')).toBeVisible();
  expect(await page.evaluate(() => socketCount)).toBe(identity);
  expect(await page.evaluate(() => panes.every((p, i) => p.term === quotaTerms[i]))).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test('quota battery loading and late response cannot appear on a different tool', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo01', 'demo02'], active: 'demo01' }, usageDelay: 800 });
  expect(fixture.requests.filter(r => r.path === '/api/codex/usage')).toHaveLength(1); // The restored Codex is mounted once.
  await page.evaluate(() => focusPane(panes.find(p => p.tab.id === 'demo02'), false));
  await expect(page.locator('#codex-quota')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#codex-quota .quota-battery-value')).toHaveText('--');
  await page.evaluate(() => focusPane(panes.find(p => p.tab.id === 'demo01'), false));
  await expect.poll(() => page.evaluate(() => !!codexUsageData)).toBe(true);
  await expect(page.locator('.quota-battery:visible')).toHaveCount(0);
  expect(fixture.requests.filter(r => r.path === '/api/codex/usage')).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test('quota battery failure is unknown rather than zero and taps never retry the account', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo02'], active: 'demo02' }, usageError: true });
  await expect(page.locator('#codex-quota')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#codex-quota .quota-battery-value')).toHaveText('--');
  await expect(page.locator('#codex-quota .quota-battery-reset')).toHaveText('暂不可用');
  for (const id of ['demo01', 'demo02', 'demo03', 'demo02']) {
    await page.evaluate(id => attachTerminal(state.tabs.find(t => t.id === id), active), id);
  }
  for (let i = 0; i < 3; i++) await page.locator('#codex-quota').click();
  await expect(page.locator('#toast')).toContainText('稍后自动重试');
  expect(fixture.requests.filter(r => r.path === '/api/codex/usage')).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test('quota battery marks cached failures and hides after closing all panes', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo02'], active: 'demo02' },
    usage: { window: { remainingPercent: 58, resetsAt: Date.now() / 1000 + 7200 }, stale: true, error: true, nextRefreshAt: Date.now() / 1000 + 600 } });
  await expect(page.locator('#codex-quota .quota-battery-value')).toHaveText('58%');
  await expect(page.locator('#codex-quota')).toHaveClass(/is-stale/);
  await expect(page.locator('#codex-quota')).toHaveAttribute('aria-label', /缓存数据/);
  await page.evaluate(() => closeActiveView());
  await expect(page.locator('.quota-battery:visible')).toHaveCount(0);
  expect(await page.evaluate(() => [codexUsageClock, codexUsageTimer])).toEqual([null, null]);
  expect(fixture.errors).toEqual([]);
});

test('quota battery pauses countdown and account timers for a hidden page', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo02'], active: 'demo02' } });
  await expect(page.locator('#codex-quota .quota-battery-value')).toHaveText('73%');
  await page.clock.install();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await page.evaluate(() => [codexUsageClock, codexUsageTimer])).toEqual([null, null]);
  await page.clock.fastForward(11 * 60000);
  expect(fixture.requests.filter(r => r.path === '/api/codex/usage')).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

for (const media of [{ forcedColors: 'active' }, { reducedMotion: 'reduce' }]) {
  test(`quota battery supports keyboard activation with ${Object.keys(media)[0]}`, async ({ page }) => {
    await page.emulateMedia(media);
    const fixture = await workspace(page, 'dark', { initial: { panes: ['demo02'], active: 'demo02' } });
    const quota = page.locator('#codex-quota');
    await expect(quota.locator('.quota-battery-value')).toHaveText('73%');
    await quota.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#toast')).toContainText('后重置');
    await expect(quota).toBeFocused();
    expect(fixture.requests.filter(r => r.path === '/api/codex/usage')).toHaveLength(1);
    expect(await page.evaluate(() => sent.filter(m => m.type === 'input'))).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

for (const type of ['codex', 'claude', 'opencode', 'shell']) {
  test(`split picker creates ${type} without replacing existing terminals`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await workspace(page, 'dark', { initial: { panes: ['demo01', 'demo02'], active: 'demo01' } });
    await page.evaluate(() => { window.kept = panes.map(p => ({ p, term: p.term, ws: p.ws })); });
    await page.locator('#header-split:visible, #btn-split:visible').first().click();
    await page.locator('#ws-split-directions button[data-direction="col"]').click();
    await page.locator('#ws-split-search').fill('no match');
    await expect(page.locator('.ws-split-empty')).toBeVisible();
    await page.locator('#ws-split-create').click();
    await expect(page.locator('#dir-current')).toHaveText('/workspace/demo');
    await page.locator('#dir-list .dir-row').filter({ hasText: 'src' }).click();
    await expect(page.locator('#dir-current')).toHaveText('/workspace/demo/src');
    await page.locator(`.mode-btn[data-type="${type}"][data-mode="new"]`).click();
    await expect(page.locator('#ws-split-modal')).toBeVisible();
    await expect(page.locator('#ws-split-list input[data-session="new001"]')).toBeChecked();
    await expect(page.locator('#ws-split-state')).toHaveText('3 / 4');
    await expect(page.locator('#dir-modal')).toBeHidden();
    await expect(page.locator('#ws-split-modal')).not.toHaveClass(/is-opening/);
    await expect(page.locator('#ws-split-apply')).toBeFocused();
    await expect(page.locator('#ws-split-directions button[data-direction="col"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo02']);
    expect(fixture.requests.filter(r => r.path === '/api/sessions' && r.method === 'POST').map(r => r.body)).toEqual([{ cwd: '/workspace/demo/src', type, mode: 'new' }]);
    await page.locator('#ws-split-apply').click();
    await expect(page.locator('.pane')).toHaveCount(3);
    await expect(page.locator('#ws-split-modal')).toBeHidden();
    expect(await page.evaluate(() => kept.every(k => panes.includes(k.p) && k.p.term === k.term && k.p.ws === k.ws))).toBe(true);
    expect(await page.evaluate(() => sent.filter(item => item.type === 'input'))).toEqual([]);
    expect(fixture.requests.filter(r => /\/(stop|restart|start)$/.test(r.path))).toEqual([]);
    expect(fixture.errors).toEqual([]);
    if (type === 'codex') await page.screenshot({ path: '/tmp/webcc-v98-created-split-1440.png' });
  });
}

for (const cancel of ['close', 'escape', 'backdrop']) {
  test(`split creation ${cancel} preserves pending selection and normal creation`, async ({ page }) => {
    const fixture = await workspace(page);
    await page.locator('#header-split:visible, #btn-split:visible').first().click();
    await page.locator('#ws-split-list input[data-session="demo03"]').check();
    await page.locator('#ws-split-search').fill('Claude');
    await page.locator('#ws-split-create').click();
    await expect(page.locator('#dir-modal')).toBeVisible();
    if (cancel === 'close') await page.locator('#dir-close').click();
    else if (cancel === 'escape') await page.keyboard.press('Escape');
    else await page.locator('#dir-modal').click({ position: { x: 3, y: 3 } });
    await expect(page.locator('#ws-split-modal')).toBeVisible();
    await expect(page.locator('#ws-split-search')).toHaveValue('Claude');
    await expect(page.locator('#ws-split-state')).toHaveText('2 / 4');
    expect(fixture.requests.filter(r => r.path === '/api/sessions' && r.method === 'POST')).toEqual([]);
    await page.locator('#ws-split-close button').click();
    await page.locator('#header-new').click();
    await page.locator('.mode-btn[data-type="shell"]').click();
    await expect.poll(() => page.evaluate(() => active.tab.id)).toBe('new001');
    await expect(page.locator('.pane')).toHaveCount(1);
    expect(fixture.errors).toEqual([]);
  });
}

test('failed split creation stays retryable without changing panes', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { failCreation: true });
  await page.evaluate(() => { window.oldTerm = active.term; window.oldSocket = active.ws; });
  await page.locator('#header-split:visible, #btn-split:visible').first().click();
  await page.locator('#ws-split-create').click();
  await page.locator('#mode-codex').click();
  await expect(page.locator('#toast')).toContainText('Create failed safely');
  await expect(page.locator('#mode-codex')).toBeEnabled();
  await expect(page.locator('#dir-modal')).toBeVisible();
  expect(await page.evaluate(() => active.term === oldTerm && active.ws === oldSocket)).toBe(true);
  await page.locator('#dir-close').click();
  await expect(page.locator('#ws-split-modal')).toBeVisible();
  await expect(page.locator('#ws-split-state')).toHaveText('1 / 4');
  expect(fixture.errors).toEqual([]);
});

test('slow split creation prevents duplicate starts and dismissing an in-flight request', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { createDelay: 800 });
  await page.locator('#header-split:visible, #btn-split:visible').first().click();
  await page.locator('#ws-split-create').click();
  await page.locator('#mode-codex').click();
  await expect(page.locator('#mode-codex')).toBeDisabled();
  await page.locator('#dir-close').click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.getElementById('mode-codex').onclick());
  await expect(page.locator('#ws-split-list input[data-session="new001"]')).toBeChecked();
  expect(fixture.requests.filter(r => r.path === '/api/sessions' && r.method === 'POST')).toHaveLength(1);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  expect(fixture.errors).toEqual([]);
});

for (const width of [390, 1440]) {
  test(`full split creation preserves all selected windows at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const ids = width === 390 ? ['demo01'] : ['demo01', 'demo02', 'demo03', 'demo04'];
    const fixture = await workspace(page, 'light', { initial: { panes: ids, active: 'demo01' } });
    await page.locator('#header-split:visible, #btn-split:visible').first().click();
    await page.locator('#ws-split-create').click();
    await page.locator('.mode-btn[data-type="shell"]').click();
    await expect(page.locator('#ws-split-list input[data-session="new001"]')).not.toBeChecked();
    await expect(page.locator('#toast')).toContainText('分屏已满');
    expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(ids);
    await expect(page.locator('#ws-split-state')).toHaveText(`${ids.length} / ${ids.length}`);
    expect(fixture.errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.locator('#ws-split-modal')).not.toHaveClass(/is-opening/);
    await expect(page.locator('#toast')).toBeHidden();
    await page.screenshot({ path: `/tmp/webcc-v98-split-picker-${width}.png` });
  });

  test(`toolbar copies the focused session ID at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await workspace(page);
    await page.evaluate(() => {
      window.copiedIds = [];
      document.execCommand = command => { if (command === 'copy') copiedIds.push(document.activeElement.value); return true; };
    });
    await expect(page.locator('#btn-copy-session-id svg')).toHaveCount(1);
    await page.locator('#btn-copy-session-id').click();
    await expect.poll(() => page.evaluate(() => copiedIds)).toEqual(['cc_demo01']);
    await expect(page.locator('#toast')).toContainText('网页窗口 ID');
    await page.evaluate(() => attachTerminal(state.tabs.find(tab => tab.id === 'demo03')));
    await expect.poll(() => page.locator('#btn-copy-session-id').evaluate(button => button.title || button.dataset.tooltip)).toBe('复制会话 ID');
    await page.locator('#btn-copy-session-id').click();
    await expect.poll(() => page.evaluate(() => copiedIds)).toEqual(['cc_demo01', '12345678-1234-4234-8234-123456789abc']);
    expect(await page.evaluate(() => sent.filter(item => item.type === 'input'))).toEqual([]);
    expect(fixture.requests.filter(r => r.method === 'POST' && r.path !== '/api/presence')).toEqual([]);
    await page.evaluate(() => { active.tab = null; updateCopySessionIdControl(); });
    await expect(page.locator('#btn-copy-session-id')).toBeDisabled();
    expect(fixture.errors).toEqual([]);
  });
}

test('clipboard failure never writes an ID into the terminal', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(() => { document.execCommand = () => false; });
  await page.locator('#btn-copy-session-id').click();
  await expect(page.locator('#toast')).toContainText('复制失败');
  expect(await page.evaluate(() => sent.filter(item => item.type === 'input'))).toEqual([]);
  await expect(page.locator('#btn-copy-session-id')).toBeEnabled();
  expect(fixture.errors).toEqual([]);
});

test('copy session ID captures its target across an asynchronous clipboard write', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(() => {
    window.copiedIds = [];
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: text => { copiedIds.push(text); return new Promise(resolve => { window.finishCopy = resolve; }); },
    } });
  });
  await page.locator('#btn-copy-session-id').click();
  await expect(page.locator('#btn-copy-session-id')).toBeDisabled();
  await page.waitForFunction(() => window.finishCopy);
  await page.evaluate(() => { attachTerminal(state.tabs.find(tab => tab.id === 'demo03')); finishCopy(); });
  await expect(page.locator('#btn-copy-session-id')).toBeEnabled();
  await expect.poll(() => page.locator('#btn-copy-session-id').evaluate(button => button.title || button.dataset.tooltip)).toBe('复制会话 ID');
  expect(await page.evaluate(() => copiedIds)).toEqual(['cc_demo01']);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo03');
  expect(await page.evaluate(() => sent.filter(item => item.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('device change during split creation never inserts a session into another layout', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await workspace(page, 'dark', { createDelay: 1000 });
  await page.locator('#header-split:visible, #btn-split:visible').first().click();
  await page.locator('#ws-split-create').click();
  await page.locator('#mode-codex').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => state.tabs.some(tab => tab.id === 'new001'))).toBe(true);
  await expect(page.locator('#dir-modal')).toBeHidden();
  await expect(page.locator('#ws-split-modal')).toBeHidden();
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).not.toContain('new001');
  expect(fixture.requests.filter(r => r.path === '/api/sessions' && r.method === 'POST')).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test('failed directory load cannot create a split in the previous directory', async ({ page }) => {
  const fixture = await workspace(page);
  await page.locator('#header-new').click();
  await expect(page.locator('#mode-row')).toBeVisible();
  await page.locator('#dir-close').click();
  await page.route('**/api/fs?**', route => route.fulfill({ status: 403, json: { detail: 'Directory unavailable' } }));
  await page.locator('#header-split:visible, #btn-split:visible').first().click();
  await page.locator('#ws-split-create').click();
  await expect(page.locator('#dir-list')).toContainText('目录读取失败');
  await expect(page.locator('#mode-row')).toBeHidden();
  await page.evaluate(() => document.getElementById('mode-codex').onclick());
  expect(fixture.requests.filter(r => r.path === '/api/sessions' && r.method === 'POST')).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('lost creation response is not retried and cannot silently create duplicate terminals', async ({ page }) => {
  const fixture = await workspace(page);
  let attempts = 0;
  await page.route('**/api/sessions', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    attempts++;
    return route.abort('connectionreset');
  });
  await page.locator('#header-split:visible, #btn-split:visible').first().click();
  await page.locator('#ws-split-create').click();
  await page.locator('#mode-codex').click();
  await expect(page.locator('#toast')).toContainText('创建结果未确认');
  await expect(page.locator('#mode-codex')).toBeEnabled();
  await page.waitForTimeout(1500);
  expect(attempts).toBe(1);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  expect(fixture.errors).toEqual([]);
});

test('late terminal connection and focus timers leave form editing alone', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(() => {
    attachTerminal(state.tabs.find(tab => tab.id === 'demo02'));
    const input = document.createElement('input'); input.id = 'focus-field'; input.value = 'keep editing';
    document.body.append(input); input.focus(); input.select();
  });
  await page.waitForTimeout(180);
  await expect(page.locator('#focus-field')).toBeFocused();
  expect(await page.evaluate(() => document.activeElement.selectionEnd - document.activeElement.selectionStart)).toBe(12);
  expect(await page.evaluate(() => sent.filter(item => item.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const theme of ['dark', 'light']) {
  for (const width of [320, 390, 820, 1024, 1440, 1920, 3440]) {
    test(`${theme} workspace fits ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await workspace(page, theme);
      await expect(page.locator('.ws-workspace')).toHaveCount(2);
      await expect(page.locator('.ws-tab')).toHaveCount(0);
      await expect(page.locator('[data-group="ws_demo"] .ws-session')).toHaveCount(3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const terminal = await page.locator('.pane-host').boundingBox();
      expect(terminal.width).toBeGreaterThan(200);
      expect(terminal.x).toBeGreaterThanOrEqual(0);
      expect(terminal.x + terminal.width).toBeLessThanOrEqual(width + 1);
      expect(terminal.y + terminal.height).toBeLessThanOrEqual(900);
      expect(await page.locator('.aux-primary .keycap').evaluateAll(keys => keys.flatMap(key => {
        const box = key.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth + 1 && box.top >= 0 && box.bottom <= innerHeight + 1 ? [] : [box.toJSON()];
      }))).toEqual([]);
      if (width >= 1280) await expect(page.locator('#ws-deck')).toBeVisible();
      else if (width <= 820) await expect(page.locator('#ws-deck')).toBeHidden();
      expect(await page.evaluate(() => active.term.buffer.active.getLine(0).translateToString())).toContain('API workspace');
      expect(await page.evaluate(() => {
        const canvases = [...document.querySelectorAll('.xterm-screen canvas')];
        return !canvases.length || canvases.some(canvas => {
          const context = canvas.getContext('2d');
          if (!context) return true;
          const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let painted = 0;
          for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
          return painted > 30;
        });
      })).toBe(true);
      expect(fixture.errors).toEqual([]);
      if ([390, 1440].includes(width)) await page.screenshot({ path: `/tmp/webcc-v89-workspace-${theme}-${width}.png` });
    });
  }
}

test('workspaces filter sessions without changing independent splits or sockets', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await workspace(page);
  await page.locator('#header-split').click();
  await page.locator('#ws-split-list input[data-session="demo02"]').check();
  await page.locator('#ws-split-apply').click();
  await page.evaluate(() => ccWorkspace.persist());
  await expect(page.locator('.pane')).toHaveCount(2);
  await page.evaluate(() => { window.kept = panes.map(p => ({ pane: p, term: p.term, ws: p.ws })); });
  await page.locator('.ws-workspace[data-workspace="ws_tools"]').click();
  await expect(page.locator('[data-workspace="ws_tools"]')).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => kept.every(p => panes.includes(p.pane) && p.pane.term === p.term && p.pane.ws === p.ws))).toBe(true);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  await page.locator('.ws-workspace[data-workspace="ws_demo"]').click();
  await expect(page.locator('.pane')).toHaveCount(2);
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo02']);
  await page.reload();
  await page.waitForFunction(() => ccWorkspace?.ready && panes.length === 2);
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo02']);
  expect(fixture.requests.filter(request => request.path.startsWith('/api/sessions') && request.method !== 'GET')).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('Fleet attention opens the exact session without switching workspace or sending approval', async ({ page }) => {
  const fixture = await workspace(page);
  await expect(page.locator('#ws-attention')).toHaveText('1 需要处理');
  await page.locator('#ws-attention').click();
  await expect(page.locator('.ws-workspace[data-workspace="ws_demo"]')).toHaveAttribute('aria-current', 'true');
  expect(await page.evaluate(() => active.tab.id)).toBe('demo03');
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('file editing detects conflicts and Git diff is real read-only API output', async ({ page }) => {
  const fixture = await workspace(page);
  await page.locator('[data-panel="files"]').click();
  await page.locator('.ws-row[data-file="/workspace/demo/index.js"]').click();
  await expect(page.locator('#ws-editor-text')).toHaveValue('export const answer = 42;\n');
  await page.locator('#ws-editor-text').fill('export const answer = 43;\n');
  await page.getByRole('button', { name: '保存文件', exact: true }).click();
  await expect(page.locator('#ws-editor-state')).toHaveText('UTF-8 · 已保存');
  await page.screenshot({ path: '/tmp/webcc-v89-files.png' });
  fixture.changeFile();
  await page.locator('#ws-editor-text').fill('changed');
  await page.getByRole('button', { name: '保存文件', exact: true }).click();
  await expect(page.locator('#ws-editor-state')).toContainText('another editor');
  await page.locator('[data-panel="git"]').click();
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await page.locator('.ws-row', { hasText: 'index.js' }).click();
  await expect(page.locator('.ws-diff')).toContainText('+new');
  await page.screenshot({ path: '/tmp/webcc-v89-git.png' });
  expect(fixture.errors).toEqual([]);
});

test('history search and command palette never send terminal input', async ({ page }) => {
  const fixture = await workspace(page);
  await page.locator('#ws-history').click();
  await page.locator('#ws-history-input').fill('PASS');
  await page.locator('#ws-history-input').press('Enter');
  await expect(page.locator('.ws-search-hit')).toContainText('PASS terminal history');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+P');
  await page.locator('#ws-palette-input').fill('Tools');
  await page.locator('#ws-palette-input').press('Enter');
  await expect(page.locator('.ws-workspace[data-workspace="ws_tools"]')).toHaveAttribute('aria-current', 'true');
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('mobile task drawer leaves native terminal and recent sessions accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await workspace(page);
  const before = await page.locator('.pane-host').boundingBox();
  await page.locator('#ws-mobile-deck').click();
  await expect(page.locator('#ws-deck')).toBeVisible();
  expect(await page.locator('.pane-host').boundingBox()).toEqual(before);
  await page.locator('#ws-fleet-all').click();
  await page.screenshot({ path: '/tmp/webcc-v89-mobile-tasks.png' });
  await page.locator('.ws-agent[data-session="demo03"]').getByRole('button', { name: '打开会话', exact: true }).click();
  await expect(page.locator('#ws-deck')).toBeHidden();
  await expect(page.locator('.pane')).toHaveCount(1);
  await page.locator('#recent-toggle').click();
  await expect(page.locator('#recent-sessions')).toBeVisible();
  expect(fixture.errors).toEqual([]);
});

test('workspace layout conflicts retain visible terminals and never overwrite another window', async ({ page }) => {
  const fixture = await workspace(page);
  await page.route('**/api/layouts/*', async route => {
    if (route.request().method() === 'PUT') return route.fulfill({ status: 409, json: { detail: 'Layout changed in another window' } });
    return route.fallback();
  });
  await page.evaluate(() => { window.kept = { pane: active, term: active.term, ws: active.ws }; });
  await page.evaluate(() => splitPane());
  expect(await page.evaluate(() => ccWorkspace.persist())).toBe(false);
  await expect(page.locator('#ws-save-indicator')).toContainText('可保存当前布局副本');
  await page.locator('.ws-workspace[data-workspace="ws_tools"]').click();
  await expect(page.locator('.ws-workspace[data-workspace="ws_tools"]')).toHaveAttribute('aria-current', 'true');
  expect(await page.evaluate(() => panes.includes(kept.pane) && kept.pane.term === kept.term && kept.pane.ws === kept.ws)).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cc_workspace_recovery')).layout.panes)).toEqual(['demo01', null]);
  expect(fixture.errors).toEqual([]);
});

test('Codex wheel in the new workspace stays pane-bound and does not type arrows', async ({ page }) => {
  const fixture = await workspace(page);
  await page.locator('.ws-session[data-session="demo02"] .ws-session-open').click();
  await page.waitForFunction(() => active?.tab?.id === 'demo02' && active?.ws?.readyState === 1);
  await page.evaluate(() => { window.sent = []; });
  await page.locator('.pane-host').hover();
  await page.mouse.wheel(0, -140);
  await expect.poll(() => page.evaluate(() => sent.filter(msg => msg.type === 'scroll').length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'scroll').every(msg => msg.socket.endsWith('/demo02') && msg.lines < 0))).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test('mobile native quick commands keep their one-tap controls and do not submit', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage(), fixture = await workspace(page);
    await page.locator('#hamburger').tap();
    await page.locator('.ws-session[data-session="demo02"] .ws-session-open').tap();
    await page.waitForFunction(() => active?.tab?.id === 'demo02' && active?.ws?.readyState === 1);
    await page.locator('#cap-commands').tap();
    await expect(page.locator('#quick-commands')).toBeVisible();
    await page.locator('.quick-command-row', { hasText: '/model' }).tap();
    await expect.poll(() => page.evaluate(() => sent.filter(msg => msg.type === 'input').length)).toBe(1);
    expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input')[0].data)).toBe('/model');
    expect(fixture.errors).toEqual([]);
  } finally { await context.close(); }
});

test('slow terminal listing cannot initialize an empty workspace over live sessions', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { slowSessions: true });
  await expect(page.locator('.pane')).toHaveCount(1);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  expect(await page.evaluate(() => active.term.buffer.active.getLine(0).translateToString())).toContain('API workspace');
  expect(fixture.requests.findIndex(request => request.path === '/api/workspaces')).toBeGreaterThan(fixture.requests.findIndex(request => request.path === '/api/sessions'));
  expect(fixture.errors).toEqual([]);
});

async function chooseSplits(page, ids) {
  await page.locator('#header-split').click();
  await expect(page.locator('#ws-split-modal')).toBeVisible();
  for (const checkbox of await page.locator('#ws-split-list input[type="checkbox"]').all()) {
    if (!ids.includes(await checkbox.getAttribute('data-session'))) await checkbox.uncheck();
  }
  for (const id of ids) await page.locator(`#ws-split-list input[data-session="${id}"]`).check();
  await page.locator('#ws-split-apply').click();
  await expect(page.locator('#ws-split-modal')).toBeHidden();
  await expect(treeOpen(page, ids[0])).toBeEnabled({ timeout: 1000 });
}

async function assertTiled(page) {
  await expect.poll(() => page.evaluate(() => {
    const grid = document.getElementById('panes'), box = grid.getBoundingClientRect(), css = getComputedStyle(grid);
    const left = box.left + parseFloat(css.paddingLeft), right = box.right - parseFloat(css.paddingRight);
    const top = box.top + parseFloat(css.paddingTop), bottom = box.bottom - parseFloat(css.paddingBottom);
    const width = right - left, height = bottom - top, shape = gridShape();
    const cells = panes.filter(p => !maximizedPane || p === maximizedPane).map(p => p.el.getBoundingClientRect());
    if (!cells.length || width <= 0 || height <= 0) return false;
    if (cells.some(r => r.width <= 0 || r.height <= 0 || r.left < left - 1 || r.right > right + 1 || r.top < top - 1 || r.bottom > bottom + 1)) return false;
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j];
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) return false;
    }
    const gaps = (shape.cols - 1) * height * (parseFloat(css.columnGap) || 0) + (shape.rows - 1) * width * (parseFloat(css.rowGap) || 0);
    return cells.reduce((area, r) => area + r.width * r.height, 0) >= width * height - gaps - width - height;
  })).toBe(true);
}

test('three-pane tiling fills the grid after reassignment with existing dividers and swap', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await workspace(page);
  await chooseSplits(page, ['demo01', 'demo02']);
  await expect(page.locator('.gutter.v')).toHaveCount(1);
  await page.evaluate(() => { window.originals = panes.map(p => ({ pane: p, term: p.term, ws: p.ws })); });
  await chooseSplits(page, ['demo01', 'demo02', 'demo03']);
  await expect(page.locator('#panes')).toHaveAttribute('data-eff', 'row');
  expect(await page.evaluate(() => document.querySelector('#panes').firstElementChild.classList.contains('gutter'))).toBe(true);
  await assertTiled(page);
  expect(await page.evaluate(() => originals.every(o => panes.includes(o.pane) && o.pane.term === o.term && o.pane.ws === o.ws))).toBe(true);
  await page.evaluate(() => swapPanes(0, 2));
  await assertTiled(page);
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo03', 'demo02', 'demo01']);
  expect(await page.evaluate(() => originals.every(o => o.pane.term === o.term && o.pane.ws === o.ws))).toBe(true);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('pane tiling remains complete through four-to-three, reorder, direction, maximize and resize', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await workspace(page);
  await chooseSplits(page, ['demo01', 'demo02', 'demo03', 'demo04']); await assertTiled(page);
  await page.evaluate(() => { window.keptTiling = panes.slice(0, 3).map(p => ({ pane: p, term: p.term, ws: p.ws })); });
  await chooseSplits(page, ['demo01', 'demo02', 'demo03']); await assertTiled(page);
  await chooseSplits(page, ['demo01', 'demo02', 'demo03']); await assertTiled(page);
  await page.evaluate(() => swapPanes(0, 1)); await assertTiled(page);
  for (const direction of ['col', 'row', 'auto']) {
    await page.evaluate(direction => { localStorage.setItem('cc_pane_dir', direction); applyPaneDir(); refitAll(); }, direction);
    await assertTiled(page);
  }
  for (const index of [0, 1, 2]) {
    await page.evaluate(index => togglePaneMaximized(panes[index]), index); await assertTiled(page);
    await expect(page.locator('.pane:visible')).toHaveCount(1);
    await page.evaluate(index => togglePaneMaximized(panes[index]), index); await assertTiled(page);
  }
  await page.setViewportSize({ width: 950, height: 900 }); await expect(page.locator('#panes')).toHaveAttribute('data-eff', 'col'); await assertTiled(page);
  await page.setViewportSize({ width: 1920, height: 1080 }); await expect(page.locator('#panes')).toHaveAttribute('data-eff', 'row'); await assertTiled(page);
  expect(await page.evaluate(() => keptTiling.every(o => panes.includes(o.pane) && o.pane.term === o.term && o.pane.ws === o.ws))).toBe(true);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('three-pane tiling dividers stay on visible edges and keep nonuniform proportions', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await workspace(page);
  await chooseSplits(page, ['demo01', 'demo02']); await chooseSplits(page, ['demo01', 'demo02', 'demo03']);
  await page.evaluate(() => { gridFr = { cols: [3, 2], rows: [2, 1, 1, 1] }; applyGridTemplate(); refitAll(); });
  await assertTiled(page);
  const handles = await page.evaluate(() => {
    const left = panes[0].el.getBoundingClientRect(), upper = panes[1].el.getBoundingClientRect(), lower = panes[2].el.getBoundingClientRect();
    const vertical = document.querySelector('.gutter.v').getBoundingClientRect(), horizontal = document.querySelector('.gutter.h').getBoundingClientRect();
    return { horizontalLeft: horizontal.left, rightPaneLeft: upper.left, horizontalY: (horizontal.top + horizontal.bottom) / 2,
      gapY: (upper.bottom + lower.top) / 2, verticalX: (vertical.left + vertical.right) / 2, gapX: (left.right + upper.left) / 2,
      columnRatio: left.width / upper.width, rowRatio: upper.height / lower.height };
  });
  expect(Math.abs(handles.horizontalLeft - handles.rightPaneLeft)).toBeLessThan(1);
  expect(Math.abs(handles.horizontalY - handles.gapY)).toBeLessThan(1);
  expect(Math.abs(handles.verticalX - handles.gapX)).toBeLessThan(1);
  expect(handles.columnRatio).toBeCloseTo(1.5, 1); expect(handles.rowRatio).toBeCloseTo(2, 1);
  const divider = page.locator('.gutter.h'), box = await divider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 50, { steps: 5 }); await page.mouse.up();
  await assertTiled(page);
  expect(fixture.errors).toEqual([]);
});

for (const theme of ['dark', 'light']) {
  for (const width of [1024, 1440, 2560]) {
    test(`${theme} three-pane tiling restores without a vacant quadrant at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 960 });
      const fixture = await workspace(page, theme, { initial: { panes: ['demo01', 'demo02', 'demo03'], active: 'demo02', direction: 'row', ratios: { cols: [3, 2], rows: [2, 1, 1, 1] } } });
      await assertTiled(page);
      await page.evaluate(() => ccWorkspace.persist()); await page.reload();
      await page.waitForFunction(() => ccWorkspace?.ready && panes.length === 3);
      await assertTiled(page);
      expect(await page.evaluate(() => gridFr.cols)).toEqual([3, 2]);
      expect(await page.evaluate(() => gridFr.rows)).toEqual([2, 1, 1, 1]);
      expect(await page.evaluate(() => active.tab.id)).toBe('demo02');
      if (width === 1440) {
        await page.getByRole('button', { name: '收起任务面板', exact: true }).click();
        await page.evaluate(async () => { for (const pane of panes) await new Promise(resolve => pane.term.write(pane.tab.name + '\r\n\r\n\x1b[32mConnected\x1b[0m\r\n\r\n~/workspace $ ', resolve)); });
        await page.screenshot({ path: `/tmp/webcc-v95-three-pane-${theme}.png` });
      }
      expect(fixture.errors).toEqual([]);
    });
  }
}

test('legacy three-pane layout survives migration across different projects', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo01', 'demo02', 'demo03'], active: 'demo03', direction: 'col', ratios: { cols: [1, 3], rows: [1, 2, 3, 1] } } });
  await expect(page.locator('.pane')).toHaveCount(3);
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo02', 'demo03']);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo03');
  expect(await page.evaluate(() => paneDirMode())).toBe('col');
  expect(await page.evaluate(() => gridFr.cols)).toEqual([1, 3]);
  expect(await page.evaluate(() => socketCount)).toBe(3);
  await page.evaluate(() => ccWorkspace.persist());
  expect(Object.values(fixture.layouts).some(layout => layout.panes.join(',') === 'demo01,demo02,demo03')).toBe(true);
  await page.reload();
  await page.waitForFunction(() => ccWorkspace?.ready && panes.length === 3);
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo02', 'demo03']);
  expect(fixture.requests.filter(request => request.path.startsWith('/api/sessions') && request.method !== 'GET')).toEqual([]);
  expect(fixture.requests.filter(request => request.path.startsWith('/api/workspaces/') && request.method === 'PATCH')).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('three cross-project panes keep their terminal objects while workspace filters change', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await workspace(page);
  await page.evaluate(() => { window.original = { pane: active, term: active.term, ws: active.ws }; });
  await chooseSplits(page, ['demo01', 'demo02', 'demo03']);
  await expect(page.locator('.pane')).toHaveCount(3);
  await page.evaluate(async () => {
    for (const pane of panes) await new Promise(resolve => pane.term.write(pane.tab.name + '\r\n\r\n\x1b[32mReady\x1b[0m\r\n\r\n~/workspace $ ', resolve));
  });
  await page.screenshot({ path: '/tmp/webcc-v90-three-splits.png' });
  expect(await page.evaluate(() => panes[0] === original.pane && panes[0].term === original.term && panes[0].ws === original.ws)).toBe(true);
  await page.evaluate(() => { window.kept = panes.map(p => ({ pane: p, term: p.term, ws: p.ws })); });
  await page.locator('.ws-workspace[data-workspace="ws_tools"]').click();
  await page.locator('.ws-workspace[data-workspace="ws_demo"]').click();
  expect(await page.evaluate(() => kept.every(ref => panes.includes(ref.pane) && ref.pane.term === ref.term && ref.pane.ws === ref.ws))).toBe(true);
  await page.reload();
  await page.waitForFunction(() => ccWorkspace?.ready && panes.length === 3);
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo02', 'demo03']);
  expect(fixture.errors).toEqual([]);
});

for (const theme of ['dark', 'light']) {
  for (const width of [320, 390, 1024, 1440]) {
    test(`${theme} split picker fits ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const fixture = await workspace(page, theme);
      const trigger = page.locator(width <= 820 ? '#btn-split' : '#header-split');
      await trigger.scrollIntoViewIfNeeded(); await trigger.click();
      await expect(page.locator('#ws-split-modal')).toBeVisible();
      const box = await page.locator('.ws-split-box').boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      await expect(page.locator('#ws-split-state')).toHaveText(width <= 820 ? '1 / 1' : '1 / 4');
      if (width === 1440 && theme === 'dark') await page.screenshot({ path: '/tmp/webcc-v90-split-picker.png' });
      await page.keyboard.press('Escape');
      await expect(page.locator('#ws-split-modal')).toBeHidden();
      expect(fixture.errors).toEqual([]);
    });
  }
}

test('mobile single view never overwrites desktop three-pane layout', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await workspace(page);
  await chooseSplits(page, ['demo01', 'demo02', 'demo03']);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => panes.length === 1 && ccWorkspace?.ready);
  await page.locator('#recent-toggle').click();
  await page.locator('.recent-row[data-session-id="demo04"]').click();
  await page.waitForFunction(() => active?.tab?.id === 'demo04');
  await page.evaluate(() => ccWorkspace.persist());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => panes.length === 3);
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo02', 'demo03']);
  expect(Object.keys(fixture.layouts).some(key => key.includes('/desktop_'))).toBe(true);
  expect(Object.keys(fixture.layouts).some(key => key.includes('/mobile_'))).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test('split chooser supports four panes, limits selection, cancellation and replacing one view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await workspace(page, 'dark', { extraTabs: [{ id: 'demo05', name: 'Fifth', cwd: '/workspace/other', type: 'shell', alive: true }] });
  await chooseSplits(page, ['demo01', 'demo02', 'demo03', 'demo04']);
  await expect(page.locator('.pane')).toHaveCount(4);
  await expect(page.locator('#header-split')).toBeEnabled();
  await page.evaluate(() => { window.kept = panes.map(p => ({ pane: p, term: p.term, ws: p.ws })); });
  await page.locator('#header-split').click();
  await page.locator('#ws-split-list input[data-session="demo05"]').click();
  await expect(page.locator('#ws-split-list input[data-session="demo05"]')).not.toBeChecked();
  await expect(page.locator('#ws-split-state')).toHaveText('最多 4 个终端');
  await page.keyboard.press('Escape');
  await expect(page.locator('#ws-split-modal')).toBeHidden();
  expect(await page.evaluate(() => kept.every(ref => panes.includes(ref.pane) && ref.pane.term === ref.term && ref.pane.ws === ref.ws))).toBe(true);
  await chooseSplits(page, ['demo01', 'demo03', 'demo05']);
  await expect(page.locator('.pane')).toHaveCount(3);
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo03', 'demo05']);
  expect(fixture.requests.filter(request => request.path.startsWith('/api/sessions') && request.method !== 'GET')).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('deleting a workspace never closes or changes visible split sessions', async ({ page }) => {
  const fixture = await workspace(page);
  await chooseSplits(page, ['demo01', 'demo02', 'demo03']);
  await page.evaluate(() => { window.kept = panes.map(p => ({ pane: p, term: p.term, ws: p.ws })); });
  await page.locator('[data-panel="settings"]').click();
  await page.locator('.ws-setting', { hasText: '删除工作区' }).getByRole('button', { name: '删除', exact: true }).click();
  await page.locator('.ui-dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.locator('.ws-workspace:not([data-workspace="_unassigned"])')).toHaveCount(1);
  await expect(page.locator('[data-workspace="_unassigned"]')).toBeVisible();
  expect(await page.evaluate(() => kept.every(ref => panes.includes(ref.pane) && ref.pane.term === ref.term && ref.pane.ws === ref.ws))).toBe(true);
  await page.reload();
  await page.waitForFunction(() => ccWorkspace?.ready && panes.length === 3);
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo02', 'demo03']);
  expect(fixture.errors).toEqual([]);
});

test('pending split saves freeze selection and never send terminal commands', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(() => ccWorkspace.persist());
  await page.route('**/api/layouts/*', async route => {
    if (route.request().method() === 'PUT') await new Promise(resolve => setTimeout(resolve, 350));
    return route.fallback();
  });
  await page.locator('#header-split').click();
  await page.locator('#ws-split-list input[data-session="demo02"]').check();
  await page.locator('#ws-split-apply').click();
  await expect(page.locator('#ws-split-apply')).toBeDisabled();
  await expect(page.locator('#ws-split-close button')).toBeDisabled();
  await expect(page.locator('#ws-split-search')).toBeDisabled();
  await expect(page.locator('#ws-split-list input[data-session="demo03"]')).toBeDisabled();
  await expect(page.locator('#ws-split-modal')).toBeHidden();
  await expect(page.locator('.pane')).toHaveCount(2);
  expect(await page.evaluate(() => sent.filter(message => message.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('an intentionally empty screen stays empty while switching workspace and refreshing', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(async () => { closeActiveView(); await ccWorkspace.persist(); });
  await expect(page.locator('.pane')).toHaveCount(0);
  await page.locator('.ws-workspace[data-workspace="ws_tools"]').click();
  await expect(page.locator('.pane')).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(() => ccWorkspace?.ready);
  await expect(page.locator('.pane')).toHaveCount(0);
  expect(fixture.requests.filter(request => request.path.startsWith('/api/sessions') && request.method !== 'GET')).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

const treeOpen = (page, id) => page.locator(`.ws-session[data-session="${id}"] .ws-session-open`);
const treeSplit = (page, id) => page.locator(`.ws-session[data-session="${id}"] .ws-session-split`);
const treeRename = (page, id) => page.locator(`.ws-session[data-session="${id}"] .ws-session-rename`);

test('selecting a pane reveals its collapsed workspace and session without changing editor context or terminal identities', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo01', 'demo03'], active: 'demo01' } });
  await page.locator('[data-workspace="ws_tools"]').click();
  await page.locator('[data-workspace="ws_tools"]').click();
  await page.locator('[data-workspace="ws_demo"]').click();
  await expect(treeOpen(page, 'demo03')).toBeHidden();
  await page.locator('#ws-session-search').fill('not a session');
  await page.evaluate(() => { window.kept = panes.map(p => ({ p, term: p.term, ws: p.ws })); window.count = socketCount; });
  await page.locator('.pane').nth(1).locator('.pane-name').click();
  await expect(page.locator('[data-workspace="ws_tools"]')).toHaveClass(/has-active-session/);
  await expect(page.locator('[data-workspace="ws_demo"]')).not.toHaveClass(/has-active-session/);
  await expect(page.locator('[data-workspace="ws_tools"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(treeOpen(page, 'demo03')).toHaveAttribute('aria-current', 'true');
  await expect(treeOpen(page, 'demo03')).toBeInViewport();
  await expect(page.locator('#ws-session-search')).toHaveValue('');
  expect(await page.evaluate(() => ccWorkspace.current.id)).toBe('ws_demo');
  expect(await page.evaluate(() => socketCount === count && kept.every(k => panes.includes(k.p) && k.p.term === k.term && k.p.ws === k.ws))).toBe(true);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.requests.filter(r => /\/(start|stop|restart|rename)$/.test(r.path))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('pane selection scrolls only the sidebar to an offscreen session and repeated selection reveals it again', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  const extraSpaces = Array.from({ length: 24 }, (_, i) => ({ id: 'group_' + i, name: 'Pinned project ' + i, cwd: '/workspace/project' + i, members: [], pinned: true, revision: 1 }));
  const fixture = await workspace(page, 'dark', { extraSpaces, initial: { panes: ['demo01', 'demo03'], active: 'demo01' } });
  const context = await page.evaluate(() => ccWorkspace.current.id);
  const terminal = await page.locator('#panes').boundingBox();
  await page.locator('.pane').nth(1).locator('.pane-name').click();
  await expect(treeOpen(page, 'demo03')).toBeInViewport();
  expect(await page.locator('#ws-workspace-list').evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  await page.locator('[data-workspace="ws_tools"]').click();
  await expect(treeOpen(page, 'demo03')).toBeHidden();
  await page.locator('.pane').nth(1).locator('.pane-name').click();
  await expect(treeOpen(page, 'demo03')).toBeInViewport();
  expect(await page.locator('#panes').boundingBox()).toEqual(terminal);
  expect(await page.evaluate(() => [scrollX, scrollY, ccWorkspace.current.id])).toEqual([0, 0, 'ws_tools']);
  expect(context).toBe('ws_demo');
  expect(fixture.errors).toEqual([]);
});

test('pane following preserves an unsaved file and polling leaves sidebar search and scroll alone', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo01', 'demo03'], active: 'demo01' } });
  await page.locator('[data-panel="files"]').click();
  await page.locator('.ws-row[data-file="/workspace/demo/index.js"]').click();
  await page.locator('.ws-editor textarea').fill('unsaved editor content');
  await page.locator('.pane').nth(1).locator('.pane-name').click();
  expect(await page.evaluate(() => ccWorkspace.current.id)).toBe('ws_demo');
  await expect(page.locator('.ws-editor textarea')).toHaveValue('unsaved editor content');
  await expect(page.locator('.ui-dialog')).toHaveCount(0);
  await page.locator('[data-workspace="ws_tools"]').click();
  await expect(page.locator('.ui-dialog')).toBeVisible();
  await page.locator('.ui-dialog .ui-btn').first().click();
  await page.locator('#ws-session-search').fill('API workspace');
  const before = await page.locator('#ws-workspace-list').evaluate(el => el.scrollTop);
  await page.evaluate(() => ccWorkspace.sessionsChanged());
  await expect(page.locator('#ws-session-search')).toHaveValue('API workspace');
  expect(await page.locator('#ws-workspace-list').evaluate(el => el.scrollTop)).toBe(before);
  await expect(page.locator('.ws-editor textarea')).toHaveValue('unsaved editor content');
  expect(fixture.errors).toEqual([]);
});

test('following an unassigned terminal opens only its own group without selecting a different workspace', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraTabs: [{ id: 'extra', name: 'Unassigned terminal', cwd: '/workspace/extra', type: 'shell', alive: true }],
    initial: { panes: ['demo01', 'extra'], active: 'demo01' } });
  const context = await page.evaluate(() => ccWorkspace.current.id);
  await page.locator('.pane').nth(1).locator('.pane-name').click();
  await expect(page.locator('[data-workspace="_unassigned"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-workspace="_unassigned"]')).toHaveClass(/has-active-session/);
  await expect(treeOpen(page, 'extra')).toHaveAttribute('aria-current', 'true');
  expect(await page.evaluate(() => ccWorkspace.current.id)).toBe(context);
  expect(fixture.errors).toEqual([]);
});

for (const id of ['demo01', 'demo02', 'stopped']) {
  test(`sidebar renames ${id} persistently without opening or restarting it`, async ({ page }) => {
    const fixture = await workspace(page, 'dark', { extraTabs: [{ id: 'stopped', name: 'Stopped task', cwd: '/workspace/old', type: 'claude', alive: false }] });
    if (id === 'stopped') {
      await page.locator('[data-workspace="_unassigned"]').click();
      await page.locator('[data-group="_unassigned"] .ws-stopped-toggle').click();
    }
    await page.evaluate(() => { window.original = { pane: active, term: active.term, ws: active.ws, sockets: socketCount }; });
    const name = 'Renamed ' + id + ' <literal>';
    await treeRename(page, id).click();
    await expect(page.locator('.ui-dialog-input')).toHaveValue(fixture.tabs.find(tab => tab.id === id).name);
    await page.locator('.ui-dialog-input').fill(name);
    await page.locator('.ui-dialog .ui-btn.primary').click();
    await expect(treeOpen(page, id).locator('.ws-session-name')).toHaveText(name);
    expect(fixture.requests.filter(r => r.path.endsWith('/rename')).map(r => r.body)).toEqual([{ name }]);
    expect(fixture.requests.filter(r => /\/(start|stop|restart)$/.test(r.path))).toEqual([]);
    expect(await page.evaluate(() => active === original.pane && active.term === original.term && active.ws === original.ws && socketCount === original.sockets)).toBe(true);
    if (id === 'demo01') {
      await expect(page.locator('#workspace-project')).toHaveText(name);
      await expect(page.locator('.pane-name')).toHaveText(name);
      await expect(page.locator('#topbar-title')).toHaveText(name);
    } else await expect(page.locator('#workspace-project')).toHaveText('API workspace');
    await page.reload();
    await page.waitForFunction(() => ccWorkspace?.ready);
    await expect(treeOpen(page, id).locator('.ws-session-name')).toHaveText(name);
    expect(fixture.errors).toEqual([]);
  });
}

test('sidebar rename cancellation, failure and stale row callbacks preserve names and exact targets', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { renameFailure: true });
  await treeRename(page, 'demo02').click();
  await page.locator('.ui-dialog-input').fill('Not saved');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ui-dialog')).toHaveCount(0);
  expect(fixture.requests.filter(r => r.path.endsWith('/rename'))).toEqual([]);
  await treeRename(page, 'demo02').click();
  await page.locator('.ui-dialog-input').fill('Not saved');
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await expect(page.locator('#toast')).toContainText('Rename failed safely');
  await expect(treeOpen(page, 'demo02').locator('.ws-session-name')).toHaveText('Codex');
  await expect(treeRename(page, 'demo02')).toBeEnabled();
  fixture.tabs.find(tab => tab.id === 'demo02').name = 'Changed elsewhere';
  await page.evaluate(() => loadTabs());
  await treeRename(page, 'demo02').click();
  await expect(page.locator('.ui-dialog-input')).toHaveValue('Changed elsewhere');
  await page.keyboard.press('Escape');
  expect(fixture.requests.filter(r => r.path.endsWith('/rename'))).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test('clearing a sidebar name restores its default label without changing the native session', async ({ page }) => {
  const fixture = await workspace(page);
  await treeRename(page, 'demo01').click();
  await page.locator('.ui-dialog-input').fill('   ');
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await expect(treeOpen(page, 'demo01').locator('.ws-session-name')).toHaveText('cc_demo01');
  await expect(page.locator('#workspace-project')).toHaveText('cc_demo01');
  await expect(page.locator('.pane-name')).toHaveText('cc_demo01');
  expect(fixture.tabs[0].cwd).toBe('/workspace/demo');
  expect(fixture.tabs[0].id).toBe('demo01');
  expect(fixture.requests.filter(r => r.path.endsWith('/rename')).map(r => r.body)).toEqual([{ name: '' }]);
  expect(fixture.errors).toEqual([]);
});

test('one shared session rename updates every workspace occurrence and keeps the active terminal', async ({ page }) => {
  const fixture = await workspace(page, 'light', { extraSpaces: [{ id: 'ws_shared', name: 'Shared list', cwd: '/workspace/demo', members: ['demo01'], revision: 1 }] });
  await page.locator('[data-workspace="ws_shared"]').click();
  await page.evaluate(() => { window.kept = { pane: active, ws: active.ws, term: active.term }; });
  await treeRename(page, 'demo01').first().click();
  await page.locator('.ui-dialog-input').fill('Shared name');
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await expect(treeOpen(page, 'demo01').locator('.ws-session-name')).toHaveText(['Shared name', 'Shared name']);
  expect(await page.evaluate(() => active === kept.pane && active.ws === kept.ws && active.term === kept.term)).toBe(true);
  expect(fixture.requests.filter(r => r.path.endsWith('/rename'))).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

for (const theme of ['dark', 'light']) {
  test(`${theme} mobile follows the current session without opening the drawer and supports sidebar rename`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true });
    try {
      const page = await context.newPage();
      const fixture = await workspace(page, theme);
      await page.evaluate(() => attachTerminal(state.tabs.find(tab => tab.id === 'demo03'), active));
      await page.waitForFunction(() => active?.ws?.readyState === 1);
      await expect(page.locator('body')).not.toHaveClass(/drawer-open/);
      await expect(page.locator('#btn-kbd')).not.toHaveClass(/on/);
      await page.locator('#hamburger').tap();
      await expect(treeOpen(page, 'demo03')).toBeInViewport();
      await expect(page.locator('[data-workspace="ws_tools"]')).toHaveClass(/has-active-session/);
      await treeRename(page, 'demo03').tap();
      const name = 'Mobile ' + theme + ' ' + 'LongName'.repeat(9);
      await page.locator('.ui-dialog-input').fill(name);
      await page.locator('.ui-dialog .ui-btn.primary').tap();
      await expect(treeOpen(page, 'demo03').locator('.ws-session-name')).toHaveText(name);
      await expect(page.locator('#workspace-project')).toHaveText(name);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const row = await treeRename(page, 'demo03').boundingBox();
      expect(row.width).toBeGreaterThanOrEqual(40);
      expect(row.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: '/tmp/webcc-v104-sidebar-' + theme + '-320.png' });
      expect(fixture.requests.filter(r => /\/(start|stop|restart)$/.test(r.path))).toEqual([]);
      expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
      expect(fixture.errors).toEqual([]);
    } finally { await context.close(); }
  });
}

test('workspace disclosure keeps multiple groups open without changing focus or terminal identities', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(() => { window.original = { pane: active, term: active.term, ws: active.ws, sockets: socketCount }; });
  await page.locator('[data-workspace="ws_tools"]').click();
  await expect(treeOpen(page, 'demo03')).toBeVisible();
  await expect(treeOpen(page, 'demo02')).toBeVisible();
  await expect(page.locator('#workspace-project')).toHaveText('API workspace');
  await page.locator('[data-workspace="ws_tools"]').click();
  await expect(treeOpen(page, 'demo03')).toBeHidden();
  expect(await page.evaluate(() => active === original.pane && active.term === original.term && active.ws === original.ws && socketCount === original.sockets)).toBe(true);
  await page.reload();
  await page.waitForFunction(() => ccWorkspace?.ready);
  await expect(page.locator('[data-workspace="ws_tools"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-workspace="ws_demo"]')).toHaveAttribute('aria-expanded', 'true');
  expect(fixture.requests.filter(r => r.path.startsWith('/api/sessions/') && r.method !== 'GET')).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('tree split actions add cross-project sessions and focus visible panes without duplicate sockets', async ({ page }) => {
  const fixture = await workspace(page);
  await expect(page.locator('.ws-session-split svg')).toHaveCount(4);
  await page.evaluate(() => { window.original = { pane: active, term: active.term, ws: active.ws }; });
  await treeSplit(page, 'demo02').click();
  await expect(page.locator('.pane')).toHaveCount(2);
  await expect(treeSplit(page, 'demo02')).toBeEnabled();
  await page.locator('[data-workspace="ws_tools"]').click();
  await treeSplit(page, 'demo03').click();
  await expect(page.locator('.pane')).toHaveCount(3);
  await expect(treeSplit(page, 'demo03')).toBeEnabled();
  expect(await page.evaluate(() => panes[0] === original.pane && panes[0].term === original.term && panes[0].ws === original.ws)).toBe(true);
  await page.evaluate(() => { window.kept = panes.map(p => ({ pane: p, term: p.term, ws: p.ws })); window.count = socketCount; });
  await treeOpen(page, 'demo02').click();
  await expect(treeOpen(page, 'demo02')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.ws-session[data-session="demo03"] .ws-pane-badge')).toHaveText('3');
  await treeSplit(page, 'demo03').click();
  expect(await page.evaluate(() => active.tab.id)).toBe('demo03');
  expect(await page.evaluate(() => socketCount === count && kept.every(ref => panes.includes(ref.pane) && ref.pane.term === ref.term && ref.pane.ws === ref.ws))).toBe(true);
  await page.evaluate(async () => {
    for (const pane of panes.slice(1)) await new Promise(resolve => pane.term.write(pane.tab.name + '\r\n\r\n\x1b[32mReady\x1b[0m\r\n\r\n~/workspace $ ', resolve));
  });
  await expect(page.locator('.ws-pane-number')).toHaveText(['1', '2', '3']);
  await page.screenshot({ path: '/tmp/webcc-v91-sidebar-three-panes.png' });
  await page.reload();
  await page.waitForFunction(() => ccWorkspace?.ready && panes.length === 3);
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo02', 'demo03']);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.requests.filter(r => r.path.startsWith('/api/sessions/') && r.method !== 'GET')).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('single-click switches only the active pane and split fills an existing empty cell', async ({ page }) => {
  const fixture = await workspace(page);
  await treeSplit(page, 'demo02').click();
  await expect(treeSplit(page, 'demo02')).toBeEnabled();
  await page.evaluate(() => { window.first = { pane: panes[0], term: panes[0].term, ws: panes[0].ws }; });
  await treeOpen(page, 'demo04').click();
  await expect(treeOpen(page, 'demo04')).toHaveAttribute('aria-current', 'true');
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo04']);
  await page.evaluate(() => splitPane());
  await expect(page.locator('.pane')).toHaveCount(3);
  await treeSplit(page, 'demo02').click();
  await expect(treeSplit(page, 'demo02')).toBeEnabled();
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo04', 'demo02']);
  expect(await page.evaluate(() => panes[0] === first.pane && panes[0].term === first.term && panes[0].ws === first.ws)).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test('four occupied panes require an explicit replacement and cancellation changes nothing', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraTabs: [{ id: 'demo05', name: 'Fifth terminal', cwd: '/workspace/other', type: 'shell', alive: true }] });
  await chooseSplits(page, ['demo01', 'demo02', 'demo03', 'demo04']);
  await page.evaluate(() => { window.kept = panes.map(p => ({ pane: p, term: p.term, ws: p.ws })); window.count = socketCount; });
  await page.locator('[data-workspace="_unassigned"]').click();
  await treeSplit(page, 'demo05').click();
  await expect(page.locator('#ws-replace-modal')).toBeVisible();
  await expect(page.locator('#ws-replace-list button')).toHaveCount(4);
  await page.keyboard.press('Escape');
  await expect(page.locator('#ws-replace-modal')).toBeHidden();
  expect(await page.evaluate(() => socketCount === count && kept.every(ref => panes.includes(ref.pane) && ref.pane.term === ref.term && ref.pane.ws === ref.ws))).toBe(true);
  await treeSplit(page, 'demo05').click();
  await page.locator('#ws-replace-list [data-replace-session="demo02"]').click();
  await expect(page.locator('#ws-replace-modal')).toBeHidden();
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo05', 'demo03', 'demo04']);
  expect(await page.evaluate(() => kept.filter(ref => ref.pane.tab.id !== 'demo02').every(ref => panes.includes(ref.pane) && ref.pane.term === ref.term && ref.pane.ws === ref.ws))).toBe(true);
  expect(fixture.requests.filter(r => r.path.startsWith('/api/sessions/') && r.method !== 'GET')).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('stopped sessions stay folded and require confirmation before a single exact start request', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraTabs: [{ id: 'stopped', name: 'Saved Codex', cwd: '/workspace/old', type: 'codex', alive: false }] });
  await page.locator('[data-workspace="_unassigned"]').click();
  await expect(treeOpen(page, 'stopped')).toBeHidden();
  await page.locator('[data-group="_unassigned"] .ws-stopped-toggle').click();
  await treeOpen(page, 'stopped').click();
  await expect(page.locator('.ui-dialog')).toContainText('无法确认原会话时不会新建替代对话');
  expect(fixture.requests.filter(r => r.path.endsWith('/start'))).toEqual([]);
  await page.locator('.ui-dialog .ui-btn:not(.primary)').click();
  await expect(treeOpen(page, 'stopped')).toBeEnabled();
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  await treeOpen(page, 'stopped').click();
  await page.locator('.ui-dialog .ui-btn.primary').click();
  await expect(treeOpen(page, 'stopped')).toHaveAttribute('aria-current', 'true');
  expect(fixture.requests.filter(r => r.path.endsWith('/start')).map(r => r.path)).toEqual(['/api/sessions/stopped/start']);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('search reveals matching collapsed and stopped children without changing expansion or sending input', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraTabs: [{ id: 'stopped', name: '<img src=x onerror=alert(1)>', cwd: '/workspace/old', type: 'codex', alive: false }] });
  await page.locator('#ws-session-search').fill('Claude');
  await expect(treeOpen(page, 'demo03')).toBeVisible();
  await expect(page.locator('[data-group="ws_demo"]')).toBeHidden();
  await page.locator('#ws-session-search').fill('onerror');
  await expect(treeOpen(page, 'stopped')).toBeVisible();
  await expect(page.locator('.ws-session img')).toHaveCount(0);
  await page.locator('#ws-session-search').fill('no-such-session');
  await expect(page.locator('#ws-workspace-list')).toHaveAttribute('data-empty', 'true');
  await page.locator('#ws-session-search').press('Escape');
  await expect(treeOpen(page, 'demo03')).toBeHidden();
  await expect(treeOpen(page, 'demo02')).toBeVisible();
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  expect(fixture.requests.filter(r => r.path.startsWith('/api/sessions/') && r.method !== 'GET')).toEqual([]);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('polling preserves keyed sidebar focus and scroll position and reload restores list position', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  const extraSpaces = Array.from({ length: 24 }, (_, i) => ({ id: 'group_' + i, name: 'Project ' + i, cwd: '/workspace/project' + i, members: [], revision: 1 }));
  const fixture = await workspace(page, 'dark', { extraSpaces });
  await page.locator('[data-workspace="group_10"]').focus();
  await page.evaluate(() => { window.keptButton = document.activeElement; window.listTop = document.getElementById('ws-workspace-list').scrollTop; });
  await page.evaluate(() => ccWorkspace.sessionsChanged());
  expect(await page.evaluate(() => document.activeElement === keptButton && keptButton.isConnected)).toBe(true);
  expect(await page.locator('#ws-workspace-list').evaluate(el => el.scrollTop)).toBe(await page.evaluate(() => listTop));
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('cc_workspace_tree_' + 'desktop_' + localStorage.getItem('cc_workspace_device')) || '{}').scroll || 0)).toBeGreaterThan(0);
  const top = await page.evaluate(() => listTop);
  await page.route('**/api/workspaces', async route => {
    await new Promise(resolve => setTimeout(resolve, 300));
    return route.fallback();
  });
  await page.reload();
  await page.waitForFunction(() => ccWorkspace?.ready);
  await expect.poll(() => page.locator('#ws-workspace-list').evaluate(el => el.scrollTop)).toBe(top);
  expect(fixture.errors).toEqual([]);
});

test('keyboard disclosure navigates group children and never reaches the native terminal', async ({ page }) => {
  const fixture = await workspace(page);
  const tools = page.locator('[data-workspace="ws_tools"]');
  await tools.focus(); await page.keyboard.press('ArrowRight');
  await expect(tools).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(treeOpen(page, 'demo03')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tools).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tools).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('sidebar resize is bounded, keyboard accessible and preserves terminal objects', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await workspace(page);
  await page.evaluate(() => { window.original = { pane: active, term: active.term, ws: active.ws }; });
  const handle = page.getByRole('separator', { name: '侧栏宽度' }), box = await handle.boundingBox();
  await page.mouse.move(box.x + 2, box.y + 20); await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 20); await page.mouse.up();
  expect(await page.locator('#sidebar').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(300);
  await handle.focus(); await page.keyboard.press('Home');
  await expect(handle).toHaveAttribute('aria-valuenow', '200');
  await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '216');
  expect(await page.evaluate(() => active === original.pane && active.term === original.term && active.ws === original.ws)).toBe(true);
  await page.reload(); await page.waitForFunction(() => ccWorkspace?.ready);
  expect(await page.locator('#sidebar').evaluate(el => el.getBoundingClientRect().width)).toBe(216);
  expect(fixture.errors).toEqual([]);
});

test('direct split saves disable duplicate actions and keep all existing attachments', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(() => ccWorkspace.persist());
  await page.route('**/api/layouts/*', async route => {
    if (route.request().method() === 'PUT') await new Promise(resolve => setTimeout(resolve, 350));
    return route.fallback();
  });
  await page.evaluate(() => { window.original = { pane: active, term: active.term, ws: active.ws }; });
  await treeSplit(page, 'demo02').click();
  await expect(treeSplit(page, 'demo02')).toBeDisabled();
  await expect(treeOpen(page, 'demo04')).toBeDisabled();
  await expect(treeSplit(page, 'demo02')).toBeEnabled();
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo02']);
  expect(await page.evaluate(() => panes[0] === original.pane && panes[0].term === original.term && panes[0].ws === original.ws)).toBe(true);
  expect(fixture.requests.filter(r => r.path.startsWith('/api/sessions/') && r.method !== 'GET')).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('a conflicted split save cannot silently apply another sidebar layout change', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(() => ccWorkspace.persist());
  await page.route('**/api/layouts/*', route => route.request().method() === 'PUT' ? route.fulfill({ status: 409, json: { detail: 'Layout changed in another window' } }) : route.fallback());
  await treeSplit(page, 'demo02').click();
  await expect(treeSplit(page, 'demo02')).toBeEnabled();
  await expect(page.locator('#ws-save-indicator')).toContainText('可保存当前布局副本');
  await treeSplit(page, 'demo04').click();
  await expect(treeSplit(page, 'demo04')).toBeEnabled();
  expect(await page.evaluate(() => panes.map(p => p.tab.id))).toEqual(['demo01', 'demo02']);
  expect(fixture.errors).toEqual([]);
});

for (const theme of ['dark', 'light']) {
  for (const width of [320, 390]) {
    test(`${theme} touch sidebar expands and switches one terminal at ${width}px without keyboard`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      try {
        const page = await context.newPage(), fixture = await workspace(page, theme);
        await page.locator('#hamburger').tap();
        await page.locator('[data-workspace="ws_tools"]').tap();
        await expect(page.locator('body')).toHaveClass(/drawer-open/);
        await expect(treeOpen(page, 'demo03')).toBeVisible();
        await expect(treeSplit(page, 'demo03')).toBeHidden();
        await page.screenshot({ path: `/tmp/webcc-v91-sidebar-${theme}-${width}.png` });
        const sidebar = await page.locator('#sidebar').boundingBox();
        expect(sidebar.x).toBeGreaterThanOrEqual(0);
        expect(sidebar.x + sidebar.width).toBeLessThanOrEqual(width);
        await treeOpen(page, 'demo03').tap();
        await expect(page.locator('body')).not.toHaveClass(/drawer-open/);
        await expect(page.locator('.pane')).toHaveCount(1);
        expect(await page.evaluate(() => active.tab.id)).toBe('demo03');
        expect(await page.locator('.xterm-helper-textarea').getAttribute('inputmode')).toBe('none');
        expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
        expect(fixture.errors).toEqual([]);
      } finally { await context.close(); }
    });
  }
}

test('a touch swipe scrolls a long workspace list without scrolling or typing into the terminal', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    const extraSpaces = Array.from({ length: 24 }, (_, i) => ({ id: 'group_' + i, name: 'Project ' + i, cwd: '/workspace/project' + i, members: [], revision: 1 }));
    const fixture = await workspace(page, 'dark', { extraSpaces });
    await page.locator('#hamburger').tap();
    await expect(page.locator('#sidebar')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
    const box = await page.locator('#ws-workspace-list').boundingBox();
    const client = await context.newCDPSession(page), x = box.x + box.width / 2, y = box.y + box.height - 20;
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 24 }] });
      await page.waitForTimeout(20);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.locator('#ws-workspace-list').evaluate(el => el.scrollTop)).toBeGreaterThan(80);
    expect(await page.evaluate(() => sent.filter(msg => ['input', 'scroll'].includes(msg.type)))).toEqual([]);
    expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
    expect(fixture.errors).toEqual([]);
  } finally { await context.close(); }
});

test('a stopped session finishing startup after a device change does not replace the new device view', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { extraTabs: [{ id: 'stopped', name: 'Saved Codex', cwd: '/workspace/old', type: 'codex', alive: false }] });
  await page.route('**/api/sessions/stopped/start', async route => {
    await new Promise(resolve => setTimeout(resolve, 400));
    return route.fallback();
  });
  await page.locator('[data-workspace="_unassigned"]').click();
  await page.locator('[data-group="_unassigned"] .ws-stopped-toggle').click();
  await treeOpen(page, 'stopped').click();
  const request = page.waitForRequest('**/api/sessions/stopped/start');
  await page.locator('.ui-dialog .ui-btn.primary').click(); await request;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => !openingTab && ccWorkspace?.ready);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  await expect(page.locator('.pane')).toHaveCount(1);
  expect(fixture.requests.filter(r => r.path.endsWith('/start'))).toHaveLength(1);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

async function selectEffect(page, value) {
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#cc-effect-select').selectOption(value);
}

test('Ghostty-inspired effects default off and enabling Aurora preserves terminal identities and content', async ({ page }) => {
  const fixture = await workspace(page);
  await expect(page.locator('.cc-effect-layer')).toHaveCount(0);
  await page.evaluate(() => { window.original = { pane: active, term: active.term, ws: active.ws, text: active.term.buffer.active.getLine(0).translateToString(), count: socketCount }; });
  await selectEffect(page, 'aurora');
  await expect(page.locator('.cc-aurora-edge')).toHaveCount(4);
  const strip = page.locator('.cc-aurora-edge.top'), before = await strip.screenshot();
  await page.waitForTimeout(180);
  expect((await strip.screenshot()).equals(before)).toBe(false);
  expect(await page.locator('.cc-effect-layer').evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
  expect(await page.evaluate(() => active === original.pane && active.term === original.term && active.ws === original.ws && socketCount === original.count && active.term.buffer.active.getLine(0).translateToString() === original.text)).toBe(true);
  await page.locator('#cc-effect-strength').fill('70');
  await expect(page.locator('#cc-effect-value')).toHaveText('70%');
  await page.screenshot({ path: '/tmp/webcc-v92-aurora-settings.png' });
  await page.reload(); await page.waitForFunction(() => ccWorkspace?.ready);
  await expect(page.locator('.cc-aurora-edge')).toHaveCount(4);
  expect(fixture.requests.filter(r => r.path.startsWith('/api/sessions/') && r.method !== 'GET')).toEqual([]);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('cursor sweep paints then becomes idle without sending input or changing terminal history', async ({ page }) => {
  const fixture = await workspace(page);
  await selectEffect(page, 'sweep');
  await expect(page.locator('.cc-cursor-trail')).toHaveCount(1);
  await page.evaluate(() => active.term.focus());
  await page.waitForTimeout(80);
  await page.evaluate(async () => {
    await new Promise(resolve => active.term.write('\x1b[5;5H', resolve));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise(resolve => active.term.write('\x1b[5;24H', resolve));
  });
  const painted = () => page.locator('.cc-cursor-trail').evaluate(canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((v, i) => i % 4 === 3 && v > 0));
  await expect.poll(painted).toBe(true);
  await expect.poll(painted).toBe(false);
  const first = await page.evaluate(() => active.term.buffer.active.getLine(0).translateToString());
  await page.locator('#cc-effect-select').selectOption('off');
  await expect(page.locator('.cc-effect-layer')).toHaveCount(0);
  expect(await page.evaluate(() => active.term.buffer.active.getLine(0).translateToString())).toBe(first);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('effects follow only the active split and are disposed on replacement and close', async ({ page }) => {
  const fixture = await workspace(page);
  await chooseSplits(page, ['demo01', 'demo02', 'demo03']);
  await selectEffect(page, 'combined');
  await expect(page.locator('.cc-effect-layer')).toHaveCount(1);
  await page.evaluate(() => { window.oldDecoration = document.querySelector('.cc-effect-layer'); focusPane(panes[1], false); });
  expect(await page.evaluate(() => !oldDecoration.isConnected)).toBe(true);
  await expect(page.locator('.pane.focused .cc-effect-layer')).toHaveCount(1);
  await page.evaluate(() => { window.oldDecoration = document.querySelector('.cc-effect-layer'); });
  await treeOpen(page, 'demo04').click();
  expect(await page.evaluate(() => !oldDecoration.isConnected)).toBe(true);
  await expect(page.locator('.cc-effect-layer')).toHaveCount(1);
  await page.locator('.pane.focused .pane-host').hover();
  await page.mouse.wheel(0, -140);
  await expect.poll(() => page.evaluate(() => sent.filter(msg => msg.type === 'scroll').length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  await page.evaluate(() => closeActiveView());
  await expect(page.locator('.cc-effect-layer')).toHaveCount(0);
  expect(fixture.requests.filter(r => r.path.startsWith('/api/sessions/') && r.method !== 'GET')).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('reduced motion and high contrast disable animation without losing user preference', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const fixture = await workspace(page);
  await selectEffect(page, 'combined');
  await expect(page.locator('.cc-effect-layer')).toHaveAttribute('data-motion', 'static');
  await expect(page.locator('.cc-cursor-trail')).toHaveCount(0);
  expect(await page.locator('.cc-aurora-edge.top').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await expect(page.locator('#cc-effect-state')).toContainText('减少动态效果');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.cc-cursor-trail')).toHaveCount(1);
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(page.locator('.cc-effect-layer')).toHaveCount(0);
  await expect(page.locator('#cc-effect-select')).toHaveValue('combined');
  await page.emulateMedia({ forcedColors: 'none' });
  await expect(page.locator('.cc-effect-layer')).toHaveCount(1);
  expect(fixture.errors).toEqual([]);
});

for (const theme of ['dark', 'light']) {
  for (const width of [320, 390, 1440]) {
    test(`${theme} effect settings fit ${width}px and mobile uses a static decoration`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const fixture = await workspace(page, theme);
      if (width <= 820) await page.locator('#ws-mobile-deck').click();
      await selectEffect(page, 'combined');
      const bounds = await page.locator('#cc-effect-select').boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      if (width <= 820) {
        await expect(page.locator('.cc-effect-layer')).toHaveAttribute('data-motion', 'static');
        await expect(page.locator('.cc-cursor-trail')).toHaveCount(0);
        await expect(page.locator('#cc-effect-state')).toContainText('手机');
      }
      await page.screenshot({ path: `/tmp/webcc-v92-effects-${theme}-${width}.png` });
      expect(fixture.errors).toEqual([]);
    });
  }
}

test('effect preference storage validates unknown values and survives a missing 2d context', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('cc_terminal_effects', '{"effect":"<script>","strength":9999}');
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) { return this.classList.contains('cc-cursor-trail') ? null : original.call(this, type, ...args); };
  });
  const fixture = await workspace(page);
  await page.locator('[data-panel="settings"]').click();
  await expect(page.locator('#cc-effect-select')).toHaveValue('off');
  await expect(page.locator('#cc-effect-value')).toHaveText('70%');
  await page.locator('#cc-effect-select').selectOption('combined');
  await expect(page.locator('.cc-aurora-edge')).toHaveCount(4);
  await expect(page.locator('.cc-cursor-trail')).toHaveCount(0);
  await expect(page.locator('#cc-effect-state')).toHaveText('拖尾不可用，已保留流光');
  await page.locator('#cc-effect-select').selectOption('off');
  await expect(page.locator('.cc-effect-layer')).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test('background pages remove effects and storage changes safely reset the preference', async ({ page }) => {
  const fixture = await workspace(page);
  await selectEffect(page, 'combined');
  await page.evaluate(() => {
    window.original = { pane: active, term: active.term, ws: active.ws };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.cc-effect-layer')).toHaveCount(0);
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('.cc-cursor-trail')).toHaveCount(1);
  expect(await page.evaluate(() => active === original.pane && active.term === original.term && active.ws === original.ws)).toBe(true);
  await page.evaluate(() => {
    localStorage.setItem('cc_terminal_effects', 'invalid json');
    dispatchEvent(new StorageEvent('storage', { key: 'cc_terminal_effects', storageArea: localStorage }));
  });
  await expect(page.locator('.cc-effect-layer')).toHaveCount(0);
  await expect(page.locator('#cc-effect-select')).toHaveValue('off');
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

async function selectStyle(page, value) {
  await page.locator('button[data-panel="settings"]').click();
  await page.locator('#cc-style-select').selectOption(value);
}

test('glass style preserves all split identities, fonts, history and layout while restoring graphite exactly', async ({ page }) => {
  const fixture = await workspace(page);
  await chooseSplits(page, ['demo01', 'demo02', 'demo03']);
  await page.evaluate(() => { window.originals = panes.map(p => ({ pane: p, term: p.term, ws: p.ws, font: p.term.options.fontSize,
    foreground: p.term.options.theme.foreground, text: p.term.buffer.active.getLine(0).translateToString(), cols: p.term.cols, rows: p.term.rows })); });
  await selectStyle(page, 'glass');
  await expect(page.locator('html')).toHaveAttribute('data-terminal-style', 'glass');
  await expect(page.locator('.cc-effect-layer')).toHaveCount(0);
  expect(await page.evaluate(() => originals.every(o => o.pane.term === o.term && o.pane.ws === o.ws && panes.includes(o.pane)
    && o.term.options.fontSize === o.font && o.term.cols === o.cols && o.term.rows === o.rows
    && o.term.buffer.active.getLine(0).translateToString() === o.text))).toBe(true);
  expect(await page.evaluate(() => panes.every(p => p.term.options.theme.foreground === '#dedee8' && p.term.options.theme.background === '#00000000'))).toBe(true);
  await page.locator('#cc-style-select').selectOption('graphite');
  expect(await page.evaluate(() => originals.every(o => o.pane.term === o.term && o.pane.ws === o.ws && o.term.options.theme.foreground === o.foreground))).toBe(true);
  expect(fixture.requests.filter(r => r.path.startsWith('/api/sessions/') && r.method !== 'GET')).toEqual([]);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('glass style loads one local bitmap with visible pixels but never filters or fades text', async ({ page }) => {
  const assets = []; page.on('request', r => { if (r.url().includes('/assets/')) assets.push(r.url()); });
  const fixture = await workspace(page);
  await selectStyle(page, 'glass');
  await page.evaluate(async () => { const image = new Image(); image.src = '/assets/mist-coast.png?v=93'; await image.decode();
    if (image.naturalWidth < 1000) throw Error('Background failed to decode'); });
  await chooseSplits(page, ['demo01', 'demo02', 'demo03']);
  await expect.poll(() => assets.length).toBe(1);
  expect(assets.every(url => new URL(url).origin === 'http://workspace.test')).toBe(true);
  const styles = await page.locator('.pane-host').first().evaluate(el => {
    const background = getComputedStyle(document.body, ':before'), text = getComputedStyle(el);
    return { image: background.backgroundImage, filter: background.filter, pointer: background.pointerEvents, textOpacity: text.opacity, textFilter: text.filter };
  });
  expect(styles.image).toContain('mist-coast.png'); expect(styles.filter).toBe('blur(20px) saturate(0.45)');
  expect(styles.pointer).toBe('none'); expect(styles.textOpacity).toBe('1'); expect(styles.textFilter).toBe('none');
  const host = page.locator('.pane-host').first(), before = await host.screenshot();
  await page.addStyleTag({ content: 'body:before { visibility: hidden !important; }' });
  expect((await host.screenshot()).equals(before)).toBe(false);
  expect(fixture.errors).toEqual([]);
});

test('glass style uses the same palette for newly attached terminals and light mode without resetting effects', async ({ page }) => {
  const fixture = await workspace(page);
  await selectEffect(page, 'aurora');
  await page.locator('#cc-style-select').selectOption('glass');
  await treeOpen(page, 'demo02').click();
  expect(await page.evaluate(() => active.term.options.theme.foreground)).toBe('#dedee8');
  await page.locator('button[data-panel="settings"]').click();
  await expect(page.locator('#cc-effect-select')).toHaveValue('aurora');
  await page.evaluate(() => { localStorage.setItem('cc_theme', 'light'); applyTheme('light'); });
  expect(await page.evaluate(() => active.term.options.theme.foreground)).toBe('#2e3142');
  await treeOpen(page, 'demo04').click();
  expect(await page.evaluate(() => active.term.options.theme.foreground)).toBe('#2e3142');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#eceef3');
  await page.locator('button[data-panel="settings"]').click();
  await page.locator('#cc-effect-select').selectOption('off');
  await page.reload(); await page.waitForFunction(() => ccWorkspace?.ready);
  await expect(page.locator('html')).toHaveAttribute('data-terminal-style', 'glass');
  expect(await page.evaluate(() => active.term.options.theme.foreground)).toBe('#dedee8'); // fixture restores dark mode on reload
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('glass style preserves explicit ANSI backgrounds and original wheel behavior', async ({ page }) => {
  const fixture = await workspace(page);
  await selectStyle(page, 'glass');
  await treeOpen(page, 'demo02').click();
  await page.evaluate(() => new Promise(resolve => active.term.write('\x1b[2J\x1b[H\x1b[41;97m APPROVAL \x1b[0m\r\n\x1b[48;2;30;40;50mTRUECOLOR\x1b[0m', resolve)));
  const cells = await page.evaluate(() => {
    const buf = active.term.buffer.active, first = buf.getLine(buf.baseY).getCell(1), second = buf.getLine(buf.baseY + 1).getCell(1);
    return { palette: first.isBgPalette(), index: first.getBgColor(), rgb: second.isBgRGB(), color: second.getBgColor(), minContrast: active.term.options.minimumContrastRatio };
  });
  expect(cells).toEqual({ palette: true, index: 1, rgb: true, color: (30 << 16) | (40 << 8) | 50, minContrast: 4.5 });
  await page.locator('.pane-host').hover(); await page.mouse.wheel(0, -150);
  await expect.poll(() => page.evaluate(() => sent.filter(msg => msg.type === 'scroll').length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const theme of ['dark', 'light']) {
  for (const width of [320, 390, 1440]) {
    test(`${theme} glass style fits ${width}px and keeps readable solid surfaces on phones`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await workspace(page, theme);
      if (width <= 820) await page.locator('#ws-mobile-deck').click();
      await selectStyle(page, 'glass');
      await expect(page.locator('html')).toHaveAttribute('data-glass-surface', width <= 820 ? 'opaque' : 'translucent');
      const box = await page.locator('#cc-style-select').boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: `/tmp/webcc-v93-glass-settings-${theme}-${width}.png` });
      if (width <= 820) await page.getByRole('button', { name: '收起任务面板', exact: true }).click();
      else {
        await chooseSplits(page, ['demo01', 'demo02', 'demo03']);
        await page.getByRole('button', { name: '收起任务面板', exact: true }).click();
        await page.waitForFunction(() => panes.every(p => p.ws?.readyState === 1));
        await page.evaluate(async () => {
          for (const p of panes.slice(1)) await new Promise(resolve => p.term.write(p.tab.name + '\r\n\r\n\x1b[32mConnected\x1b[0m to existing session\r\n\r\nWorking directory: ~/workspace/' + (p.tab.id === 'demo02' ? 'demo' : 'tools') + '\r\n\r\n\x1b[34m›\x1b[0m Review the latest changes\r\n\r\n• Checking the working tree and test results.\r\n\r\n', resolve));
        });
      }
      await page.screenshot({ path: `/tmp/webcc-v93-glass-${theme}-${width}.png` });
      const host = await page.locator('.pane-host').first().boundingBox();
      expect(host.width).toBeGreaterThan(180); expect(host.y + host.height).toBeLessThanOrEqual(900);
      expect(fixture.errors).toEqual([]);
    });
  }
}

test('glass style honors reduced transparency, data saving, forced colors and safe storage changes', async ({ page }) => {
  await page.addInitScript(() => {
    const match = window.matchMedia;
    window.matchMedia = function (query) {
      const result = match.call(window, query);
      if (query.includes('reduced-transparency')) Object.defineProperty(result, 'matches', { get: () => !!window.reduceGlass });
      return result;
    };
    localStorage.setItem('cc_terminal_style', '<style>');
  });
  const fixture = await workspace(page);
  await expect(page.locator('html')).toHaveAttribute('data-terminal-style', 'graphite');
  await selectStyle(page, 'glass');
  await page.evaluate(() => { window.reduceGlass = true; ccAppearance.sync(true); });
  await expect(page.locator('html')).toHaveAttribute('data-glass-surface', 'opaque');
  expect(await page.locator('body').evaluate(el => getComputedStyle(el, ':before').backgroundImage)).toBe('none');
  await page.evaluate(() => {
    window.reduceGlass = false;
    Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } }); ccAppearance.sync(true);
  });
  await expect(page.locator('html')).toHaveAttribute('data-glass-surface', 'opaque');
  await page.emulateMedia({ forcedColors: 'active' });
  await expect.poll(() => page.evaluate(() => active.term.options.theme.background === getComputedStyle(document.body).backgroundColor)).toBe(true);
  expect(await page.evaluate(() => active.term.options.theme.foreground === getComputedStyle(document.body).color)).toBe(true);
  expect(await page.locator('.pane').evaluate(el => getComputedStyle(el).backgroundColor === getComputedStyle(document.body).backgroundColor)).toBe(true);
  await page.emulateMedia({ forcedColors: 'none' });
  await expect.poll(() => page.evaluate(() => active.term.options.theme.background)).toBe('#00000000');
  await page.evaluate(() => {
    localStorage.removeItem('cc_terminal_style'); dispatchEvent(new StorageEvent('storage', { key: 'cc_terminal_style', storageArea: localStorage }));
  });
  await expect(page.locator('html')).toHaveAttribute('data-terminal-style', 'graphite');
  await expect(page.locator('#cc-style-select')).toHaveValue('graphite');
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

async function nativeScreen(page, options = {}) {
  return page.evaluate(async options => {
    const p = panes.find(p => p.tab?.id === (options.id || 'demo02')) || active, term = p.term;
    const kind = options.kind || p.tab.resumeAgent || p.tab.type;
    const draft = options.draft || ['Review the latest changes'];
    const start = options.start ?? Math.max(2, Math.min(12, term.rows - draft.length - 6));
    const at = (row, text) => `\x1b[${row + 1};1H${text}`;
    let data = '\x1b[0m\x1b[2J\x1b[H' + at(0, `${kind === 'claude' ? 'Claude Code' : 'Codex'} · project`);
    data += at(start - 2, options.above || '');
    if (kind === 'claude') data += at(start - 1, '─'.repeat(term.cols));
    draft.forEach((line, i) => { data += at(start + i, (i ? '  ' : (kind === 'claude' ? '❯ ' : '› ')) + line); });
    if (kind === 'claude') {
      data += at(start + draft.length, '─'.repeat(term.cols));
      data += at(start + draft.length + 2, '  bypass permissions on (shift+tab to cycle)');
    } else {
      data += at(start + draft.length + 1, '  Ready · Context 55% left');
      data += at(start + draft.length + 2, '  ? for shortcuts');
    }
    if (options.copy) data += at(0, ' '.repeat(Math.max(0, term.cols - 7)) + '[2/20]');
    data += `\x1b[${start + (options.cursor || 0) + 1};${options.column || 3}H\x1b[?25${options.hidden ? 'l' : 'h'}`;
    await new Promise(resolve => term.write(data, resolve));
    return { start, end: start + draft.length, rows: term.rows, cols: term.cols };
  }, options);
}
async function openNative(page, id = 'demo02') {
  await page.evaluate(id => attachTerminal(state.tabs.find(tab => tab.id === id), active), id);
  await page.waitForFunction(() => active?.connectionState === 'connected' && active?.ws?.readyState === 1);
}

for (const width of [390, 1440]) {
  test(`bridge copy-only shortcut and explicit interrupt work at ${width}px without replacing the Codex terminal`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await workspace(page); await openNative(page); const screen = await nativeScreen(page);
    await page.evaluate(start => {
      window.copyOriginal = { term: active.term, ws: active.ws }; window.copied = '';
      document.execCommand = command => { if (command === 'copy') { copied = document.activeElement.value; return true; } return false; };
      active.term.focus(); active.term.select(2, start, 25); sent.length = 0;
    }, screen.start);
    await page.locator('#cap-ctrl').click(); await page.keyboard.press('c');
    await expect.poll(() => page.evaluate(() => copied)).toBe('Review the latest changes');
    expect(await page.evaluate(() => ctrlArmed)).toBe(false);
    expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
    await page.locator('#btn-interrupt').click();
    await expect(page.locator('.ui-dialog')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/webcc-v97-copy-bridge-${width}.png` });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect(await page.evaluate(() => active.term === copyOriginal.term && active.ws === copyOriginal.ws)).toBe(true);
    expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

async function prepareMouseCopy(page, index = 0, protocol = '\x1b[?1003h\x1b[?1006h') {
  await page.evaluate(async ({ index, protocol }) => {
    const term = panes[index].term;
    await new Promise(resolve => term.write(protocol + '\x1b[2J\x1b[HClaude copy by mouse selection\r\nSecond output line', resolve));
    selectMode = false; active.term.focus(); window.copied = '';
    document.execCommand = () => { copied = document.activeElement.value; return true; };
    sent.length = 0;
  }, { index, protocol });
  const box = await page.locator('.pane').nth(index).locator('.xterm-screen').boundingBox();
  const { cols, rows } = await page.evaluate(index => ({ cols: panes[index].term.cols, rows: panes[index].term.rows }), index);
  return { x: box.x + box.width / cols / 4, y: box.y + box.height / rows / 2, cell: box.width / cols, line: box.height / rows };
}

async function dragMouseCopy(page, point, modifier) {
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + 12 * point.cell, point.y, { steps: 8 });
  await page.mouse.up();
  if (modifier) await page.keyboard.up(modifier);
}

test('Claude copy works with ordinary drag while native mouse tracking is enabled', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page, 'demo03');
  const point = await prepareMouseCopy(page);
  await dragMouseCopy(page, point);
  const selected = await page.evaluate(() => active.term.getSelection());
  expect(selected).toContain('Claude copy');
  await page.mouse.move(point.x + 20 * point.cell, point.y + 2 * point.line);
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => copied)).toBe(selected);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input' && !/^\x1b\[<35;/.test(msg.data)))).toEqual([]);
  expectNoNativeChanges(fixture);
});

test('Claude copy focuses an inactive split before a forced Shift selection', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo02', 'demo03'], active: 'demo02' } });
  const point = await prepareMouseCopy(page, 1);
  await dragMouseCopy(page, point, 'Shift');
  expect(await page.evaluate(() => active.tab.id)).toBe('demo03');
  expect(await page.evaluate(() => document.activeElement === panes[1].term.textarea)).toBe(true);
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => copied)).toContain('Claude copy');
  expect(await page.evaluate(() => sent.some(msg => msg.type === 'input' && msg.data === '\x03'))).toBe(false);
  expectNoNativeChanges(fixture);
});

for (const [label, protocol, reports] of [
  ['SGR', '\x1b[?1003h\x1b[?1006h', ['\x1b[<0;1;1M', '\x1b[<0;1;1m']],
  ['SGR click tracking', '\x1b[?1000h\x1b[?1006h', ['\x1b[<0;1;1M', '\x1b[<0;1;1m']],
]) {
  test(`Claude mouse ${label} single click still reaches native menus exactly once`, async ({ page }) => {
    const fixture = await workspace(page); await openNative(page, 'demo03');
    const point = await prepareMouseCopy(page, 0, protocol);
    await page.mouse.move(point.x, point.y); await page.evaluate(() => { sent.length = 0; });
    await page.mouse.down();
    expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
    await page.mouse.up();
    expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input').map(msg => msg.data))).toEqual(reports);
    expect(await page.evaluate(() => active.term.hasSelection())).toBe(false);
    expectNoNativeChanges(fixture);
  });
}

test('Claude mouse explicit selection mode still suppresses native clicks', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page, 'demo03');
  const point = await prepareMouseCopy(page);
  await page.evaluate(() => { selectMode = true; updateSelectBtn(); });
  await page.mouse.click(point.x, point.y);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expectNoNativeChanges(fixture);
});

test('Claude mouse modified clicks retain native modifiers', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page, 'demo03');
  const point = await prepareMouseCopy(page);
  await page.mouse.move(point.x, point.y); await page.evaluate(() => { sent.length = 0; });
  await page.keyboard.down('Control'); await page.mouse.click(point.x, point.y); await page.keyboard.up('Control');
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input' && !(mouseReportButton(msg.data) & 32)).map(msg => msg.data))).toEqual(['\x1b[<16;1;1M', '\x1b[<16;1;1m']);
  expectNoNativeChanges(fixture);
});

for (const reason of ['blur', 'redraw', 'resize', 'wheel', 'switch', 'protocol', 'teardown', 'connection']) {
  test(`Claude mouse cancels pending menu clicks after ${reason}`, async ({ page }) => {
    const fixture = await workspace(page, 'dark', { initial: { panes: ['demo02', 'demo03'], active: 'demo03' } });
    const point = await prepareMouseCopy(page, 1);
    await page.mouse.move(point.x, point.y); await page.evaluate(() => { sent.length = 0; });
    await page.mouse.down();
    await page.evaluate(async reason => {
      const pane = panes[1], term = pane.term;
      if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      if (reason === 'redraw') await new Promise(resolve => term.write('\x1b[2;1HUpdated menu', resolve));
      if (reason === 'resize') term.resize(term.cols - 1, term.rows);
      if (reason === 'wheel') pane.host.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
      if (reason === 'switch') focusPane(panes[0]);
      if (reason === 'protocol') await new Promise(resolve => term.write('\x1b[?1003l\x1b[?1002h', resolve));
      if (reason === 'teardown') teardownPane(pane, true);
      if (reason === 'connection') {
        pane.ws = new WebSocket('ws://workspace.test/changed');
        await new Promise(resolve => { pane.ws.onopen = resolve; });
      }
    }, reason);
    await page.mouse.up();
    expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
    expect(await page.evaluate(() => panes[1].term?.__ccMouseSelection || null)).toBe(null);
    expectNoNativeChanges(fixture);
  });
}

test('Claude copy ordinary drag in another split does not use a stale selection', async ({ page }) => {
  const fixture = await workspace(page, 'dark', { initial: { panes: ['demo02', 'demo03'], active: 'demo02' } });
  const point = await prepareMouseCopy(page, 1);
  await page.evaluate(async () => {
    await new Promise(resolve => panes[0].term.write('Do not copy this old selection', resolve));
    panes[0].term.select(0, 0, 29);
  });
  await dragMouseCopy(page, point);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo03');
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => copied)).toContain('Claude copy');
  expect(await page.evaluate(() => copied)).not.toContain('old selection');
  await page.screenshot({ path: '/tmp/webcc-v110-copy-split.png' });
  expectNoNativeChanges(fixture);
});

test('Claude copy uses xterm for multiline wide-character drag selection', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page, 'demo03');
  const point = await prepareMouseCopy(page);
  await page.evaluate(() => new Promise(resolve => active.term.write('\x1b[H中文输出 ABC\r\n第二行内容 DEF', resolve)));
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + 18 * point.cell, point.y + point.line, { steps: 12 });
  await page.mouse.up(); await page.keyboard.press('Control+c');
  const copied = await page.evaluate(() => window.copied);
  expect(copied).toContain('中文输出 ABC'); expect(copied).toContain('第二行内容 DEF');
  expect(copied).toContain('\n');
  expect(await page.evaluate(() => sent.some(msg => msg.type === 'input' && msg.data === '\x03'))).toBe(false);
  expectNoNativeChanges(fixture);
});

test('Claude mouse selection cleanup survives remount and ordinary typing clears the selection', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page, 'demo03');
  await page.evaluate(() => { attachTerminal(active.tab, active); });
  await page.waitForFunction(() => active.ws?.readyState === 1);
  const point = await prepareMouseCopy(page);
  await dragMouseCopy(page, point);
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => copied)).toContain('Claude copy');
  await page.evaluate(() => { sent.length = 0; });
  await page.keyboard.press('x');
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input').map(msg => msg.data))).toEqual(['x']);
  expect(await page.evaluate(() => active.term.hasSelection())).toBe(false);
  await page.keyboard.press('Control+c');
  await expect(page.locator('#toast')).toContainText('请先选中');
  expect(await page.evaluate(() => sent.some(msg => msg.type === 'input' && msg.data === '\x03'))).toBe(false);
  expectNoNativeChanges(fixture);
});

for (const [id, platform, shortcut] of [['demo03', 'MacIntel', 'Meta+c'], ['demo02', 'Win32', 'Control+c']]) {
  test(`Claude copy default mouse path also works for ${id} on ${platform}`, async ({ page }) => {
    await page.addInitScript(platform => Object.defineProperty(navigator, 'platform', { value: platform }), platform);
    const fixture = await workspace(page); await openNative(page, id);
    const point = await prepareMouseCopy(page);
    await dragMouseCopy(page, point); await page.keyboard.press(shortcut);
    await expect.poll(() => page.evaluate(() => copied)).toContain('Claude copy');
    expect(await page.evaluate(() => sent.some(msg => msg.type === 'input' && msg.data === '\x03'))).toBe(false);
    expectNoNativeChanges(fixture);
  });
}

test('Claude copy double click selects a word without a second native activation', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page, 'demo03');
  const point = await prepareMouseCopy(page);
  await page.mouse.move(point.x, point.y); await page.evaluate(() => { sent.length = 0; });
  await page.mouse.dblclick(point.x + point.cell, point.y);
  expect(await page.evaluate(() => active.term.getSelection())).toBe('Claude');
  const nativeClicks = await page.evaluate(() => sent.filter(msg => msg.type === 'input' && !(mouseReportButton(msg.data) & 32)).map(msg => msg.data));
  expect(nativeClicks).toEqual(['\x1b[<0;2;1M', '\x1b[<0;2;1m']);
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => copied)).toBe('Claude');
  expectNoNativeChanges(fixture);
});

test('Claude mouse releasing outside the pane does not activate a native menu', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page, 'demo03');
  const point = await prepareMouseCopy(page);
  await page.mouse.move(point.x, point.y); await page.evaluate(() => { sent.length = 0; });
  await page.mouse.down(); await page.mouse.move(15, 15, { steps: 6 }); await page.mouse.up();
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(await page.evaluate(() => active.term.__ccMouseSelection)).toBe(null);
  expectNoNativeChanges(fixture);
});

test('Claude copy keeps a live selection when any-motion mouse reporting sends hover events', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page, 'demo03');
  await page.evaluate(async () => {
    await new Promise(resolve => active.term.write('\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[HClaude selection example', resolve));
    selectMode = false; active.term.focus();
    window.copied = ''; document.execCommand = () => { copied = document.activeElement.value; return true; };
  });
  const box = await page.locator('.xterm-screen').boundingBox();
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.evaluate(() => { active.term.select(0, 0, 'Claude selection example'.length); sent.length = 0; });
  await page.mouse.move(box.x + 100, box.y + 70);
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => copied)).toBe('Claude selection example');
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expectNoNativeChanges(fixture);
});

for (const [protocol, motion, wheel, click] of [
  ['SGR', '\x1b[<35;1;1M', '\x1b[<64;1;1M', '\x1b[<0;1;1M'],
  ['X10', '\x1b[MC!!', '\x1b[M`!!', '\x1b[M !!'],
  ['URXVT', '\x1b[67;1;1M', '\x1b[96;1;1M', '\x1b[32;1;1M'],
]) {
  test(`Claude copy preserves ${protocol} selections without swallowing clicks wheel or typing`, async ({ page }) => {
    const fixture = await workspace(page); await openNative(page, 'demo03');
    const result = await page.evaluate(async ({ motion, wheel, click }) => {
      const term = active.term, core = term._core.coreService;
      await new Promise(resolve => term.write('Selected output', resolve));
      selectMode = false; term.select(0, 0, 15); sent.length = 0;
      core.triggerDataEvent(motion, true);
      const selected = term.getSelection(), suppressed = sent.length === 0;
      core.triggerDataEvent(wheel, true);
      term.select(0, 0, 15); core.triggerDataEvent(click, true);
      const cleared = !term.hasSelection();
      core.triggerDataEvent(motion, true);
      term.select(0, 0, 15); core.triggerDataEvent('x', true);
      return { selected, suppressed, cleared, typedCleared: !term.hasSelection(), sent: sent.filter(msg => msg.type === 'input').map(msg => msg.data) };
    }, { motion, wheel, click });
    expect(result).toEqual({ selected: 'Selected output', suppressed: true, cleared: true, typedCleared: true, sent: [wheel, click, motion, 'x'] });
    expectNoNativeChanges(fixture);
  });
}

test('Claude copy works after a real Shift drag with mouse tracking enabled', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page, 'demo03');
  await page.evaluate(async () => {
    await new Promise(resolve => active.term.write('\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[HClaude copy by mouse selection', resolve));
    selectMode = false; active.term.focus(); window.copied = '';
    document.execCommand = () => { copied = document.activeElement.value; return true; };
  });
  const box = await page.locator('.xterm-screen').boundingBox();
  const { cols, rows } = await page.evaluate(() => ({ cols: active.term.cols, rows: active.term.rows }));
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + box.width / cols / 4, box.y + box.height / rows / 2);
  await page.mouse.down(); await page.mouse.move(box.x + 12 * box.width / cols, box.y + box.height / rows / 2, { steps: 8 });
  await page.mouse.up(); await page.keyboard.up('Shift');
  const selected = await page.evaluate(() => active.term.getSelection());
  expect(selected).toContain('Claude copy');
  await page.mouse.move(box.x + 120, box.y + 70);
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => copied)).toBe(selected);
  expect(await page.evaluate(() => sent.some(msg => msg.type === 'input' && msg.data === '\x03'))).toBe(false);
  expectNoNativeChanges(fixture);
});

test('native input tint stays painted through split Codex redraws and live output scrolling', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page); await nativeScreen(page);
  await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
  const result = await page.evaluate(async () => {
    const term = active.term, layer = active.host.querySelector('.cc-input-region');
    const start = Number(layer.dataset.start), write = data => new Promise(resolve => term.write(data, resolve));
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    let running = true, blanks = 0, frames = 0;
    const sample = () => { frames++; if (layer.hidden) blanks++; if (running) requestAnimationFrame(sample); };
    requestAnimationFrame(sample);
    for (let i = 0; i < 5; i++) {
      // A TUI redraw can move/hide its cursor before restoring the input row.
      await write('\x1b[?25l\x1b[2;1H\x1b[2KStreaming response ' + i);
      await sleep(35);
      await write(`\x1b[${start + 1};3H\x1b[?25h`);
      await sleep(75);
    }
    // xterm onScroll also fires when output follows the live bottom, not just
    // when the user moves into history.
    await write(`\x1b[${term.rows};1H\r\n\x1b[2J\x1b[H`);
    await write(`\x1b[${start + 1};1H› Review the latest changes\x1b[${start + 3};1H  Ready · Context 55% left\x1b[${start + 1};3H\x1b[?25h`);
    await sleep(150);
    running = false; await new Promise(requestAnimationFrame);
    return { blanks, frames, following: term.buffer.active.viewportY === term.buffer.active.baseY };
  });
  expect(result.frames).toBeGreaterThan(15);
  expect(result.following).toBe(true);
  expect(result.blanks).toBe(0);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('unchanged status and layout checks do not flash the tint or refresh all terminal rows', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page); await nativeScreen(page);
  await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
  await page.waitForTimeout(200);
  const result = await page.evaluate(async () => {
    const term = active.term, refresh = term.refresh.bind(term), layer = active.host.querySelector('.cc-input-region');
    let refreshes = 0, hidden = 0;
    term.refresh = (...args) => { refreshes++; return refresh(...args); };
    for (let i = 0; i < 4; i++) {
      setStatus('connected', 'Connected', active); refitAll(); renderAllCodexUsage();
      await new Promise(requestAnimationFrame);
      if (layer.hidden) hidden++;
    }
    term.refresh = refresh;
    return { refreshes, hidden };
  });
  expect(result).toEqual({ refreshes: 0, hidden: 0 });
  expect(fixture.errors).toEqual([]);
});

test('redraw grace expires on sustained unknown output and never delays known history or disconnect hiding', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page); await nativeScreen(page);
  const region = page.locator('.cc-input-region:not([hidden])');
  await expect(region).toHaveCount(1);
  await page.evaluate(async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => active.term.write('\x1b[?25l\x1b[2;1HStill drawing', resolve));
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  });
  await expect(region).toHaveCount(0);
  await nativeScreen(page); await expect(region).toHaveCount(1);
  await nativeScreen(page, { hidden: true, above: 'Earlier messages available. esc latest' });
  await expect(region).toHaveCount(0, { timeout: 120 });
  await nativeScreen(page); await expect(region).toHaveCount(1);
  expect(await page.evaluate(() => { setStatus('reconnecting', 'Reconnecting', active); return active.host.querySelector('.cc-input-region').hidden; })).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test('real viewport history hides the input tint but automatic bottom-follow scrolling does not', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page);
  await page.evaluate(() => new Promise(resolve => active.term.write('Synthetic history\r\n'.repeat(active.term.rows + 40), resolve)));
  await nativeScreen(page); const region = page.locator('.cc-input-region:not([hidden])');
  await expect(region).toHaveCount(1);
  const moved = await page.evaluate(() => {
    active.term.scrollLines(-3);
    return { history: active.term.buffer.active.viewportY < active.term.buffer.active.baseY, hidden: active.host.querySelector('.cc-input-region').hidden };
  });
  expect(moved).toEqual({ history: true, hidden: true });
  await page.evaluate(() => active.term.scrollToBottom());
  await expect(region).toHaveCount(1);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('stable input geometry is not rewritten on every Codex output frame', async ({ page }) => {
  const fixture = await workspace(page); await selectStyle(page, 'glass'); await openNative(page); await nativeScreen(page);
  await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
  await page.waitForTimeout(150);
  const mutations = await page.evaluate(async () => {
    const layer = active.host.querySelector('.cc-input-region'), start = Number(layer.dataset.start);
    let mutations = 0;
    const observer = new MutationObserver(records => { mutations += records.length; });
    observer.observe(layer, { attributes: true });
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => active.term.write(`\x1b[2;1H\x1b[2KResponse ${i}\x1b[${start + 1};3H`, resolve));
      await new Promise(resolve => setTimeout(resolve, 70));
    }
    observer.disconnect(); return mutations;
  });
  expect(mutations).toBe(0);
  expect(fixture.errors).toEqual([]);
});

test('real pane and font resizes still repaint and reconnects still send the terminal size', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page);
  await page.waitForTimeout(200);
  const result = await page.evaluate(() => {
    const p = active, term = p.term, refresh = term.refresh.bind(term);
    let refreshes = 0;
    term.refresh = (...args) => { refreshes++; return refresh(...args); };
    const width = p.host.getBoundingClientRect().width;
    p.host.style.width = (width - 80) + 'px'; refit(p);
    const afterResize = refreshes;
    term.options.fontSize += 1; refit(p);
    const afterFont = refreshes;
    const originalSocket = p.ws;
    p.ws = { readyState: 1, send: data => sent.push({ ...JSON.parse(data), socket: 'replacement' }) };
    refit(p);
    const afterReconnect = refreshes;
    p.ws = originalSocket; term.refresh = refresh;
    return { afterResize, afterFont, afterReconnect, sizes: sent.filter(msg => msg.socket === 'replacement') };
  });
  expect(result.afterResize).toBeGreaterThan(0);
  expect(result.afterFont).toBeGreaterThan(result.afterResize);
  expect(result.afterReconnect).toBe(result.afterFont);
  expect(result.sizes).toHaveLength(1);
  expect(result.sizes[0].type).toBe('resize');
  expect(fixture.errors).toEqual([]);
});

test('overnight terminal wake rebuilds the display stream and rejects stale frames without native input', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page);
  await page.evaluate(async () => {
    window.wakePane = active; window.wakeTerm = active.term; window.sleepSocket = active.ws;
    window.wakeCount = socketCount; window.wakeMessages = sent.length;
    await new Promise(resolve => active.term.write('\x1b[?1049h\x1b[2J\x1b[HOld screen\x1b[31', resolve));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.socketFrame = 'Recovered terminal\r\nReady for input';
  });
  await page.clock.setFixedTime(new Date(Date.now() + 8 * 3600000));
  await page.evaluate(() => {
    delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => active.ws !== sleepSocket && active.ws?.readyState === 1);
  await page.evaluate(async () => {
    sleepSocket.onmessage({ data: new TextEncoder().encode('LATE OLD FRAME').buffer });
    sleepSocket.onclose(); sleepSocket.onopen();
    await new Promise(resolve => active.term.write('', resolve));
  });
  const result = await page.evaluate(() => ({
    samePane: active === wakePane, sameTerm: active.term === wakeTerm, oldClosed: sleepSocket.readyState === 3,
    connections: socketCount - wakeCount, state: active.connectionState,
    screen: Array.from({ length: active.term.rows }, (_, i) => active.term.buffer.active.getLine(i)?.translateToString()).join('\n'),
    messages: sent.slice(wakeMessages), retryPending: !!active._reconnectTimer,
  }));
  expect(result.samePane && result.sameTerm && result.oldClosed).toBe(true);
  expect(result.connections).toBe(1); expect(result.state).toBe('connected'); expect(result.retryPending).toBe(false);
  expect(result.screen).toContain('Recovered terminal'); expect(result.screen).toContain('Ready for input');
  expect(result.screen).not.toContain('Old screen'); expect(result.screen).not.toContain('LATE OLD FRAME');
  expect(result.messages.map(message => message.type)).toEqual(['resize']);
  expect(fixture.requests.filter(request => request.method === 'POST' && /\/api\/sessions/.test(request.path))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('brief tab switches repaint without replacing terminal connections or sending input', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(() => {
    window.sleepSocket = active.ws; window.wakeCount = socketCount; window.wakeMessages = sent.length;
    window.wakeRefreshes = 0;
    const refresh = active.term.refresh.bind(active.term);
    active.term.refresh = (...args) => { wakeRefreshes++; return refresh(...args); };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.setFixedTime(new Date(Date.now() + 5000));
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  expect(await page.evaluate(() => active.ws === sleepSocket && socketCount === wakeCount && wakeRefreshes > 0)).toBe(true);
  expect(await page.evaluate(() => sent.slice(wakeMessages))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('wake restores all displayed splits without changing layout focus or dirty files', async ({ page }) => {
  const fixture = await workspace(page);
  await chooseSplits(page, ['demo01', 'demo02', 'demo03']);
  await page.waitForFunction(() => panes.every(p => p.ws?.readyState === 1));
  await page.locator('[data-panel="files"]').click();
  await page.locator('.ws-row[data-file="/workspace/demo/index.js"]').click();
  await page.locator('#ws-editor-text').fill('unsaved overnight edit');
  await page.evaluate(() => {
    window.beforeWake = panes.map(p => ({ pane: p, term: p.term, ws: p.ws, id: p.tab.id }));
    window.focusBeforeWake = active; window.countBeforeWake = socketCount; window.wakeMessages = sent.length;
    document.getElementById('ws-editor-text').focus();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.setFixedTime(new Date(Date.now() + 8 * 3600000));
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => panes.every((p, i) => p.ws !== beforeWake[i].ws && p.ws?.readyState === 1));
  expect(await page.evaluate(() => ({
    same: panes.every((p, i) => p === beforeWake[i].pane && p.term === beforeWake[i].term && p.tab.id === beforeWake[i].id),
    active: active === focusBeforeWake, focus: document.activeElement.id, count: socketCount - countBeforeWake,
    inputs: sent.slice(wakeMessages).filter(message => message.type !== 'resize'),
  }))).toEqual({ same: true, active: true, focus: 'ws-editor-text', count: 3, inputs: [] });
  await expect(page.locator('#ws-editor-text')).toHaveValue('unsaved overnight edit');
  expect(fixture.errors).toEqual([]);
});

test('computer sleep with no visibility event is detected once without reconnecting every timer tick', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(() => { window.sleepSocket = active.ws; window.wakeCount = socketCount; });
  await page.clock.setFixedTime(new Date(Date.now() + 8 * 3600000));
  await page.waitForFunction(() => active.ws !== sleepSocket && active.ws?.readyState === 1, null, { timeout: 20000 });
  await page.evaluate(() => { window.afterWakeSocket = active.ws; });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => active.ws === afterWakeSocket && socketCount === wakeCount + 1)).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test('network restoration while hidden is deferred and duplicate wake events only reconnect once', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(() => {
    window.sleepSocket = active.ws; window.wakeCount = socketCount;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
  });
  expect(await page.evaluate(() => active.ws === sleepSocket && socketCount === wakeCount)).toBe(true);
  await page.evaluate(() => {
    delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus'));
  });
  await page.waitForFunction(() => active.ws !== sleepSocket && active.ws?.readyState === 1);
  expect(await page.evaluate(() => socketCount - wakeCount)).toBe(1);
  expect(fixture.errors).toEqual([]);
});

test('normal pageshow and foreground polling do not reset healthy terminal streams', async ({ page }) => {
  const fixture = await workspace(page);
  await page.clock.install();
  await page.evaluate(() => { window.sleepSocket = active.ws; window.wakeCount = socketCount; });
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    resumeTerminalViews(); resumeTerminalViews();
  });
  await page.clock.fastForward(15000);
  expect(await page.evaluate(() => active.ws === sleepSocket && socketCount === wakeCount)).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test('ordinary disconnection resets partial terminal sequences and retires old socket callbacks', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(async () => {
    window.sleepSocket = active.ws; window.wakeCount = socketCount; window.wakeMessages = sent.length;
    window.socketFrame = 'Reconnected clean screen';
    await new Promise(resolve => active.term.write('Old bytes\x1b[31', resolve));
    sleepSocket.close(); sleepSocket.onclose(); sleepSocket.onerror();
  });
  await page.waitForFunction(() => active.ws !== sleepSocket && active.ws?.readyState === 1);
  await page.evaluate(async () => {
    sleepSocket.onclose(); sleepSocket.onmessage({ data: new TextEncoder().encode('Wrong frame').buffer });
    await new Promise(resolve => active.term.write('', resolve));
  });
  expect(await page.evaluate(() => ({
    count: socketCount - wakeCount, pending: !!active._reconnectTimer,
    screen: active.term.buffer.active.getLine(0).translateToString(true),
    messages: sent.slice(wakeMessages).map(message => message.type),
  }))).toEqual({ count: 1, pending: false, screen: 'Reconnected clean screen', messages: ['resize'] });
  expect(fixture.errors).toEqual([]);
});

for (const [name, suffix] of [
  ['OSC title', [27, 93, 48, 59, 112, 97, 114, 116, 105, 97, 108]],
  ['DCS string', [27, 80, 113, 112, 97, 114, 116, 105, 97, 108]],
  ['UTF-8 character', [228, 184]],
]) test(`reconnect discards an incomplete ${name} without losing the new frame`, async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(async suffix => {
    await new Promise(resolve => active.term.write(new Uint8Array(suffix), resolve));
    window.sleepSocket = active.ws;
    window.socketFrame = 'Fresh complete frame';
    active._resumeConnection();
  }, suffix);
  await page.waitForFunction(() => active.ws !== sleepSocket && active.ws?.readyState === 1);
  await page.evaluate(() => new Promise(resolve => active.term.write('', resolve)));
  expect(await page.evaluate(() => active.term.buffer.active.getLine(0).translateToString(true))).toBe('Fresh complete frame');
  expect(fixture.errors).toEqual([]);
});

test('a long window blur reconnects even when the document remained visible', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(() => { window.sleepSocket = active.ws; window.dispatchEvent(new Event('blur')); });
  await page.clock.setFixedTime(new Date(Date.now() + 8 * 3600000));
  await page.evaluate(() => { terminalClockAt = Date.now(); window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => active.ws !== sleepSocket && active.ws?.readyState === 1);
  expect(fixture.errors).toEqual([]);
});

test('wake sizes a temporarily hidden split from its last valid terminal dimensions', async ({ page }) => {
  const fixture = await workspace(page);
  await chooseSplits(page, ['demo01', 'demo02']);
  await page.waitForFunction(() => panes.every(p => p.ws?.readyState === 1));
  await page.evaluate(() => {
    window.hiddenPane = panes.find(p => p !== active); hiddenPane.el.style.display = 'none';
    window.sleepSocket = hiddenPane.ws; window.wakeMessages = sent.length;
    hiddenPane._resumeConnection();
  });
  await page.waitForFunction(() => hiddenPane.ws !== sleepSocket && hiddenPane.ws?.readyState === 1);
  const result = await page.evaluate(() => ({
    messages: sent.slice(wakeMessages).map(message => ({ type: message.type, cols: message.cols, rows: message.rows })),
    expected: { type: 'resize', cols: hiddenPane.term.cols, rows: hiddenPane.term.rows },
  }));
  expect(result.messages).toEqual([result.expected]);
  expect(fixture.errors).toEqual([]);
});

for (const theme of ['dark', 'light']) test(`mobile ${theme} wake restores readable output without opening the keyboard`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const fixture = await workspace(page, theme);
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    document.activeElement?.blur(); window.sleepSocket = active.ws;
    window.socketFrame = '\x1b[?1049h\x1b[2J\x1b[HRecovered terminal\r\n\r\nReady for input';
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await page.waitForFunction(() => active.ws !== sleepSocket && active.ws?.readyState === 1);
  await page.evaluate(() => new Promise(resolve => active.term.write('', resolve)));
  expect(await page.evaluate(() => active.term.buffer.active.getLine(0).translateToString(true))).toBe('Recovered terminal');
  expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/webcc-v105-wake-mobile-${theme}.png` });
  expect(fixture.errors).toEqual([]);
  await context.close();
});

test('closing or reassigning a pane during wake cannot resurrect its old session', async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(() => {
    window.sleepSocket = active.ws; window.wakeCount = socketCount;
    window.oldTerm = active.term; window.oldResets = 0;
    const reset = oldTerm.reset.bind(oldTerm);
    oldTerm.reset = () => { oldResets++; reset(); };
    active._resumeConnection();
    attachTerminal(state.tabs.find(tab => tab.id === 'demo03'), active);
    sleepSocket.onclose();
  });
  await page.waitForFunction(() => active?.ws?.readyState === 1);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => ({ id: active.tab.id, count: socketCount - wakeCount, resets: oldResets }))).toEqual({ id: 'demo03', count: 1, resets: 0 });
  await page.evaluate(() => {
    window.wakeCount = socketCount;
    active._resumeConnection(); closeActiveView();
    window.dispatchEvent(new Event('online'));
  });
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => ({ count: socketCount - wakeCount, panes: panes.length }))).toEqual({ count: 0, panes: 0 });
  expect(fixture.errors).toEqual([]);
});

test('a connection that never opens times out and retries without duplicate sockets', async ({ page }) => {
  const fixture = await workspace(page);
  await page.clock.install();
  await page.evaluate(() => { window.holdSockets = true; active._resumeConnection(); });
  await page.clock.runFor(50);
  await page.evaluate(() => { window.sleepSocket = active.ws; window.wakeCount = socketCount; });
  await page.clock.fastForward(15000);
  expect(await page.evaluate(() => active.connectionState)).toBe('reconnecting');
  await page.evaluate(() => { window.holdSockets = false; });
  await page.clock.runFor(1200);
  expect(await page.evaluate(() => ({ count: socketCount - wakeCount, state: active.connectionState, replaced: active.ws !== sleepSocket })))
    .toEqual({ count: 1, state: 'connected', replaced: true });
  expect(fixture.errors).toEqual([]);
});

test('three streaming panes keep their input backgrounds, terminals and sockets without blank frames', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const fixture = await workspace(page); await selectStyle(page, 'glass');
  await page.getByRole('button', { name: '收起任务面板', exact: true }).click();
  await chooseSplits(page, ['demo02', 'demo03', 'demo01']);
  await page.waitForFunction(() => panes.every(p => p.connectionState === 'connected'));
  await page.waitForTimeout(200);
  await nativeScreen(page, { id: 'demo02' }); await nativeScreen(page, { id: 'demo03' });
  await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(2);
  const result = await page.evaluate(async () => {
    const kept = panes.map(pane => ({ pane, term: pane.term, ws: pane.ws })), count = socketCount;
    const targets = panes.filter(pane => pane.host.querySelector('.cc-input-region'));
    let running = true, blanks = 0;
    const sample = () => { if (targets.some(p => p.host.querySelector('.cc-input-region').hidden)) blanks++; if (running) requestAnimationFrame(sample); };
    requestAnimationFrame(sample);
    for (let i = 0; i < 6; i++) {
      for (const p of targets) await new Promise(resolve => p.term.write('\x1b[?25l\x1b[1;1H\x1b[2KStreaming response ' + i, resolve));
      await new Promise(resolve => setTimeout(resolve, 35));
      for (const p of targets) {
        const start = Number(p.host.querySelector('.cc-input-region').dataset.start);
        await new Promise(resolve => p.term.write(`\x1b[${start + 1};3H\x1b[?25h`, resolve));
      }
      refitAll();
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    running = false; await new Promise(requestAnimationFrame);
    return { blanks, unchanged: socketCount === count && kept.every(p => panes.includes(p.pane) && p.pane.term === p.term && p.pane.ws === p.ws) };
  });
  expect(result).toEqual({ blanks: 0, unchanged: true });
  await assertTiled(page);
  await page.screenshot({ path: '/tmp/webcc-v96-three-pane-redraw.png' });
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const theme of ['dark', 'light']) {
  for (const width of [390, 1440]) {
    test(`${theme} Codex redraw has a stable input background pixel at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => localStorage.setItem('cc_terminal_style', 'glass'));
      const fixture = await workspace(page, theme); await openNative(page); await nativeScreen(page);
      const region = page.locator('.cc-input-region:not([hidden])'); await expect(region).toHaveCount(1);
      await page.waitForTimeout(200);
      const box = await region.boundingBox();
      await page.evaluate(() => {
        const term = active.term, start = Number(active.host.querySelector('.cc-input-region').dataset.start);
        window.redrawLoop = setInterval(() => {
          term.write('\x1b[?25l\x1b[1;1H\x1b[2KStreaming response');
          setTimeout(() => term.write(`\x1b[${start + 1};3H\x1b[?25h`), 35);
        }, 110);
      });
      try {
        for (let i = 0; i < 6; i++) {
          const shot = await page.screenshot({ clip: { x: Math.floor(box.x + box.width - 8), y: Math.floor(box.y + box.height / 2), width: 2, height: 2 } });
          const pixel = await page.evaluate(async base64 => {
            const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
            const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
            return [...context.getImageData(0, 0, 1, 1).data];
          }, shot.toString('base64'));
          expect(pixel).toEqual(theme === 'dark' ? [46, 48, 66, 255] : [224, 229, 239, 255]);
        }
      } finally { await page.evaluate(() => clearInterval(window.redrawLoop)); }
      expect(fixture.errors).toEqual([]);
    });
  }
}

test('native input tint shades only the Codex input and leaves text, ANSI cells, terminal identity and sockets unchanged', async ({ page }) => {
  const fixture = await workspace(page);
  await selectStyle(page, 'glass'); await openNative(page);
  const before = await page.evaluate(() => { window.original = { term: active.term, ws: active.ws, count: socketCount }; return sent.filter(m => m.type === 'input').length; });
  const expected = await nativeScreen(page);
  const region = page.locator('.cc-input-region:not([hidden])');
  await expect(region).toHaveCount(1);
  await expect(region).toHaveAttribute('data-start', String(expected.start));
  await expect(region).toHaveAttribute('data-end', String(expected.end));
  expect(await region.evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
  const shot = await region.screenshot();
  const pixel = await page.evaluate(async base64 => {
    const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    return [...context.getImageData(image.width - 8, Math.floor(image.height / 2), 1, 1).data];
  }, shot.toString('base64'));
  expect(pixel).toEqual([46, 48, 66, 255]);
  expect(await page.evaluate(() => active.term === original.term && active.ws === original.ws && socketCount === original.count)).toBe(true);
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input').length)).toBe(before);
  expect(await page.evaluate(() => active.term.buffer.active.getLine(active.term.buffer.active.baseY + Number(document.querySelector('.cc-input-region:not([hidden])').dataset.start)).translateToString())).toContain('Review the latest changes');
  expect(fixture.requests.filter(r => r.path.startsWith('/api/sessions/') && r.method !== 'GET')).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('native input tint follows multiline drafts even when the cursor is on their first row and keeps explicit backgrounds', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page);
  let expected = await nativeScreen(page, { draft: ['第一行', 'Second line', 'Third line'], cursor: 0 });
  const region = page.locator('.cc-input-region:not([hidden])');
  await expect(region).toHaveAttribute('data-end', String(expected.end));
  const firstHeight = (await region.boundingBox()).height;
  expected = await nativeScreen(page, { draft: ['First', 'Second', '\x1b[48;2;80;40;50mThird\x1b[0m', 'Fourth', 'Fifth'], cursor: 2 });
  await expect(region).toHaveAttribute('data-end', String(expected.end));
  expect((await region.boundingBox()).height).toBeGreaterThan(firstHeight);
  expect(await page.evaluate(({ start }) => active.term.buffer.active.getLine(active.term.buffer.active.baseY + start + 2).getCell(2).getBgColor(), expected)).toBe((80 << 16) | (40 << 8) | 50);
  expect(fixture.errors).toEqual([]);
});

test('native input tint recognizes Claude rules and requires matching native footer evidence', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page, 'demo03');
  const expected = await nativeScreen(page, { id: 'demo03', draft: ['Check the test results', 'Include the failing cases'], cursor: 1 });
  const region = page.locator('.cc-input-region:not([hidden])');
  await expect(region).toHaveAttribute('data-start', String(expected.start));
  await expect(region).toHaveAttribute('data-end', String(expected.end));
  await page.evaluate(() => new Promise(resolve => active.term.write(`\x1b[${Number(document.querySelector('.cc-input-region:not([hidden])').dataset.start)};1H\x1b[2K`, resolve)));
  await expect(region).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

for (const kind of ['codex', 'claude']) {
  test(`${kind} native input tint rejects approval choices, model menus, missing footers and shell output`, async ({ page }) => {
    const fixture = await workspace(page); const id = kind === 'codex' ? 'demo02' : 'demo03'; await openNative(page, id);
    await nativeScreen(page, { id }); await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
    await nativeScreen(page, { id, draft: ['1. Allow once', '2. Cancel'], cursor: 0 });
    await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(0);
    await nativeScreen(page, { id, above: 'Select a model' });
    await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(0);
    await page.evaluate(() => new Promise(resolve => active.term.write('\x1b[2J\x1b[H› This is ordinary output\r\n$ ', resolve)));
    await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(0);
    await nativeScreen(page, { id, draft: ['Do you want to review these changes?'], above: 'Would you like to continue?' });
    await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
    await nativeScreen(page, { id, draft: ['1. Inspect the files', '2. Run the tests'], cursor: 1 });
    await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
    expect(fixture.errors).toEqual([]);
  });
}

test('native input tint hides for earlier-message and tmux history markers and returns on the live prompt', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page);
  for (const options of [{ above: '↓ Back to bottom · esc' }, { above: 'Earlier messages available. esc latest' }, { copy: true }]) {
    await nativeScreen(page); await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
    await nativeScreen(page, options); await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(0);
    await page.waitForTimeout(400); await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(0);
  }
  await nativeScreen(page); await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
  expect(fixture.errors).toEqual([]);
});

test('native input tint never blocks wheel, keyboard confirmation or selection and pauses during native history scrolling', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page); await nativeScreen(page);
  await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
  await page.locator('.pane-host').hover(); await page.mouse.wheel(0, -150);
  await expect.poll(() => page.evaluate(() => sent.filter(msg => msg.type === 'scroll').length)).toBeGreaterThan(0);
  await nativeScreen(page, { above: 'Earlier messages available. esc latest' });
  await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(0);
  await nativeScreen(page); await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
  await page.evaluate(() => active.term.select(2, Number(document.querySelector('.cc-input-region:not([hidden])').dataset.start), 6));
  await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(0);
  await page.evaluate(() => active.term.clearSelection()); await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
  await page.evaluate(() => active.term.focus()); await page.keyboard.press('Enter');
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input').map(msg => msg.data))).toEqual(['\r']);
  expect(fixture.errors).toEqual([]);
});

test('native input tint hides a hidden or displaced cursor and disconnected, restarting or replaced terminals', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page);
  await nativeScreen(page); await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
  await nativeScreen(page, { hidden: true }); await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(0);
  await nativeScreen(page); await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
  await page.evaluate(() => new Promise(resolve => active.term.write('\x1b[2;1H', resolve)));
  await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(0);
  await nativeScreen(page); await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
  await page.evaluate(() => { setStatus('reconnecting', 'Reconnecting', active); });
  await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(0);
  await page.evaluate(() => { setStatus('connected', 'Connected', active); });
  await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
  await page.evaluate(() => { active.el.classList.add('restarting'); ccNativeInput.sync(); });
  await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(0);
  await page.evaluate(() => { active.el.classList.remove('restarting'); ccNativeInput.sync(); });
  await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
  await page.evaluate(() => { window.oldInputLayer = document.querySelector('.cc-input-region'); });
  await openNative(page, 'demo04');
  expect(await page.evaluate(() => !oldInputLayer.isConnected)).toBe(true);
  await expect(page.locator('.cc-input-region')).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test('native input tint setting persists and reacts to storage, visibility and forced-color changes without losing preference', async ({ page }) => {
  const fixture = await workspace(page); await openNative(page); await nativeScreen(page);
  await page.locator('button[data-panel="settings"]').click();
  await expect(page.locator('#cc-input-tint')).toBeChecked();
  await page.locator('#cc-input-tint').uncheck(); await expect(page.locator('.cc-input-region')).toHaveCount(0);
  await page.reload(); await page.waitForFunction(() => ccWorkspace?.ready);
  await page.locator('button[data-panel="settings"]').click(); await expect(page.locator('#cc-input-tint')).not.toBeChecked();
  await openNative(page); await nativeScreen(page); await expect(page.locator('.cc-input-region')).toHaveCount(0);
  await page.evaluate(() => { localStorage.removeItem('cc_terminal_input_tint'); dispatchEvent(new StorageEvent('storage', { key: 'cc_terminal_input_tint', storageArea: localStorage })); });
  await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
  await page.emulateMedia({ forcedColors: 'active' }); await expect(page.locator('.cc-input-region')).toHaveCount(0);
  await page.emulateMedia({ forcedColors: 'none' }); await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('.cc-input-region')).toHaveCount(0);
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('native input tint supports Codex and Claude splits together and releases only the removed pane', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await workspace(page);
  await selectStyle(page, 'glass');
  await page.getByRole('button', { name: '收起任务面板', exact: true }).click();
  await chooseSplits(page, ['demo02', 'demo03']);
  await page.waitForFunction(() => panes.every(p => p.connectionState === 'connected'));
  await nativeScreen(page, { id: 'demo02', draft: ['Review the latest changes', 'Keep the existing session'], cursor: 1 });
  await nativeScreen(page, { id: 'demo03', draft: ['Check the failing tests', 'Include a short summary'], cursor: 1 });
  await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(2);
  await page.evaluate(() => { window.keptNative = { term: panes[1].term, ws: panes[1].ws, layer: panes[1].host.querySelector('.cc-input-region') }; focusPane(panes[0], false); });
  await page.screenshot({ path: '/tmp/webcc-v94-native-input-splits.png' });
  await page.evaluate(() => toggleTheme());
  await expect(page.locator('.cc-input-region:not([hidden])')).toHaveCount(2);
  await page.evaluate(() => closePane(panes[0]));
  expect(await page.evaluate(() => active.term === keptNative.term && active.ws === keptNative.ws && keptNative.layer.isConnected)).toBe(true);
  await expect(page.locator('.cc-input-region')).toHaveCount(1);
  expect(await page.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('native input tint does not capture touch movement or open the keyboard over mobile confirmation controls', async ({ page, browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await context.newPage();
  try {
    const fixture = await workspace(phone); await openNative(phone); await nativeScreen(phone);
    await expect(phone.locator('.cc-input-region:not([hidden])')).toHaveCount(1);
    const box = await phone.locator('.cc-input-region:not([hidden])').boundingBox(), client = await context.newCDPSession(phone);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 60, y: box.y + 10 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + 60, y: box.y + 75 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => phone.evaluate(() => sent.filter(msg => msg.type === 'scroll').length)).toBeGreaterThan(0);
    expect(await phone.evaluate(() => sent.filter(msg => msg.type === 'input'))).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally { await context.close(); }
});

for (const theme of ['dark', 'light']) {
  for (const width of [320, 390, 1440]) {
    test(`${theme} native input tint stays aligned at ${width}px with original native controls`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await workspace(page, theme);
      if (width <= 820) await page.locator('#ws-mobile-deck').click();
      await selectStyle(page, 'glass');
      await page.getByRole('button', { name: '收起任务面板', exact: true }).click();
      await openNative(page); const expected = await nativeScreen(page, { draft: ['Check the changes', 'Keep the existing session'], cursor: 1 });
      const region = page.locator('.cc-input-region:not([hidden])');
      await expect(region).toHaveAttribute('data-start', String(expected.start));
      const box = await region.boundingBox(), host = await page.locator('.pane-host').boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(host.x); expect(box.x + box.width).toBeLessThanOrEqual(host.x + host.width + 1);
      expect(box.y).toBeGreaterThanOrEqual(host.y); expect(box.y + box.height).toBeLessThanOrEqual(host.y + host.height + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: `/tmp/webcc-v94-native-input-${theme}-${width}.png` });
      await page.setViewportSize({ width, height: 640 });
      await nativeScreen(page); await expect(region).toBeVisible();
      const resized = await region.boundingBox(); expect(resized.y + resized.height).toBeLessThanOrEqual(640);
      expect(fixture.errors).toEqual([]);
    });
  }
}

for (const id of ['demo01', 'demo02', 'demo03', 'demo04']) test(`recovered ${id} retains copy protection keyboard input and wheel routing`, async ({ page }) => {
  const fixture = await workspace(page);
  await page.evaluate(id => { if (active.tab.id !== id) attachTerminal(state.tabs.find(tab => tab.id === id), active); }, id);
  await page.waitForFunction(() => active.ws?.readyState === 1);
  await page.evaluate(() => {
    window.sleepSocket = active.ws; window.oldSends = 0;
    sleepSocket.send = () => { oldSends++; };
    active._resumeConnection();
  });
  await page.waitForFunction(() => active.ws !== sleepSocket && active.ws?.readyState === 1);
  await page.evaluate(() => {
    window.recoveredMessages = [];
    const ws = active.ws, send = ws.send.bind(ws);
    ws.send = data => { recoveredMessages.push(JSON.parse(data)); send(data); };
    active.term.focus();
  });
  await page.keyboard.press('Control+c');
  expect(await page.evaluate(() => recoveredMessages.filter(message => message.type === 'input'))).toEqual([]);
  await page.keyboard.type('manual input');
  expect(await page.evaluate(() => recoveredMessages.filter(message => message.type === 'input').map(message => message.data).join(''))).toBe('manual input');
  await page.locator('.pane-host').dispatchEvent('wheel', { deltaY: 3, deltaMode: 1, bubbles: true, cancelable: true });
  expect(await page.evaluate(() => recoveredMessages.filter(message => message.type === 'scroll').length)).toBe(1);
  expect(await page.evaluate(() => oldSends)).toBe(0);
  expect(fixture.errors).toEqual([]);
});
