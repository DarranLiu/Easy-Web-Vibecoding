const { test, expect } = require('@playwright/test');
const { workspace } = require('./workspace.fixture.cjs');
const native = '12345678-1234-4234-8234-123456789abc';
const choice = (overrides = {}) => ({ key: 'window_demo02', expected: 'snapshot1', id: 'demo02', nativeId: native,
  agent: 'codex', name: 'Codex discussion', cwd: '/workspace/demo', action: 'attach', reason: '', ...overrides });
const ids = page => page.evaluate(() => panes.map(p => p.tab?.id || p.savedId));
async function setup(page, options = {}) {
  const fixture = await workspace(page, options.theme || 'dark', options);
  const data = { matches: [choice()], queries: [], opens: [], delay: 0, error: 0, ...options.lookup };
  await page.route('**/api/session-lookup?*', async route => {
    const query = new URL(route.request().url()).searchParams.get('id');
    data.queries.push(query);
    const matches = structuredClone(data.matches);
    if (data.delay) await new Promise(r => setTimeout(r, data.delay));
    await route.fulfill({ json: { query, matches } }).catch(() => {});
  });
  await page.route('**/api/session-lookup/open', async route => {
    const body = route.request().postDataJSON(); data.opens.push(body);
    if (data.openDelay) await new Promise(r => setTimeout(r, data.openDelay));
    if (data.error) return route.fulfill({ status: data.error, json: { detail: 'State changed safely' } });
    const selected = data.matches.find(item => item.key === body.key), id = selected.id || 'imported';
    let tab = fixture.tabs.find(t => t.id === id);
    if (tab) tab.alive = true;
    else { tab = { id, cwd: selected.cwd, name: selected.name, type: selected.agent, alive: true }; fixture.tabs.push(tab); }
    return route.fulfill({ json: { ...tab, ...(data.pending ? { resumePending: true, resumed: false,
      resumeMessage: '窗口已启动，原会话尚未确认加载。请在终端完成目录信任等启动确认；不会重复启动或自动确认。' } : {}) } });
  });
  return { ...fixture, data };
}
async function launch(page) {
  const trigger = page.locator(page.viewportSize().width <= 820 ? '#btn-split' : '#header-split');
  await trigger.scrollIntoViewIfNeeded(); await trigger.click();
  await page.locator('#ws-split-lookup').click();
  await expect(page.locator('#session-lookup-modal')).toBeVisible();
  await expect(page.locator('#session-lookup-input')).toBeFocused();
}
async function find(page, id = native) {
  await page.locator('#session-lookup-input').fill(id);
  await page.locator('#session-lookup-form button').click();
  await expect(page.locator('#session-lookup-form')).not.toHaveAttribute('aria-busy', 'true');
}
async function apply(page) {
  await page.locator('#session-lookup-apply').click();
  await expect(page.locator('#session-lookup-modal')).toBeHidden();
  await page.evaluate(() => ccWorkspace.persist());
}
async function safe(page, fixture) {
  expect(await page.evaluate(() => sent.filter(x => x.type === 'input'))).toEqual([]);
  expect(fixture.requests.filter(r => r.path.startsWith('/api/sessions') && r.method !== 'GET')).toEqual([]);
  expect(fixture.errors).toEqual([]);
}

test('exact lookup needs confirmation, preserves current terminal and persists split', async ({ page }) => {
  const fixture = await setup(page);
  await page.evaluate(() => { window.kept = { pane: active, term: active.term, ws: active.ws }; });
  await launch(page); await find(page);
  await expect(page.locator('#session-lookup-results')).toContainText(native);
  expect(fixture.data.opens).toEqual([]);
  await apply(page);
  expect(fixture.data.opens).toHaveLength(1);
  expect(fixture.data.opens[0]).toMatchObject({ query: native, expected: 'snapshot1', confirmed: true });
  expect(await ids(page)).toEqual(['demo01', 'demo02']);
  expect(await page.evaluate(() => panes[0] === kept.pane && panes[0].term === kept.term && panes[0].ws === kept.ws)).toBe(true);
  await page.reload(); await page.waitForFunction(() => ccWorkspace?.ready && panes.length === 2);
  expect(await ids(page)).toEqual(['demo01', 'demo02']); await safe(page, fixture);
});

