const { test, expect } = require('@playwright/test');
const { workspace } = require('./workspace.fixture.cjs');

function options() {
  return { profile: 'unread', completions: [], layouts: { '/api/layouts/desktop_user_unread': {
    revision: 2, screenSchema: 1, activeScreen: 'first', panes: ['demo01', 'demo02'], active: 'demo01', direction: 'row', ratios: {}, screens: [
      { id: 'first', name: 'Screen 1', panes: ['demo01', 'demo02'], active: 'demo01', direction: 'row', ratios: {} },
      { id: 'second', name: 'Screen 2', panes: ['demo03'], active: 'demo03', direction: 'auto', ratios: {} },
    ]
  } } };
}
const receipt = (sid, id = sid + '_reply') => ({ sid, id, time: Date.now() / 1000 });
async function refresh(page) {
  await page.waitForTimeout(100);
  await page.evaluate(() => ccUnread.refresh(true));
}

test('completion dots aggregate by screen and update titles and tree without layout writes or input', async ({ page }) => {
  const opts = options(), fixture = await workspace(page, 'dark', opts);
  const initial = fixture.requests.length;
  opts.completions = [receipt('demo02'), receipt('demo03')];
  await refresh(page);
  await expect(page.locator('#ws-screen-tabs [data-unread="1"]')).toHaveCount(2);
  await expect(page.locator('.pane-bar .ws-unread-dot')).toHaveCount(1);
  await expect(page.locator('.ws-session[data-session="demo02"] .ws-unread-dot')).toHaveCount(1);
  expect(fixture.requests.slice(initial).filter(r => r.method !== 'GET')).toEqual([]);
  expect(await page.evaluate(() => sent.filter(value => ['input', 'paste'].includes(value.type)))).toEqual([]);
  await page.screenshot({ path: '/tmp/webcc-v131-unread-desktop.png' });
  await page.locator('.pane-bar .ws-unread-dot').click();
  await expect(page.locator('#ws-screen-tabs [data-screen="first"] .ws-unread-dot')).toHaveCount(0);
  await expect(page.locator('#ws-screen-tabs [data-screen="second"] .ws-unread-dot')).toHaveCount(1);
  expect(fixture.errors).toEqual([]);
});

test('unread survives reload and does not mark a disconnected or hidden pane read', async ({ page }) => {
  const opts = options();
  await workspace(page, 'dark', opts);
  opts.completions = [receipt('demo02')];
  await refresh(page);
  await page.reload();
  await expect(page.locator('#ws-screen-tabs [data-screen="first"] .ws-unread-dot')).toHaveCount(1);
  await page.evaluate(() => {
    const p = panes.find(p => p.tab.id === 'demo02'); p.ws.readyState = 3;
  });
  await page.waitForTimeout(1400);
  await expect(page.locator('.pane-bar .ws-unread-dot')).toHaveCount(1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const p = panes.find(p => p.tab.id === 'demo02'); p.ws.readyState = 1; focusPane(p, false);
  });
  await page.waitForTimeout(1400);
  expect(opts.completions).toHaveLength(1);
});

test('entering the already-focused terminal clears a reply even in native history', async ({ page }) => {
  const opts = options(); await workspace(page, 'dark', opts);
  await page.evaluate(async () => {
    const p = panes.find(p => p.tab.id === 'demo02'); focusPane(p, false);
    await new Promise(resolve => p.term.write('\x1b[?1049hReady\r\n', resolve));
  });
  opts.completions = [receipt('demo02')]; await refresh(page);
  await page.waitForTimeout(1400);
  expect(opts.completions).toHaveLength(1);
  await page.evaluate(async () => {
    await new Promise(resolve => active.term.write('\x1b[?1049lReady', resolve));
    active.host.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    ccUnread.paint();
  });
  await page.waitForTimeout(1400);
  expect(opts.completions).toHaveLength(1);
  await page.locator('.pane').filter({ has: page.locator('.pane-name', { hasText: 'Codex' }) }).locator('.pane-name').click();
  await expect.poll(() => opts.completions.length).toBe(0);
  await expect(page.locator('.ws-unread-pane')).toHaveCount(0);
  await expect(page.locator('#ws-screen-tabs .ws-unread-dot')).toHaveCount(0);
});

