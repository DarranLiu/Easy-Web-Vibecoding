const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { workspace } = require('./workspace.fixture.cjs');

function screens(revision = 3) {
  return { revision, screenSchema: 1, activeScreen: 'second', panes: ['demo03'], active: 'demo03', direction: 'auto', ratios: {}, screens: [
    { id: 'first', name: 'Build', panes: ['demo04', 'demo01', 'demo02'], active: 'demo02', direction: 'row', ratios: { cols: [1, 2], rows: [1, 3, 1, 1] }, maximized: 2 },
    { id: 'second', name: 'Review', panes: ['demo03'], active: 'demo03', direction: 'auto', ratios: {}, maximized: null },
    { id: 'empty', name: 'Later', panes: [], active: null, direction: 'auto', ratios: {}, maximized: null },
  ] };
}

for (const theme of ['dark', 'light']) for (const width of [320, 1440]) test(`Token layout controls fit ${theme} ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const kind = width < 821 ? 'mobile' : 'desktop';
  const fixture = await workspace(page, theme, {
    layouts: { ['/api/layouts/' + kind + '_original']: screens() },
    tokenBindings: { ['test-token:' + kind]: { enabled: true, device: kind + '_original', revision: 1 } },
  });
  const user = page.locator('#ws-layout-user');
  await expect(user).toHaveText('Token 布局');
  const bounds = await user.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/webcc-v117-token-${theme}-${width}.png` });
  noNativeActions(fixture);
});

function noNativeActions(fixture) {
  expect(fixture.errors).toEqual([]);
  expect(fixture.requests.filter(r => r.method !== 'GET' && /\/api\/(sessions|session-lookup)/.test(r.path))).toEqual([]);
}

async function activeState(page) {
  return page.evaluate(() => ({ panes: panes.map(p => p.tab?.id || p.savedId || null), active: active?.tab?.id || null,
    maximized: maximizedPane?.tab?.id || null, direction: paneDirMode(), ratios: gridFr }));
}

test('Token restores all screens in a fresh browser context with no cookies, storage or layout URL', async ({ page, browser }) => {
  const tokenBindings = {}, layouts = { '/api/layouts/desktop_original': screens() };
  const first = await workspace(page, 'dark', { identity: 'original', layouts, tokenBindings });
  await page.locator('[data-screen="first"]').click();
  await page.evaluate(() => ccWorkspace.persist());
  const expected = await activeState(page);
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    const second = await workspace(other, 'light', { layouts, tokenBindings });
    expect(await activeState(other)).toEqual(expected);
    await expect(other.locator('#ws-screen-tabs [role=tab]')).toContainText(['Build', 'Review', 'Later']);
    await expect(other.locator('[data-screen="first"]')).toHaveAttribute('aria-selected', 'true');
    expect(second.requests.filter(r => r.method === 'PUT')).toEqual([]);
    await other.screenshot({ path: '/tmp/webcc-v117-token-desktop.png' });
    await other.locator('[data-screen="empty"]').click();
    await expect(other.locator('#empty')).toBeVisible();
    await other.reload();
    await expect(other.locator('[data-screen="empty"]')).toHaveAttribute('aria-selected', 'true');
    await expect(other.locator('#empty')).toBeVisible();
    noNativeActions(second);
  } finally { await context.close(); }
  noNativeActions(first);
});

