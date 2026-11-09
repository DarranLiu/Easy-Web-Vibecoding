const { test, expect } = require('@playwright/test');
const { workspace } = require('./workspace.fixture.cjs');

const desktop = '/api/layouts/desktop_order';
function layout() {
  const screens = [
    { id: 'first', name: 'Build', panes: ['demo01', 'demo02'], active: 'demo01', direction: 'row', ratios: { cols: [2, 1], rows: [1, 1, 1, 1] }, maximized: 0 },
    { id: 'second', name: 'Review', panes: ['demo03'], active: 'demo03', direction: 'auto', ratios: {}, maximized: null },
    { id: 'third', name: 'Tools', panes: ['demo04'], active: 'demo04', direction: 'auto', ratios: {}, maximized: null },
  ];
  return { ...screens[0], screens, activeScreen: 'first', revision: 3, screenSchema: 1 };
}
const options = extra => ({ identity: 'order', layouts: { [desktop]: layout() }, ...extra });
const order = page => page.locator('#ws-screen-tabs > button').evaluateAll(nodes => nodes.map(node => node.dataset.screen));
const writes = fixture => fixture.requests.filter(r => r.method === 'PUT' && r.path.includes('/api/layouts/'));
function noNative(fixture) {
  expect(fixture.errors).toEqual([]);
  expect(fixture.requests.filter(r => r.method !== 'GET' && /\/api\/(sessions|session-lookup|agents)\b/.test(r.path))).toEqual([]);
}
async function remember(page) {
  await page.evaluate(() => {
    window.beforeOrder = { panes: [...panes], terms: panes.map(p => p.term), sockets: panes.map(p => p.ws), active, maximizedPane, ratios: JSON.stringify(gridFr), count: socketCount };
  });
}
async function unchanged(page) {
  expect(await page.evaluate(() => panes.every((p, i) => p === beforeOrder.panes[i] && p.term === beforeOrder.terms[i] && p.ws === beforeOrder.sockets[i]) &&
    panes.length === beforeOrder.panes.length && active === beforeOrder.active && maximizedPane === beforeOrder.maximizedPane && JSON.stringify(gridFr) === beforeOrder.ratios && socketCount === beforeOrder.count)).toBe(true);
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input'))).toEqual([]);
}
async function drag(page, from, to, after = false) {
  const target = page.locator('#ws-screen-tabs [data-screen="' + to + '"]'), rect = await target.boundingBox();
  await page.locator('#ws-screen-tabs [data-screen="' + from + '"]').dragTo(target, { targetPosition: { x: after ? rect.width - 3 : 3, y: rect.height / 2 } });
}
async function syntheticDrag(page, from, to, after = false) {
  await page.evaluate(({ from, to, after }) => {
    const source = document.querySelector('#ws-screen-tabs [data-screen="' + from + '"]'), target = document.querySelector('#ws-screen-tabs [data-screen="' + to + '"]');
    const dataTransfer = new DataTransfer(), rect = target.getBoundingClientRect();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: after ? rect.right - 3 : rect.left + 3 }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
  }, { from, to, after });
}

test('drag an inactive tab before the first and keep all terminals geometry and screen identity', async ({ page }) => {
  const fixture = await workspace(page, 'dark', options());
  const content = structuredClone(fixture.layouts[desktop].screens);
  await remember(page);
  await drag(page, 'third', 'first');
  await expect.poll(() => order(page)).toEqual(['third', 'first', 'second']);
  await expect.poll(() => fixture.layouts[desktop].screens.map(s => s.id)).toEqual(['third', 'first', 'second']);
  expect(fixture.layouts[desktop].activeScreen).toBe('first');
  expect(fixture.layouts[desktop].screens).toEqual([content[2], content[0], content[1]]);
  await unchanged(page); noNative(fixture);
  await page.reload(); await page.waitForFunction(() => ccWorkspace.canResume);
  expect(await order(page)).toEqual(['third', 'first', 'second']);
  await expect(page.locator('[data-screen="first"]')).toHaveAttribute('aria-selected', 'true');
});