for (const agent of ['codex', 'claude', 'opencode']) {
  test(`${agent} local history wakes by exact identity only on explicit click`, async ({ page }) => {
    const fixture = await setup(page, { lookup: { matches: [choice({ id: null, key: 'dialog_example', agent, action: 'import', reason: '原启动参数未知，将使用当前配置和常规权限' })] } });
    await launch(page); await find(page);
    await expect(page.locator('#session-lookup-apply')).toContainText('唤醒并分屏');
    await expect(page.locator('#session-lookup-results')).toContainText('常规权限');
    expect(fixture.data.opens).toEqual([]);
    await apply(page); expect(await ids(page)).toEqual(['demo01', 'imported']);
    await safe(page, fixture);
  });
}

for (const width of [1440, 390]) {
  test(`pending native confirmation opens on chosen screen without terminal input at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await setup(page, { lookup: { pending: true, matches: [choice({ id: null, key: 'dialog_example', agent: 'claude', action: 'import' })] } });
    await launch(page); await find(page);
    await page.locator('#session-lookup-target').selectOption('new');
    await apply(page);
    expect(await ids(page)).toEqual(['imported']);
    await expect(page.locator('#toast')).toContainText('原会话尚未确认加载');
    expect(fixture.data.opens).toHaveLength(1);
    await page.reload(); await page.waitForFunction(() => ccWorkspace?.ready);
    expect(await ids(page)).toEqual(['imported']);
    await page.locator('#ws-screen-tabs button').first().click();
    await expect.poll(() => ids(page)).toEqual(['demo01']);
    await safe(page, fixture);
  });
}

for (const width of [1440, 390, 320]) test(`same ID exposes waiting terminal instead of suggesting a second wake at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await setup(page, { lookup: { pending: true, matches: [choice({ id: 'demo03', agent: 'claude', name: 'Claude discussion', resumePending: true,
    reason: '窗口已启动，原会话尚未确认加载。请在终端完成目录信任等启动确认；不会重复启动或自动确认。' })] } });
  await launch(page); await find(page);
  await expect(page.locator('#session-lookup-results')).toContainText('等待原生确认');
  await expect(page.locator('#session-lookup-apply')).toHaveText('打开待确认窗口');
  await expect(page.locator('#session-lookup-modal')).not.toHaveClass(/is-opening/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('#session-lookup-apply').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: `/tmp/webcc-v115-pending-${width}.png` });
  await apply(page); expect(await ids(page)).toEqual(width > 820 ? ['demo01', 'demo03'] : ['demo03']);
  await safe(page, fixture);
});

test('stopped Web window wakes and replaces only its existing offline placeholder', async ({ page }) => {
  const fixture = await setup(page, { extraTabs: [{ id: 'saved', cwd: '/workspace/demo', type: 'codex', alive: false }],
    initial: { panes: ['demo01', 'saved'], active: 'demo01' }, lookup: { matches: [choice({ id: 'saved', action: 'resume' })] } });
  await launch(page); await find(page); await apply(page);
  expect(await ids(page)).toEqual(['demo01', 'saved']);
  await expect(page.locator('.ws-offline-pane')).toHaveCount(0); await safe(page, fixture);
});

test('full screen opens on a new screen and keeps the old four-pane arrangement', async ({ page }) => {
  const fixture = await setup(page, { initial: { panes: ['demo01', 'demo02', 'demo03', 'demo04'], active: 'demo01' }, lookup: { matches: [choice({ id: null, action: 'import' })] } });
  await launch(page); await find(page);
  await expect(page.locator('#session-lookup-target')).toHaveValue('new');
  await expect(page.locator('#session-lookup-target option[value=current]')).toBeDisabled();
  await apply(page); expect(await ids(page)).toEqual(['imported']);
  await page.locator('#ws-screen-tabs button').first().click();
  await expect.poll(() => ids(page)).toEqual(['demo01', 'demo02', 'demo03', 'demo04']);
  await safe(page, fixture);
});