test('Token restores after the entire browser process is closed and a different empty profile is opened', async () => {
  test.setTimeout(60000);
  const directories = [fs.mkdtempSync(path.join(os.tmpdir(), 'webcc-restart-a-')), fs.mkdtempSync(path.join(os.tmpdir(), 'webcc-restart-b-'))];
  const tokenBindings = {}, layouts = { '/api/layouts/desktop_original': screens() };
  let context;
  try {
    context = await chromium.launchPersistentContext(directories[0], { headless: true, executablePath: process.env.CHROME_PATH, viewport: { width: 1280, height: 800 } });
    let page = await context.newPage();
    const before = await workspace(page, 'dark', { identity: 'original', tokenBindings, layouts });
    await page.locator('[data-screen="first"]').click();
    await page.evaluate(() => ccWorkspace.persist());
    const expected = await activeState(page);
    noNativeActions(before);
    await context.close(); context = null;
    context = await chromium.launchPersistentContext(directories[1], { headless: true, executablePath: process.env.CHROME_PATH, viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    const after = await workspace(page, 'dark', { tokenBindings, layouts });
    expect(await activeState(page)).toEqual(expected);
    await expect(page.locator('#ws-screen-tabs [role=tab]')).toHaveCount(3);
    noNativeActions(after);
  } finally {
    if (context) await context.close();
    directories.forEach(directory => fs.rmSync(directory, { recursive: true, force: true }));
  }
});

test('Token association wins over obsolete URL, cookie and local identity without changing either saved layout', async ({ page }) => {
  const layouts = { '/api/layouts/desktop_original': screens(), '/api/layouts/desktop_stale': { ...screens(), activeScreen: 'empty', panes: [], active: null } };
  const snapshot = JSON.stringify(layouts);
  const tokenBindings = { 'test-token:desktop': { enabled: true, device: 'desktop_original', revision: 4 } };
  const fixture = await workspace(page, 'dark', { identity: 'stale', url: 'http://workspace.test/?layoutDevice=stale', layouts, tokenBindings });
  expect(await page.evaluate(() => active.tab.id)).toBe('demo03');
  expect(new URL(page.url()).searchParams.get('layoutDevice')).toBe('original');
  expect(JSON.stringify(layouts)).toBe(snapshot);
  expect(fixture.requests.filter(r => r.method === 'PUT')).toEqual([]);
  noNativeActions(fixture);
});

test('explicit profile switch updates the Token pointer while old tabs cannot reclaim it', async ({ page, browser }) => {
  const tokenBindings = {}, layouts = { '/api/layouts/desktop_original': screens() };
  const first = await workspace(page, 'dark', { identity: 'original', layouts, tokenBindings });
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    const second = await workspace(other, 'dark', { layouts, tokenBindings });
    await page.locator('#ws-layout-user').click();
    await page.locator('#ws-user-input').fill('team');
    await page.locator('#ws-user-bind').click();
    await expect(page.locator('#ws-user-modal')).toBeHidden();
    expect(tokenBindings['test-token:desktop'].device).toBe('desktop_user_team');
    await other.locator('[data-screen="first"]').click();
    await other.evaluate(() => ccWorkspace.persist());
    expect(tokenBindings['test-token:desktop'].device).toBe('desktop_user_team');
    await other.reload();
    await expect(other.locator('#ws-layout-user')).toHaveText('team');
    await expect(other.locator('[data-screen="second"]')).toHaveAttribute('aria-selected', 'true');
    noNativeActions(second);
  } finally { await context.close(); }
  noNativeActions(first);
});

test('desktop and mobile Token bindings remain independent across fresh browsers and breakpoint changes', async ({ page, browser }) => {
  const mobile = screens(); mobile.screens = [mobile.screens[1]];
  const tokenBindings = {
    'test-token:desktop': { enabled: true, device: 'desktop_original', revision: 1 },
    'test-token:mobile': { enabled: true, device: 'mobile_phone', revision: 1 },
  };
  const desktop = screens(); desktop.activeScreen = 'first';
  const layouts = { '/api/layouts/desktop_original': desktop, '/api/layouts/mobile_phone': mobile };
  const fixture = await workspace(page, 'dark', { tokenBindings, layouts });
  expect((await activeState(page)).panes).toHaveLength(3);
  const original = JSON.stringify(layouts['/api/layouts/desktop_original']);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#ws-screen-tabs [role=tab]')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => active?.tab?.id)).toBe('demo03');
  expect(JSON.stringify(layouts['/api/layouts/desktop_original'])).toBe(original);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('#ws-screen-tabs [role=tab]')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => panes.length)).toBe(3);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const other = await context.newPage();
    const second = await workspace(other, 'light', { layouts, tokenBindings });
    await expect(other.locator('#ws-screen-tabs [role=tab]')).toHaveCount(1);
    expect((await activeState(other)).panes).toEqual(['demo03']);
    expect(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await other.screenshot({ path: '/tmp/webcc-v117-token-mobile.png' });
    noNativeActions(second);
  } finally { await context.close(); }
  noNativeActions(fixture);
});

