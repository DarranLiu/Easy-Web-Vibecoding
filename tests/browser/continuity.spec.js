const { test, expect } = require('@playwright/test');
const { workspace } = require('./workspace.fixture.cjs');

function stopped(id, type = 'codex', eligible = true) {
  return { id, name: type + ' saved session', type, cwd: '/workspace/demo', alive: false,
    continuity: { state: eligible ? 'available' : 'idle', eligible, expected: eligible ? id + '-proof' : null } };
}
function options(extra = {}) {
  const panes = ['demo01', 'saved02', 'saved03', 'legacy'];
  const layout = { revision: 3, screenSchema: 1, activeScreen: 'main', panes, active: 'demo01', direction: 'auto',
    ratios: { cols: [1, 2], rows: [2, 1, 1, 1] }, maximized: null };
  layout.screens = [{ ...layout, id: 'main', name: 'Main' },
    { id: 'later', name: 'Later', panes: ['hidden01'], active: 'hidden01', ratios: {}, direction: 'auto' }];
  return { identity: 'continuity', layouts: { '/api/layouts/desktop_continuity': layout },
    extraTabs: [stopped('saved02'), stopped('saved03', 'claude'), stopped('legacy', 'opencode', false), stopped('hidden01')], ...extra };
}
const queued = fixture => fixture.requests.filter(r => r.path.endsWith('/restore') && r.method === 'POST');
const commands = fixture => fixture.requests.filter(r => r.method === 'POST' && /\/(start|restart|update)$/.test(r.path));

test('only visible proven reboot sessions queue, without global navigation locks or upgrades', async ({ page }) => {
  const fixture = await workspace(page, 'dark', options({ restoreDelay: 500 }));
  await expect.poll(() => queued(fixture).length).toBe(2);
  expect(queued(fixture).map(r => r.path).sort()).toEqual(['/api/sessions/saved02/restore', '/api/sessions/saved03/restore']);
  expect(await page.evaluate(() => openingTab)).toBeFalsy();
  await page.locator('[data-screen="later"]').click();
  await expect(page.locator('[data-screen="later"]')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => queued(fixture).length).toBe(3);
  expect(commands(fixture)).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('live placeholders reconnect in place without replacing other terminals or stealing focus', async ({ page }) => {
  const fixture = await workspace(page, 'dark', options());
  await expect.poll(() => queued(fixture).length).toBe(2);
  await page.evaluate(() => {
    window.beforeRecovery = { active, term: active.term, ws: active.ws, pane: panes[1], ratios: JSON.stringify(gridFr), sockets: socketCount };
    const input = document.createElement('input'); input.id = 'focus-proof'; document.body.append(input); input.focus();
  });
  fixture.tabs.find(t => t.id === 'saved02').alive = true;
  await page.evaluate(() => loadTabs());
  await expect.poll(() => page.evaluate(() => !!panes.find(p => p.tab?.id === 'saved02')?.term)).toBe(true);
  expect(await page.evaluate(() => ({
    active: active === beforeRecovery.active, term: active.term === beforeRecovery.term, ws: active.ws === beforeRecovery.ws,
    cell: panes[1] === beforeRecovery.pane, ratios: JSON.stringify(gridFr) === beforeRecovery.ratios,
    focus: document.activeElement.id, added: socketCount - beforeRecovery.sockets,
  }))).toEqual({ active: true, term: true, ws: true, cell: true, ratios: true, focus: 'focus-proof', added: 1 });
  await page.evaluate(() => loadTabs());
  expect(queued(fixture)).toHaveLength(2);
  expect(commands(fixture)).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('uncertain response is not repeatedly sent and other panes keep working', async ({ page }) => {
  const fixture = await workspace(page, 'light', options({ restoreFailure: 'saved02' }));
  await expect.poll(() => queued(fixture).length).toBe(2);
  for (let i = 0; i < 4; i++) await page.evaluate(() => loadTabs());
  expect(queued(fixture)).toHaveLength(2);
  expect(await page.evaluate(() => active.tab.id)).toBe('demo01');
  await expect(page.locator('.ws-offline-pane').filter({ hasText: 'Failed to fetch' }).locator('button')).toBeEnabled();
  await page.locator('[data-screen="later"]').click();
  await expect(page.locator('[data-screen="later"]')).toHaveAttribute('aria-selected', 'true');
  expect(commands(fixture)).toEqual([]);
});

test('a late completed recovery never inserts a terminal into a different screen', async ({ page }) => {
  const fixture = await workspace(page, 'dark', options());
  await expect.poll(() => queued(fixture).length).toBe(2);
  await page.locator('[data-screen="later"]').click();
  fixture.tabs.find(t => t.id === 'saved02').alive = true;
  await page.evaluate(() => loadTabs());
  expect(await page.evaluate(() => panes.map(p => p.tab?.id))).toEqual(['hidden01']);
  await page.locator('[data-screen="main"]').click();
  await expect.poll(() => page.evaluate(() => !!panes.find(p => p.tab?.id === 'saved02')?.term)).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test('browser reload reuses queued jobs instead of spawning another native session', async ({ page }) => {
  const fixture = await workspace(page, 'dark', options());
  await expect.poll(() => queued(fixture).length).toBe(2);
  await page.reload();
  await page.waitForFunction(() => ccWorkspace.canResume);
  await page.evaluate(() => loadTabs());
  expect(queued(fixture)).toHaveLength(2);
  expect(await page.evaluate(() => panes.map(p => p.tab?.id))).toEqual(['demo01', 'saved02', 'saved03', 'legacy']);
  expect(commands(fixture)).toEqual([]);
});

test('legacy stopped sessions need confirmation and a live session never receives recovery commands', async ({ page }) => {
  const opt = options();
  opt.extraTabs.forEach(tab => { tab.continuity = { state: 'idle', eligible: false }; });
  const fixture = await workspace(page, 'dark', opt);
  await page.evaluate(() => loadTabs());
  expect(queued(fixture)).toEqual([]);
  fixture.tabs.find(t => t.id === 'legacy').alive = true;
  await page.evaluate(() => loadTabs());
  await expect.poll(() => page.evaluate(() => !!panes.find(p => p.tab?.id === 'legacy')?.term)).toBe(true);
  expect(commands(fixture)).toEqual([]);
});

for (const width of [390, 1440]) for (const theme of ['dark', 'light']) test(`recovery state fits ${width} ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const opt = options({ allowEmpty: true });
  if (width < 821) {
    const source = opt.layouts['/api/layouts/desktop_continuity'];
    opt.layouts['/api/layouts/mobile_continuity'] = { ...source, panes: ['saved02'], active: 'saved02',
      screens: [{ id: 'main', name: 'Main', panes: ['saved02'], active: 'saved02', ratios: {}, direction: 'auto' }] };
  }
  const fixture = await workspace(page, theme, opt);
  await expect.poll(() => queued(fixture).length).toBe(width < 821 ? 1 : 2);
  await page.evaluate(() => loadTabs());
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('.ws-offline-pane').first()).toContainText('等待恢复');
  await page.screenshot({ path: `/tmp/webcc-v118-recovery-${theme}-${width}.png` });
  expect(fixture.errors).toEqual([]);
});