test('active tab can move after the last while preserving terminal output and focus in an editor', async ({ page }) => {
  const fixture = await workspace(page, 'light', options());
  await remember(page);
  await page.evaluate(() => { const input = document.createElement('input'); input.id = 'typing'; document.body.append(input); input.focus(); });
  await syntheticDrag(page, 'first', 'third', true);
  await expect.poll(() => order(page)).toEqual(['second', 'third', 'first']);
  expect(await page.evaluate(() => document.activeElement.id)).toBe('typing');
  await unchanged(page); noNative(fixture);
  expect(await page.evaluate(() => document.getElementById('ws-screen-tabs').nextElementSibling.id)).toBe('ws-screen-add');
});

test('keyboard reordering preserves focused tab and ordinary arrows still change screens', async ({ page }) => {
  const fixture = await workspace(page, 'dark', options());
  await remember(page);
  await page.locator('[data-screen="first"]').focus();
  await page.keyboard.press('Control+Shift+ArrowRight');
  await expect.poll(() => order(page)).toEqual(['second', 'first', 'third']);
  await expect(page.locator('[data-screen="first"]')).toBeFocused();
  await unchanged(page);
  await page.keyboard.press('Control+Shift+ArrowLeft');
  await expect.poll(() => order(page)).toEqual(['first', 'second', 'third']);
  await expect(page.locator('[data-screen="first"]')).toBeEnabled();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-screen="second"]')).toHaveAttribute('aria-selected', 'true');
  noNative(fixture);
});