test('stopped and deleted terminals restore as placeholders without starting or replacing conversations', async ({ page }) => {
  const saved = screens();
  saved.screens[1].panes = ['stopped', 'deleted']; saved.screens[1].active = 'stopped';
  const layouts = { '/api/layouts/desktop_original': saved };
  const tokenBindings = { 'test-token:desktop': { enabled: true, device: 'desktop_original', revision: 1 } };
  const fixture = await workspace(page, 'dark', { layouts, tokenBindings, allowEmpty: true, extraTabs: [{ id: 'stopped', name: 'Stopped', type: 'codex', cwd: '/workspace/demo', alive: false }] });
  expect((await activeState(page)).panes).toEqual(['stopped', 'deleted']);
  await expect(page.locator('.ws-offline-pane')).toHaveCount(2);
  expect(fixture.requests.filter(r => r.method === 'PUT')).toEqual([]);
  noNativeActions(fixture);
});

test('temporary binding outage retains a read-only recovery snapshot then reconnects without clobbering the server', async ({ page }) => {
  const tokenBindings = { 'test-token:desktop': { enabled: true, device: 'desktop_original', revision: 1 } };
  const options = { identity: 'original', tokenBindings, bindingReadFailure: true, layouts: { '/api/layouts/desktop_original': screens() },
    journal: { device: 'desktop_original', value: { layout: screens(), baseRevision: 3, pending: false } } };
  const fixture = await workspace(page, 'dark', options);
  await expect(page.locator('#ws-save-indicator')).toContainText('网络恢复后自动同步');
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
  expect(fixture.requests.filter(r => r.method === 'PUT')).toEqual([]);
  options.bindingReadFailure = false;
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await expect(page.locator('#ws-save-indicator')).toContainText('已保存');
  noNativeActions(fixture);
});

for (const committed of [false, true]) test(`a final pagehide checkpoint wins while an older save is pending (committed=${committed})`, async ({ page, browser }) => {
  const tokenBindings = {}, layouts = { '/api/layouts/desktop_original': screens() };
  const fixture = await workspace(page, 'dark', { identity: 'original', tokenBindings, layouts });
  let release, held = false;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/layouts/desktop_original', async route => {
    if (route.request().method() === 'PUT' && !held) {
      held = true;
      if (committed) {
        const { writer, sequence, ...value } = route.request().postDataJSON();
        const reply = { ...value, revision: value.revision + 1, write: { writer, sequence, baseRevision: value.revision } };
        layouts['/api/layouts/desktop_original'] = reply;
        await gate;
        return route.fulfill({ json: reply });
      }
      await gate;
    }
    await route.fallback();
  });
  try {
    await page.evaluate(() => { gridFr.rows = [1, 2, 1, 1]; ccWorkspace.layoutChanged(); void ccWorkspace.persist(); });
    await expect.poll(() => held).toBe(true);
    await page.evaluate(() => { gridFr.rows = [1, 4, 1, 1]; ccWorkspace.layoutChanged(); dispatchEvent(new PageTransitionEvent('pagehide')); });
    await expect.poll(() => layouts['/api/layouts/desktop_original'].screens[1].ratios.rows?.[1]).toBe(4);
    release();
    await page.evaluate(() => ccWorkspace.persist());
    await expect(page.locator('#ws-save-indicator')).toContainText('已保存');
    const context = await browser.newContext();
    try {
      const other = await context.newPage();
      const second = await workspace(other, 'dark', { layouts, tokenBindings });
      expect((await activeState(other)).ratios.rows[1]).toBe(4);
      noNativeActions(second);
    } finally { await context.close(); }
    noNativeActions(fixture);
  } finally { release(); }
});

test('resizing while Token binding is loading cannot install an unbound mobile layout', async ({ page }) => {
  const mobile = screens(); mobile.screens = [mobile.screens[1]];
  const tokenBindings = {
    'test-token:desktop': { enabled: true, device: 'desktop_original', revision: 1 },
    'test-token:mobile': { enabled: true, device: 'mobile_phone', revision: 1 },
  };
  const fixture = await workspace(page, 'dark', { layouts: { '/api/layouts/desktop_original': screens(), '/api/layouts/mobile_phone': mobile }, tokenBindings });
  let release, held = false;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/layout-binding/desktop', async route => { held = true; await gate; await route.fallback(); });
  try {
    await page.reload();
    await expect.poll(() => held).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    release();
    await expect(page.locator('#ws-screen-tabs [role=tab]')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => active?.tab?.id)).toBe('demo03');
    expect(new URL(page.url()).searchParams.get('layoutDevice')).toBe('phone');
    expect(fixture.requests.filter(r => r.method === 'PUT')).toEqual([]);
    noNativeActions(fixture);
  } finally { release(); }
});