test('focused rendered terminal auto acknowledges after dwell, newer replies appear again', async ({ page }) => {
  const opts = options(); await workspace(page, 'dark', opts);
  await page.bringToFront();
  opts.completions = [receipt('demo01')]; await refresh(page);
  await expect.poll(() => opts.completions.length).toBe(0);
  opts.completions = [receipt('demo03', 'second_reply')]; await refresh(page);
  await expect(page.locator('#ws-screen-tabs [data-screen="second"] .ws-unread-dot')).toHaveCount(1);
});

test('ack failure retains receipt and later success clears it', async ({ page }) => {
  const opts = options(); opts.completionAckFailure = true;
  await workspace(page, 'dark', opts);
  opts.completions = [receipt('demo02')]; await refresh(page);
  await page.locator('.pane-bar .ws-unread-dot').click();
  await expect(page.locator('#toast')).toContainText('已读状态未保存');
  await expect(page.locator('.pane-bar .ws-unread-dot')).toHaveCount(1);
  opts.completionAckFailure = false;
  await page.locator('.pane-bar .ws-unread-dot').click();
  await expect(page.locator('.pane-bar .ws-unread-dot')).toHaveCount(0);
});

test('mobile completion indicator fits without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const opts = { completions: [] }; await workspace(page, 'light', opts);
  opts.completions = [receipt('demo01')];
  await page.evaluate(() => { Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }); });
  await refresh(page);
  await expect(page.locator('.pane-bar .ws-unread-dot')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => {
    const strip = document.getElementById('ws-screen-strip').getBoundingClientRect();
    const icon = document.querySelector('#ws-screen-add .ui-icon').getBoundingClientRect();
    return icon.left >= strip.left && icon.right <= strip.right;
  })).toBe(true);
  await page.screenshot({ path: '/tmp/webcc-v131-unread-mobile.png' });
});

test('another browser acknowledgement clears the marker and activity mark-all clears remaining replies', async ({ page }) => {
  const opts = options(); await workspace(page, 'dark', opts);
  opts.completions = [receipt('demo02'), receipt('demo03')]; await refresh(page);
  opts.completions = [receipt('demo03')]; await refresh(page);
  await expect(page.locator('#ws-screen-tabs [data-screen="first"] .ws-unread-dot')).toHaveCount(0);
  await page.locator('#ws-panel-tab-activity').click();
  await page.locator('#ws-events-mark-all').click();
  await expect.poll(() => opts.completions.length).toBe(0);
  await expect(page.locator('#ws-screen-tabs .ws-unread-dot')).toHaveCount(0);
});

test('newer reply arriving during acknowledgement is not erased by its response', async ({ page }) => {
  const opts = options(); await workspace(page, 'dark', opts);
  opts.completions = [receipt('demo02')]; await refresh(page);
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  await page.route('**/api/completions/ack', async route => {
    await gate;
    await route.fulfill({ json: { ok: true } });
  });
  await page.locator('.pane-bar .ws-unread-dot').click();
  opts.completions = [receipt('demo02', 'newer')]; await refresh(page);
  finish();
  await expect(page.locator('.pane-bar .ws-unread-dot')).toHaveCount(1);
  await refresh(page);
  await expect(page.locator('.pane-bar .ws-unread-dot')).toHaveCount(1);
});

test('restoring the focused pane does not silently consume an existing unread reply', async ({ page }) => {
  const opts = options(); opts.completions = [receipt('demo01')];
  await workspace(page, 'dark', opts);
  await page.waitForTimeout(1500);
  expect(opts.completions).toHaveLength(1);
  await page.locator('.pane-bar .ws-unread-dot').click();
  await expect.poll(() => opts.completions.length).toBe(0);
});