test('already visible terminal focuses without duplicating or opening another socket', async ({ page }) => {
  const fixture = await setup(page, { lookup: { matches: [choice({ id: 'demo01' })] } });
  const before = await page.evaluate(() => socketCount);
  await launch(page); await find(page, 'cc_demo01'); await apply(page);
  expect(await ids(page)).toEqual(['demo01']); expect(await page.evaluate(() => socketCount)).toBe(before);
  await safe(page, fixture);
});

test('an existing terminal on a full screen defaults to focusing the current screen', async ({ page }) => {
  const fixture = await setup(page, { initial: { panes: ['demo01', 'demo02', 'demo03', 'demo04'], active: 'demo01' } });
  await launch(page); await find(page);
  await expect(page.locator('#session-lookup-target')).toHaveValue('current');
  await apply(page); expect(await ids(page)).toEqual(['demo01', 'demo02', 'demo03', 'demo04']);
  await expect(page.locator('#ws-screen-tabs button')).toHaveCount(1); await safe(page, fixture);
});

test('user can explicitly choose a new screen even when current screen has space', async ({ page }) => {
  const fixture = await setup(page);
  await launch(page); await find(page); await page.locator('#session-lookup-target').selectOption('new');
  await expect(page.locator('#session-lookup-target')).toHaveValue('new');
  await apply(page); expect(await ids(page)).toEqual(['demo02']);
  await page.locator('#ws-screen-tabs button').first().click();
  await expect.poll(() => ids(page)).toEqual(['demo01']); await safe(page, fixture);
});

test('sixteen full screens cannot cause a wake with no placement available', async ({ page }) => {
  const names = ['demo01', 'demo02', 'demo03', 'demo04'];
  const extraTabs = Array.from({ length: 60 }, (_, n) => ({ id: 'extra' + n, cwd: '/workspace/demo', type: 'shell', alive: true }));
  const all = names.concat(extraTabs.map(t => t.id));
  const screens = Array.from({ length: 16 }, (_, n) => ({ id: 's' + n, name: 'Screen ' + n, panes: all.slice(n * 4, n * 4 + 4), active: all[n * 4], direction: 'auto' }));
  const fixture = await setup(page, { identity: 'idlimit', extraTabs,
    layouts: { '/api/layouts/desktop_idlimit': { ...screens[0], screenSchema: 1, screens, activeScreen: 's0', revision: 1 } },
    lookup: { matches: [choice({ id: null, action: 'import' })] } });
  await launch(page); await find(page);
  await expect(page.locator('#session-lookup-apply')).toBeDisabled();
  expect(fixture.data.opens).toEqual([]); await safe(page, fixture);
});

test('layout conflict before confirmation prevents a native open', async ({ page }) => {
  const fixture = await setup(page); await launch(page); await find(page);
  await page.route('**/api/layouts/*', route => route.request().method() === 'PUT' ? route.fulfill({ status: 409, json: { detail: 'Conflict' } }) : route.fallback());
  await page.evaluate(() => ccWorkspace.layoutChanged());
  await page.locator('#session-lookup-apply').click();
  await expect(page.locator('#session-lookup-state')).toContainText('布局');
  expect(fixture.data.opens).toEqual([]); expect(await ids(page)).toEqual(['demo01']); await safe(page, fixture);
});

test('layout save failure after open retains the pane without retrying the native action', async ({ page }) => {
  const fixture = await setup(page); await launch(page); await find(page);
  await page.route('**/api/layouts/*', route => route.request().method() === 'PUT' && fixture.data.opens.length ? route.fulfill({ status: 409, json: { detail: 'Conflict' } }) : route.fallback());
  await page.locator('#session-lookup-apply').click();
  await expect(page.locator('#session-lookup-state')).toContainText('窗口已打开，但布局尚未同步');
  expect(fixture.data.opens).toHaveLength(1); expect(await ids(page)).toEqual(['demo01', 'demo02']);
  await expect(page.locator('#session-lookup-apply')).toBeDisabled(); await safe(page, fixture);
});

test('moving an existing window by ID removes its previous screen placement', async ({ page }) => {
  const fixture = await setup(page);
  await launch(page); await find(page); await apply(page);
  await page.locator('#ws-screen-add').click();
  await expect.poll(() => ids(page)).toEqual([]);
  await launch(page); await find(page); await apply(page);
  expect(await ids(page)).toEqual(['demo02']);
  await page.locator('#ws-screen-tabs button').first().click();
  await expect.poll(() => ids(page)).toEqual(['demo01']); await safe(page, fixture);
});