test('delayed socket open cannot steal focus while keyboard reordering awaits a save', async ({ page }) => {
  const fixture = await workspace(page, 'dark', options());
  await page.evaluate(() => ccWorkspace.persist());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/layouts/*', async route => {
    if (route.request().method() === 'PUT') await gate;
    await route.fallback();
  });
  const tab = page.locator('#ws-screen-tabs [data-screen="first"]');
  await tab.focus();
  await page.keyboard.press('Control+Shift+ArrowRight');
  await expect(tab).toBeDisabled();
  await page.evaluate(() => active.ws.onopen?.());
  expect(await page.evaluate(() => document.activeElement === active.term.textarea)).toBe(false);
  release();
  await expect.poll(() => order(page)).toEqual(['second', 'first', 'third']);
  await expect(tab).toBeEnabled();
  await expect(tab).toBeFocused();
  noNative(fixture);
});

test('self drop does not save or modify any screen', async ({ page }) => {
  const fixture = await workspace(page, 'dark', options());
  await remember(page);
  await syntheticDrag(page, 'first', 'first');
  await syntheticDrag(page, 'second', 'second');
  expect(await order(page)).toEqual(['first', 'second', 'third']);
  expect(writes(fixture)).toHaveLength(0);
  await unchanged(page); noNative(fixture);
});

test('dropping at the center of an adjacent tab exchanges their positions in either direction', async ({ page }) => {
  const fixture = await workspace(page, 'dark', options());
  await remember(page);
  await page.locator('[data-screen="second"]').dragTo(page.locator('[data-screen="first"]'));
  await expect.poll(() => order(page)).toEqual(['second', 'first', 'third']);
  await expect(page.locator('[data-screen="second"]')).toBeEnabled();
  await page.locator('[data-screen="second"]').dragTo(page.locator('[data-screen="first"]'));
  await expect.poll(() => order(page)).toEqual(['first', 'second', 'third']);
  await unchanged(page); noNative(fixture);
});

for (const cancel of ['escape', 'blur', 'external']) test(`cancelled or external drag is inert: ${cancel}`, async ({ page }) => {
  const fixture = await workspace(page, 'dark', options());
  await remember(page);
  await page.evaluate(cancel => {
    const source = document.querySelector('[data-screen="third"]'), target = document.querySelector('[data-screen="first"]'), dataTransfer = new DataTransfer();
    if (cancel !== 'external') source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    else dataTransfer.setData('application/x-cc-screen', 'third');
    if (cancel === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    if (cancel === 'blur') window.dispatchEvent(new Event('blur'));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: target.getBoundingClientRect().left + 1 }));
  }, cancel);
  expect(await order(page)).toEqual(['first', 'second', 'third']);
  expect(writes(fixture)).toHaveLength(0);
  await expect(page.locator('.ws-tab-dragging,.ws-order-before,.ws-order-after')).toHaveCount(0);
  await unchanged(page); noNative(fixture);
});

test('order dialog moves any screen, keeps its row focused, and persists after a fresh Token login', async ({ page, browser }) => {
  const layouts = { [desktop]: layout() }, tokenBindings = {};
  const fixture = await workspace(page, 'dark', options({ layouts, tokenBindings }));
  await remember(page);
  await page.locator('#ws-screen-order').click();
  const row = page.locator('[data-screen-order="third"]');
  await row.getByRole('button', { name: '前移', exact: true }).click();
  await expect.poll(() => order(page)).toEqual(['first', 'third', 'second']);
  await expect(row.getByRole('button', { name: '前移', exact: true })).toBeEnabled();
  await expect(row.getByRole('button', { name: '前移', exact: true })).toBeFocused();
  await row.getByRole('button', { name: '前移', exact: true }).click();
  await expect.poll(() => layouts[desktop].screens.map(s => s.id)).toEqual(['third', 'first', 'second']);
  await expect(row.getByRole('button', { name: '前移', exact: true })).toBeDisabled();
  await expect(row.getByRole('button', { name: '后移', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#ws-order-modal')).toBeHidden();
  await unchanged(page); noNative(fixture);
  const context = await browser.newContext();
  try {
    const fresh = await context.newPage();
    const second = await workspace(fresh, 'dark', { layouts, tokenBindings });
    expect(await order(fresh)).toEqual(['third', 'first', 'second']);
    noNative(second);
  } finally { await context.close(); }
});

test('right-click sorts an inactive screen without selecting it or touching the terminal', async ({ page }) => {
  const fixture = await workspace(page, 'dark', options());
  await remember(page);
  await page.locator('[data-screen="third"]').click({ button: 'right' });
  await expect(page.locator('#ws-order-modal')).toBeVisible();
  await expect(page.locator('[data-screen-order="third"] [data-step="-1"]')).toBeFocused();
  await unchanged(page); noNative(fixture);
});

test('conflicting saves keep local order and a recovery journal without overwriting server', async ({ page }) => {
  const fixture = await workspace(page, 'dark', options());
  await remember(page);
  await page.route('**/api/layouts/desktop_order', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 409, json: { detail: 'Other browser changed the layout' } }) : route.fallback());
  await page.locator('#ws-screen-order').click();
  await page.locator('[data-screen-order="third"] [data-step="-1"]').click();
  await expect(page.locator('#ws-order-state')).toContainText('尚未同步');
  expect(await order(page)).toEqual(['first', 'third', 'second']);
  expect(fixture.layouts[desktop].screens.map(s => s.id)).toEqual(['first', 'second', 'third']);
  const journal = await page.evaluate(() => JSON.parse(localStorage.getItem('cc_screens_recovery_desktop_order')));
  expect(journal.pending).toBe(true);
  expect(journal.layout.screens.map(s => s.id)).toEqual(['first', 'third', 'second']);
  await expect(page.locator('#ws-order-list button:enabled')).toHaveCount(0);
  await unchanged(page); noNative(fixture);
});