test('reauthentication restores the correct Token layout without reloading the page or saving the old visible one', async ({ page }) => {
  const other = screens(); other.activeScreen = 'first';
  const tokenBindings = {
    'test-token:desktop': { enabled: true, device: 'desktop_original', revision: 1 },
    'new-token:desktop': { enabled: true, device: 'desktop_other', revision: 1 },
  };
  const options = { layouts: { '/api/layouts/desktop_original': screens(), '/api/layouts/desktop_other': other }, tokenBindings };
  const fixture = await workspace(page, 'dark', options);
  await page.evaluate(() => { window.authPageMarker = 'keep-page'; setTokenPrompt(); gridFr.rows = [1, 4, 1, 1]; ccWorkspace.layoutChanged(); dispatchEvent(new PageTransitionEvent('pagehide')); });
  options.tokenKey = 'new-token';
  await page.locator('#login-input').fill('test-only-new-token');
  await page.locator('#login-go').click();
  await expect(page.locator('#login')).toBeHidden();
  await expect.poll(() => page.evaluate(() => panes.length)).toBe(3);
  expect(new URL(page.url()).searchParams.get('layoutDevice')).toBe('other');
  expect(await page.evaluate(() => window.authPageMarker)).toBe('keep-page');
  expect(fixture.requests.filter(r => r.method === 'PUT')).toEqual([]);
  noNativeActions(fixture);
});

test('an unacknowledged own write can be reconciled from the journal without treating it as a foreign conflict', async ({ page }) => {
  const saved = screens(4), pending = screens(3);
  saved.write = { writer: 'old-page', sequence: 1, baseRevision: 3 };
  pending.screens[1].name = 'Latest title';
  const layouts = { '/api/layouts/desktop_original': saved };
  const fixture = await workspace(page, 'dark', { identity: 'original', layouts,
    journal: { device: 'desktop_original', value: { layout: pending, pending: true, baseRevision: 3, writer: 'old-page', sequence: 2 } } });
  await expect.poll(() => layouts['/api/layouts/desktop_original'].revision).toBe(5);
  await expect(page.locator('[data-screen="second"]')).toContainText('Latest title');
  await expect(page.locator('#ws-save-indicator')).toContainText('已保存');
  noNativeActions(fixture);
});

test('opening and closing while offline preserves the original pending writer proof for the next restart', async ({ page, browser }) => {
  const saved = screens(4), pending = screens(3);
  saved.write = { writer: 'old-page', sequence: 1, baseRevision: 3 };
  pending.screens[1].name = 'Latest title';
  const layouts = { '/api/layouts/desktop_original': saved };
  const fixture = await workspace(page, 'dark', { identity: 'original', layouts, layoutReadFailure: 503,
    journal: { device: 'desktop_original', value: { layout: pending, pending: true, baseRevision: 3, writer: 'old-page', sequence: 2 } } });
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
  const journal = await page.evaluate(() => JSON.parse(localStorage.cc_screens_recovery_desktop_original));
  expect(journal.writer).toBe('old-page');
  expect(journal.sequence).toBe(2);
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    const second = await workspace(other, 'dark', { identity: 'original', layouts, journal: { device: 'desktop_original', value: journal } });
    await expect(other.locator('#ws-save-indicator')).toContainText('已保存');
    await expect(other.locator('[data-screen="second"]')).toContainText('Latest title');
    noNativeActions(second);
  } finally { await context.close(); }
  noNativeActions(fixture);
});