test('missing, invalid and externally occupied IDs cannot start anything', async ({ page }) => {
  const fixture = await setup(page, { lookup: { matches: [] } });
  await launch(page); await find(page, '../bad;id');
  expect(fixture.data.queries).toEqual([]);
  await find(page); await expect(page.locator('#session-lookup-state')).toContainText('未找到此 ID');
  fixture.data.matches = [choice({ action: 'blocked', reason: '此对话正在其他原生终端运行，请先在那里退出' })];
  await find(page); await expect(page.locator('#session-lookup-apply')).toBeDisabled();
  await expect(page.locator('#session-lookup-results input')).toBeDisabled();
  fixture.data.matches = [choice({ action: 'blocked', agent: null, reason: '旧窗口缺少可验证的程序类型' })];
  await find(page); await expect(page.locator('#session-lookup-results')).toContainText('程序未识别');
  await expect(page.locator('#session-lookup-results')).not.toContainText('Claude');
  await page.keyboard.press('Escape');
  expect(fixture.data.opens).toEqual([]); expect(await ids(page)).toEqual(['demo01']); await safe(page, fixture);
});

test('multiple matches require selection and text is not interpreted as HTML', async ({ page }) => {
  const fixture = await setup(page, { lookup: { matches: [choice({ name: '<img src=x onerror=alert(1)>' }), choice({ key: 'second', id: 'demo03', agent: 'claude' })] } });
  await launch(page); await find(page);
  await expect(page.locator('#session-lookup-apply')).toBeDisabled();
  await expect(page.locator('#session-lookup-results img')).toHaveCount(0);
  await page.locator('#session-lookup-results input').nth(1).check(); await apply(page);
  expect(fixture.data.opens[0].key).toBe('second'); expect(await ids(page)).toEqual(['demo01', 'demo03']); await safe(page, fixture);
});

test('editing query or closing dialog invalidates late search responses', async ({ page }) => {
  const fixture = await setup(page, { lookup: { delay: 350 } });
  await launch(page);
  await page.locator('#session-lookup-input').fill(native); await page.locator('#session-lookup-form button').click();
  await page.locator('#session-lookup-input').fill('different');
  await page.waitForTimeout(450);
  await expect(page.locator('#session-lookup-results')).toBeEmpty(); await expect(page.locator('#session-lookup-apply')).toBeDisabled();
  await page.locator('#session-lookup-form button').click(); await page.keyboard.press('Escape');
  await page.waitForTimeout(450); await expect(page.locator('#session-lookup-modal')).toBeHidden();
  expect(fixture.data.opens).toEqual([]); await safe(page, fixture);
});

test('failed open does not retry or change layout and requires a fresh lookup', async ({ page }) => {
  const fixture = await setup(page, { lookup: { error: 409 } });
  await launch(page); await find(page); await page.locator('#session-lookup-apply').click();
  await expect(page.locator('#session-lookup-state')).toContainText('不会自动重试');
  await expect(page.locator('#session-lookup-apply')).toBeDisabled();
  expect(fixture.data.opens).toHaveLength(1); expect(await ids(page)).toEqual(['demo01']);
  fixture.data.error = 0; await find(page); await apply(page); await safe(page, fixture);
});

test('double clicks and Escape cannot repeat or cancel an in-flight wake operation', async ({ page }) => {
  const fixture = await setup(page, { lookup: { openDelay: 350 } });
  await launch(page); await find(page); await page.locator('#session-lookup-apply').click();
  await expect(page.locator('#session-lookup-modal')).toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('Escape'); await expect(page.locator('#session-lookup-modal')).toBeVisible();
  await expect(page.locator('#session-lookup-apply')).toBeDisabled();
  await expect(page.locator('#session-lookup-modal')).toBeHidden();
  expect(fixture.data.opens).toHaveLength(1); await safe(page, fixture);
});