test('switching screens acknowledges only the entered pane and green border never captures input', async ({ page }) => {
  const opts = options(), fixture = await workspace(page, 'dark', opts);
  opts.completions = [receipt('demo02'), receipt('demo03')]; await refresh(page);
  await expect(page.locator('.ws-unread-pane')).toHaveCount(1);
  const decoration = await page.locator('.ws-unread-pane').evaluate(el => {
    const css = getComputedStyle(el, '::after');
    return { animation: css.animationName, pointer: css.pointerEvents, inset: css.top };
  });
  expect(decoration).toEqual({ animation: 'none', pointer: 'none', inset: '0px' });
  expect(await page.locator('.ws-unread-pane').evaluate(el =>
    Math.abs(parseFloat(getComputedStyle(el, '::after').width) - el.getBoundingClientRect().width) < 3
  )).toBe(true);
  const opacities = [];
  for (let i = 0; i < 3; i++) {
    opacities.push(await page.locator('.ws-unread-pane').evaluate(el => getComputedStyle(el, '::after').opacity));
    await page.waitForTimeout(250);
  }
  expect(opacities).toEqual(['1', '1', '1']);
  await page.locator('#ws-screen-tabs [data-screen="second"]').click();
  await expect.poll(() => opts.completions.map(value => value.sid)).toEqual(['demo02']);
  await expect(page.locator('#ws-screen-tabs [data-screen="second"] .ws-unread-dot')).toHaveCount(0);
  await expect(page.locator('#ws-screen-tabs [data-screen="first"] .ws-unread-dot')).toHaveCount(1);
  expect(await page.evaluate(() => sent.filter(value => ['input', 'paste'].includes(value.type)))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('clicking a nonfocused alternate-screen pane clears its screen badge immediately', async ({ page }) => {
  const opts = options(); await workspace(page, 'dark', opts);
  await page.evaluate(async () => {
    const p = panes.find(p => p.tab.id === 'demo02');
    await new Promise(resolve => p.term.write('\x1b[?1049hReady\r\n', resolve));
  });
  opts.completions = [receipt('demo02')]; await refresh(page);
  await page.locator('.ws-unread-pane .pane-name').click();
  await expect.poll(() => opts.completions.length).toBe(0);
  await expect(page.locator('.ws-unread-pane')).toHaveCount(0);
  await expect(page.locator('#ws-screen-tabs .ws-unread-dot')).toHaveCount(0);
});

test('sidebar entry acknowledges an already focused fullscreen terminal', async ({ page }) => {
  const opts = options(); await workspace(page, 'dark', opts);
  await page.evaluate(async () => {
    const p = panes.find(p => p.tab.id === 'demo02'); focusPane(p, false);
    await new Promise(resolve => p.term.write('\x1b[?1049hReady', resolve));
  });
  opts.completions = [receipt('demo02')]; await refresh(page);
  await page.locator('.ws-session[data-session="demo02"] .ws-session-open').click();
  await expect.poll(() => opts.completions.length).toBe(0);
  await expect(page.locator('.ws-unread-pane')).toHaveCount(0);
});

test('reduced motion uses a static green border and failed entry restores the unread state', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const opts = options(); opts.completionAckFailure = true;
  await workspace(page, 'light', opts);
  opts.completions = [receipt('demo02')]; await refresh(page);
  expect(await page.locator('.ws-unread-pane').evaluate(el => getComputedStyle(el, '::after').animationName)).toBe('none');
  await page.locator('.ws-unread-pane .pane-name').click();
  await expect(page.locator('#toast')).toContainText('已读状态未保存');
  await expect(page.locator('.ws-unread-pane')).toHaveCount(1);
  await expect(page.locator('#ws-screen-tabs .ws-unread-dot')).toHaveCount(1);
});