for (const status of [409, 503]) {
  test(`existing screens remain navigable after a ${status} save failure`, async ({ page }) => {
    const fixture = await workspace(page, 'dark', options());
    let attempts = 0;
    await page.route('**/api/layouts/desktop_order', route => {
      if (route.request().method() !== 'PUT') return route.fallback();
      attempts++;
      return route.fulfill({ status, json: { detail: 'Layout save unavailable' } });
    });
    await page.locator('[data-screen="second"]').click();
    await expect(page.locator('#ws-save-indicator')).toHaveClass(/error/);
    const count = attempts;
    await page.locator('[data-screen="third"]').click();
    await expect(page.locator('[data-screen="third"]')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => page.evaluate(() => active?.tab?.id)).toBe('demo04');
    await page.locator('[data-screen="third"]').focus();
    await page.keyboard.press('Home');
    await expect(page.locator('[data-screen="first"]')).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(500);
    expect(attempts).toBe(count);
    expect(fixture.layouts[desktop].activeScreen).toBe('first');
    const journal = await page.evaluate(() => JSON.parse(localStorage.getItem('cc_screens_recovery_desktop_order')));
    expect(journal.pending).toBe(true);
    expect(journal.baseRevision).toBe(3);
    await page.getByRole('button', { name: '新建屏幕', exact: true }).click();
    await expect(page.locator('#ws-screen-tabs > button')).toHaveCount(3);
    noNative(fixture);
    expect(await page.evaluate(() => sent.filter(m => m.type === 'input'))).toEqual([]);
  });
}

test('slow save is deduplicated and closing the dialog never reopens or refocuses it', async ({ page }) => {
  const fixture = await workspace(page, 'dark', options());
  await remember(page);
  let release, writes = 0;
  await page.route('**/api/layouts/desktop_order', async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    writes++;
    await new Promise(resolve => { release = resolve; });
    return route.fallback();
  });
  await page.locator('#ws-screen-order').click();
  await page.locator('[data-screen-order="third"] [data-step="-1"]').click();
  await expect.poll(() => writes).toBe(1);
  await expect(page.locator('#ws-order-list button:enabled')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭屏幕排序' }).click();
  await expect(page.locator('#ws-order-modal')).toBeHidden();
  release();
  await expect(page.locator('#ws-screen-order')).toBeEnabled();
  expect(writes).toBe(1);
  await expect(page.locator('#ws-order-modal')).toBeHidden();
  await unchanged(page); noNative(fixture);
});

test('device change closes a stale ordering dialog and desktop order cannot edit mobile layout', async ({ page }) => {
  const fixture = await workspace(page, 'dark', options());
  await page.locator('#ws-screen-order').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#ws-order-modal')).toBeHidden();
  await page.waitForFunction(() => ccWorkspace.canResume);
  expect(fixture.layouts[desktop].screens.map(s => s.id)).toEqual(['first', 'second', 'third']);
  noNative(fixture);
});

for (const theme of ['dark', 'light']) for (const width of [320, 390, 1440]) test(`screen order fits ${theme} ${width}, mobile remains touch-scrollable`, async ({ page }) => {
  await page.setViewportSize({ width, height: 700 });
  const value = layout();
  value.screens.push(...Array.from({ length: 13 }, (_, i) => ({ id: 'extra' + i, name: 'Long project name for screen ' + (i + 4), panes: [], active: null, direction: 'auto', ratios: {}, maximized: null })));
  const key = width < 821 ? '/api/layouts/mobile_order' : desktop;
  const fixture = await workspace(page, theme, options({ layouts: { [key]: value } }));
  await remember(page);
  await page.locator('#ws-screen-order').click();
  await expect(page.locator('#ws-order-list > li')).toHaveCount(16);
  await page.locator('[data-screen-order="second"] [data-step="-1"]').click();
  await expect.poll(() => fixture.layouts[key].screens[0].id).toBe('second');
  const fits = await page.evaluate(() => {
    const box = document.querySelector('.ws-order-box').getBoundingClientRect(), list = document.getElementById('ws-order-list');
    return document.documentElement.scrollWidth <= innerWidth && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && list.scrollHeight > list.clientHeight;
  });
  expect(fits).toBe(true);
  if (width < 821) {
    expect(await page.locator('#ws-screen-tabs > button').evaluateAll(nodes => nodes.every(node => !node.draggable))).toBe(true);
    const bounds = await page.locator('[data-screen-order="second"] [data-step="1"]').boundingBox();
    expect(bounds.width).toBeGreaterThanOrEqual(44); expect(bounds.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: `/tmp/webcc-v119-order-${theme}-${width}.png` });
  await unchanged(page); noNative(fixture);
});