test('device switch during wake does not insert into the mobile layout', async ({ page }) => {
  const fixture = await setup(page, { lookup: { openDelay: 500 } });
  await launch(page); await find(page); await page.locator('#session-lookup-apply').click();
  await expect(page.locator('#session-lookup-modal')).toHaveAttribute('aria-busy', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#session-lookup-state')).toContainText('屏幕或布局用户已变化');
  expect(fixture.data.opens).toHaveLength(1);
  expect(await ids(page)).not.toContain('demo02');
  await safe(page, fixture);
});

test('IME Enter does not submit lookup', async ({ page }) => {
  const fixture = await setup(page); await launch(page);
  await page.locator('#session-lookup-input').fill(native);
  await page.locator('#session-lookup-input').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  expect(fixture.data.queries).toEqual([]); await safe(page, fixture);
});

test('an empty slot on another screen is not mistaken for an imported session', async ({ page }) => {
  const screens = [{ id: 'first', name: 'First', panes: ['demo01'], active: 'demo01' },
    { id: 'second', name: 'Second', panes: [null], active: null }];
  const fixture = await setup(page, { identity: 'empty-id',
    layouts: { '/api/layouts/desktop_empty-id': { ...screens[0], screenSchema: 1, screens, activeScreen: 'first', revision: 1 } },
    lookup: { matches: [choice({ id: null, action: 'import' })] } });
  await launch(page); await find(page);
  await expect(page.locator('#session-lookup-results')).not.toContainText('已在');
  await apply(page); expect(await ids(page)).toEqual(['demo01', 'imported']); await safe(page, fixture);
});

test('long supported OpenCode IDs are not truncated by the input', async ({ page }) => {
  const fixture = await setup(page, { lookup: { matches: [] } });
  const value = 'ses_' + 'a'.repeat(64);
  await launch(page); await find(page, value);
  await expect(page.locator('#session-lookup-input')).toHaveValue(value);
  expect(fixture.data.queries).toEqual([value]); await safe(page, fixture);
});

test('command palette exposes ID lookup without any automatic lookup or wake', async ({ page }) => {
  const fixture = await setup(page);
  await page.locator('#ws-command').click();
  await page.locator('#ws-palette-input').fill('按 ID');
  await page.locator('#ws-palette-list button').first().click();
  await expect(page.locator('#session-lookup-modal')).toBeVisible();
  expect(fixture.data.queries).toEqual([]); expect(fixture.data.opens).toEqual([]); await safe(page, fixture);
});

test('lookup errors allow a manual retry without automatically sending a wake', async ({ page }) => {
  const fixture = await setup(page); await launch(page);
  await page.route('**/api/session-lookup?*', r => r.fulfill({ status: 503, json: { detail: 'Local history unavailable' } }), { times: 1 });
  await find(page); await expect(page.locator('#session-lookup-state')).toContainText('Local history unavailable');
  await expect(page.locator('#session-lookup-apply')).toBeDisabled();
  await find(page); await expect(page.locator('#session-lookup-apply')).toBeEnabled();
  expect(fixture.data.opens).toEqual([]); await safe(page, fixture);
});

for (const theme of ['dark', 'light']) for (const width of [1440, 390, 320]) {
  test(`ID dialog fits ${theme} ${width} and uses existing theme`, async ({ page }) => {
    await page.setViewportSize({ width, height: width > 820 ? 900 : 844 });
    const fixture = await setup(page, { theme, lookup: { matches: [choice({ id: null, name: '原会话 / Original discussion', action: 'import',
      cwd: '/workspace/projects/long-but-synthetic-example/feature-discussion', reason: '原启动参数未知，将使用当前配置和常规权限' })] } });
    await launch(page); await find(page);
    await expect(page.locator('#session-lookup-modal')).not.toHaveClass(/is-opening/);
    const bounds = await page.locator('.session-lookup-box').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(845 + (width > 820 ? 55 : 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const selector of ['#session-lookup-apply', '#session-lookup-target']) {
      expect(await page.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    await page.screenshot({ path: `/tmp/webcc-v114-id-${theme}-${width}.png` });
    if (process.env.WEBCC_AXE) {
      const AxeBuilder = require(process.env.WEBCC_AXE).default;
      const audit = await new AxeBuilder({ page }).include('#session-lookup-modal').analyze();
      expect(audit.violations).toEqual([]);
    }
    await safe(page, fixture);
  });
}
