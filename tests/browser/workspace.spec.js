const { test, expect } = require('@playwright/test');
const { workspace } = require('./workspace-fixture.cjs');

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
  await expect(page.locator('#ws-save-indicator')).toHaveText('布局未保存');
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
  await page.reload();
  await page.waitForFunction(() => ccWorkspace?.ready);
  expect(await page.locator('#ws-workspace-list').evaluate(el => el.scrollTop)).toBe(top);
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
  await expect(page.locator('#ws-save-indicator')).toHaveText('布局未保存');
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