test('a foreign write remains a conflict and closing a stale page cannot overwrite it', async ({ page }) => {
  const layouts = { '/api/layouts/desktop_original': screens() };
  const fixture = await workspace(page, 'dark', { identity: 'original', layouts, tokenBindings: {} });
  layouts['/api/layouts/desktop_original'] = { ...screens(4), write: { writer: 'another-page', sequence: 1, baseRevision: 3 } };
  const expected = JSON.stringify(layouts);
  await page.evaluate(() => { gridFr.rows = [1, 4, 1, 1]; ccWorkspace.layoutChanged(); return ccWorkspace.persist(); });
  await expect(page.locator('#ws-save-indicator')).toContainText('冲突');
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
  expect(JSON.stringify(layouts)).toBe(expected);
  noNativeActions(fixture);
});

test('explicit recovery link selects a profile once and later plain visits use the Token association', async ({ page, browser }) => {
  const tokenBindings = { 'test-token:desktop': { enabled: true, device: 'desktop_original', revision: 1 } };
  const layouts = { '/api/layouts/desktop_original': screens(), '/api/layouts/desktop_alternate': screens() };
  const fixture = await workspace(page, 'dark', { url: 'http://workspace.test/?layoutDevice=alternate&restoreLayout=1', layouts, tokenBindings });
  expect(tokenBindings['test-token:desktop'].device).toBe('desktop_alternate');
  expect(new URL(page.url()).searchParams.has('restoreLayout')).toBe(false);
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    const second = await workspace(other, 'dark', { layouts, tokenBindings });
    expect(new URL(other.url()).searchParams.get('layoutDevice')).toBe('alternate');
    noNativeActions(second);
  } finally { await context.close(); }
  noNativeActions(fixture);
});

for (const outcome of ['failure-first', 'checkpoint-first', 'foreign-conflict']) test(`checkpoint acknowledgement handles ${outcome} without losing the latest journal`, async ({ page }) => {
  const layouts = { '/api/layouts/desktop_original': screens() };
  const fixture = await workspace(page, 'dark', { identity: 'original', layouts, tokenBindings: {} });
  let releaseOld, releaseFinal, count = 0;
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  const finalGate = new Promise(resolve => { releaseFinal = resolve; });
  await page.route('**/api/layouts/desktop_original', async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    count++;
    if (count === 1) {
      await oldGate;
      return outcome === 'foreign-conflict' ? route.fulfill({ status: 409, json: { detail: 'Layout changed' } }) : route.abort('failed');
    }
    if (count === 2) {
      const { writer, sequence, ...value } = route.request().postDataJSON();
      const reply = { ...value, revision: value.revision + 1, write: { writer, sequence, baseRevision: value.revision } };
      layouts['/api/layouts/desktop_original'] = reply;
      await finalGate;
      return route.fulfill({ json: reply });
    }
    return route.fallback();
  });
  try {
    await page.evaluate(() => { ccWorkspace.layoutChanged(); void ccWorkspace.persist(); });
    await expect.poll(() => count).toBe(1);
    await page.evaluate(() => { gridFr.rows = [1, 4, 1, 1]; ccWorkspace.layoutChanged(); dispatchEvent(new PageTransitionEvent('pagehide')); });
    await expect.poll(() => count).toBe(2);
    if (outcome === 'foreign-conflict') {
      layouts['/api/layouts/desktop_original'] = { ...screens(5), write: { writer: 'other-page', sequence: 1, baseRevision: 4 } };
    }
    if (outcome === 'checkpoint-first') {
      releaseFinal();
      await expect(page.locator('#ws-save-indicator')).toContainText('已保存');
      releaseOld();
    } else {
      releaseOld();
      await expect(page.locator('#ws-save-indicator')).toContainText(outcome === 'foreign-conflict' ? '冲突' : '未保存');
      releaseFinal();
    }
    await page.evaluate(() => ccWorkspace.persist());
    if (outcome === 'foreign-conflict') {
      await expect(page.locator('#ws-save-indicator')).toContainText('冲突');
      expect(await page.evaluate(() => JSON.parse(localStorage.cc_screens_recovery_desktop_original).pending)).toBe(true);
      expect(layouts['/api/layouts/desktop_original'].write.writer).toBe('other-page');
    } else {
      await expect(page.locator('#ws-save-indicator')).toContainText('已保存');
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.cc_screens_recovery_desktop_original).pending)).toBe(false);
      expect(layouts['/api/layouts/desktop_original'].screens[1].ratios.rows[1]).toBe(4);
    }
    noNativeActions(fixture);
  } finally { releaseOld(); releaseFinal(); }
});
