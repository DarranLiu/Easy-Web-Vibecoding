const { test, expect } = require('@playwright/test');
const { workspace } = require('./workspace.fixture.cjs');
const ids = { demo01: 'cc_demo01', demo02: '87654321-1234-4234-8234-123456789abc',
  demo03: '12345678-1234-4234-8234-123456789abc', demo04: 'ses_123456789abcdef' };

async function setup(page, options = {}) {
  const fixture = await workspace(page, options.theme || 'dark', { initial: { panes: ['demo02'], active: 'demo02' }, ...options });
  await page.evaluate(() => {
    window.copiedIds = [];
    document.execCommand = command => {
      if (command === 'copy') copiedIds.push(document.activeElement.value);
      return true;
    };
  });
  return fixture;
}
async function safe(page, fixture) {
  expect(await page.evaluate(() => sent.filter(item => item.type === 'input'))).toEqual([]);
  expect(fixture.requests.filter(r => r.path.startsWith('/api/sessions') && r.method !== 'GET')).toEqual([]);
  expect(fixture.errors).toEqual([]);
}

for (const width of [390, 1440]) for (const sid of Object.keys(ids)) {
  test(`${sid} copies its exact native or explicit window ID at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await setup(page, { initial: { panes: [sid], active: sid } });
    await expect(page.locator('#btn-copy-path')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '复制会话 ID', exact: true })).toBeEnabled();
    await page.locator('#btn-copy-session-id').click();
    await expect.poll(() => page.evaluate(() => copiedIds)).toEqual([ids[sid]]);
    expect(fixture.requests.filter(r => r.path.endsWith('/identity'))).toEqual([
      expect.objectContaining({ path: `/api/sessions/${sid}/identity`, method: 'GET' }),
    ]);
    await safe(page, fixture);
  });
}

test('copy is on-demand and double click sends only one identity lookup', async ({ page }) => {
  const fixture = await setup(page, { identityDelay: 600 });
  expect(fixture.requests.filter(r => r.path.endsWith('/identity'))).toEqual([]);
  await page.locator('#btn-copy-session-id').evaluate(el => { el.click(); el.click(); });
  await expect(page.locator('#btn-copy-session-id')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => copiedIds)).toEqual([ids.demo02]);
  expect(fixture.requests.filter(r => r.path.endsWith('/identity'))).toHaveLength(1);
  await safe(page, fixture);
});

test('failed identity lookup does not copy the path or web ID and does not retry', async ({ page }) => {
  const fixture = await setup(page, { identityFailure: 409 });
  await page.locator('#btn-copy-session-id').click();
  await expect(page.locator('#toast')).toContainText('尚未识别');
  expect(await page.evaluate(() => copiedIds)).toEqual([]);
  expect(fixture.requests.filter(r => r.path.endsWith('/identity'))).toHaveLength(1);
  await expect(page.locator('#btn-copy-session-id')).toBeEnabled();
  await safe(page, fixture);
});

for (const value of [{ value: '/workspace/private' }, { id: 'other' }, { value: '' }]) {
  test(`invalid identity response never reaches clipboard ${JSON.stringify(value)}`, async ({ page }) => {
    const fixture = await setup(page, { identityResult: value });
    await page.locator('#btn-copy-session-id').click();
    await expect(page.locator('#toast')).toContainText('会话 ID 无效');
    expect(await page.evaluate(() => copiedIds)).toEqual([]);
    await safe(page, fixture);
  });
}

test('switching panes during lookup keeps the clicked target and does not steal focus', async ({ page }) => {
  const fixture = await setup(page, { identityDelay: 600 });
  await page.locator('#btn-copy-session-id').click();
  await page.evaluate(() => attachTerminal(state.tabs.find(t => t.id === 'demo03')));
  await expect.poll(() => page.evaluate(() => copiedIds)).toEqual([ids.demo02]);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo03');
  await safe(page, fixture);
});

test('pending and stopped dialogs copy their exact IDs without launching', async ({ page }) => {
  const fixture = await setup(page, { identityResult: { state: 'pending' } });
  await page.locator('#btn-copy-session-id').click();
  await expect(page.locator('#toast')).toContainText('待恢复会话 ID');
  expect(await page.evaluate(() => copiedIds)).toEqual([ids.demo02]);
  await safe(page, fixture);
});

test('an offline placeholder copies its verified saved session without waking it', async ({ page }) => {
  const fixture = await setup(page, { allowEmpty: true, initial: { panes: ['saved'], active: 'saved' },
    extraTabs: [{ id: 'saved', type: 'claude', cwd: '/workspace/tools', alive: false }] });
  await page.locator('#btn-copy-session-id').click();
  await expect.poll(() => page.evaluate(() => copiedIds)).toEqual([ids.demo03]);
  await expect(page.locator('.ws-offline-pane')).toBeVisible();
  await safe(page, fixture);
});

test('WebKit style clipboard call is reserved before asynchronous metadata settles', async ({ page }) => {
  const fixture = await setup(page, { identityDelay: 600 });
  await page.evaluate(() => {
    window.clipboardStarted = false;
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    window.ClipboardItem = class { constructor(data) { this.data = data; } };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: async items => { clipboardStarted = true; const blob = await items[0].data['text/plain']; copiedIds.push(await blob.text()); },
    } });
  });
  await page.locator('#btn-copy-session-id').click();
  expect(await page.evaluate(() => clipboardStarted)).toBe(true);
  expect(await page.evaluate(() => copiedIds)).toEqual([]);
  await expect.poll(() => page.evaluate(() => copiedIds)).toEqual([ids.demo02]);
  await safe(page, fixture);
});

test('denied modern clipboard falls back only after a valid identity arrives', async ({ page }) => {
  const fixture = await setup(page);
  await page.evaluate(() => {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    window.ClipboardItem = class { constructor(data) { this.data = data; } };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: async () => { throw new Error('denied'); }, writeText: async () => { throw new Error('denied'); },
    } });
  });
  await page.locator('#btn-copy-session-id').click();
  await expect.poll(() => page.evaluate(() => copiedIds)).toEqual([ids.demo02]);
  await safe(page, fixture);
});

test('failed lookup with modern clipboard has no unhandled promise or clipboard write', async ({ page }) => {
  const fixture = await setup(page, { identityFailure: 503 });
  await page.evaluate(() => {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    window.ClipboardItem = class { constructor(data) { this.data = data; } };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: async items => { const blob = await items[0].data['text/plain']; copiedIds.push(await blob.text()); },
    } });
  });
  await page.locator('#btn-copy-session-id').click();
  await expect(page.locator('#toast')).toContainText('未复制');
  expect(await page.evaluate(() => copiedIds)).toEqual([]);
  await safe(page, fixture);
});

for (const theme of ['dark', 'light']) for (const width of [320, 1440]) {
  test(`copy ID toolbar remains compact and accessible ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await setup(page, { theme });
    const button = page.locator('#btn-copy-session-id');
    await button.scrollIntoViewIfNeeded(); await button.hover();
    await expect(button.locator('svg')).toHaveCount(1);
    const bounds = await button.boundingBox();
    // The reference desktop command has an icon + label; mobile remains icon-only.
    expect(bounds.width).toBeLessThanOrEqual(width > 820 ? 120 : 44);
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/webcc-v116-copy-id-${theme}-${width}.png` });
    await safe(page, fixture);
  });
}
