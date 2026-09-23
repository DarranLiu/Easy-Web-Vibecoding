const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '../../frontend');
const sessions = Array.from({ length: 4 }, (_, i) => ({
  id: `demo0${i}`, name: `Demo ${i + 1}`, title: 'Theme preview',
  cwd: '/workspace/demo', type: 'shell', alive: true,
}));
const output = [
  '\x1b[0mReadable terminal',
  '\x1b[48;5;255m\x1b[39mIndexed light background input\x1b[K',
  '\x1b[48;2;238;238;238m\x1b[38;2;228;228;228mRGB light background input\x1b[K',
  '\x1b[48;5;234m\x1b[38;5;235mIndexed dark background input\x1b[K',
  '\x1b[48;2;30;30;30m\x1b[38;2;36;36;36mRGB dark background input\x1b[K',
  '\x1b[48;5;255m\x1b[39m\x1b[2mDim placeholder\x1b[K',
  '\x1b[7mInverse text',
].map(line => line + '\x1b[0m\r\n').join('');

async function fixture(page, theme = null, system = 'dark') {
  await page.emulateMedia({ colorScheme: system });
  await page.addInitScript(initialTheme => {
    if (!localStorage.getItem('theme_fixture_seeded')) {
      if (initialTheme !== null) localStorage.setItem('cc_theme', initialTheme);
      localStorage.setItem('theme_fixture_seeded', '1');
    }
    window.fixtureInput = [];
    // No PTY, account, backend, or real WebSocket is used by these tests.
    window.WebSocket = class {
      constructor() {
        this.readyState = 0;
        setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 10);
      }
      send(message) {
        const data = JSON.parse(message);
        if (data.type === 'input') window.fixtureInput.push(data.data);
      }
      close() { this.readyState = 3; this.onclose?.(); }
    };
  }, theme);
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://webcc.test') return route.abort();
    const api = {
      '/api/config': { defaultDir: '/workspace/demo', types: { shell: true } },
      '/api/sessions': { sessions, groups: {}, manualGroups: [] },
      '/api/presence': { count: 1, strangers: 0, ips: [] },
    };
    if (url.pathname.startsWith('/api/')) {
      return route.fulfill({ json: api[url.pathname] || {} });
    }
    const file = path.resolve(frontend, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(frontend + path.sep) || !fs.existsSync(file)) {
      return route.fulfill({ status: 404, body: '' });
    }
    const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto('http://webcc.test/');
  await ready(page);
}

async function ready(page) {
  await page.waitForFunction(() => typeof active !== 'undefined' && active?.term && active.ws?.readyState === 1);
  await page.evaluate(() => document.fonts.ready);
}

async function paint(page) {
  await page.evaluate(async text => {
    for (const pane of panes) {
      await new Promise(resolve => pane.term.write('\x1b[2J\x1b[H' + text, resolve));
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, output);
}

async function colors(page) {
  return page.evaluate(() => {
    function rgb(value) {
      if (value.startsWith('#')) return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
      return value.match(/[\d.]+/g).map(Number);
    }
    function over(fg, bg) {
      const alpha = fg[3] === undefined ? 1 : fg[3];
      return fg.slice(0, 3).map((v, i) => v * alpha + bg[i] * (1 - alpha));
    }
    function luminance(color) {
      return color.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    }
    return panes.flatMap((pane, index) => [...pane.host.querySelectorAll('.xterm-rows span')]
      .filter(span => span.textContent.trim())
      .map(span => {
        const style = getComputedStyle(span);
        const background = over(rgb(style.backgroundColor), rgb(pane.term.options.theme.background));
        const foreground = over(rgb(style.color), background);
        const a = luminance(background), b = luminance(foreground);
        return { pane: index, text: span.textContent.trim(), background, foreground, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      }));
  });
}

async function readable(page) {
  const cells = await colors(page);
  expect(cells.length).toBeGreaterThanOrEqual(7);
  for (const cell of cells) {
    // xterm deliberately gives SGR dim text a lower target than ordinary text.
    expect(cell.ratio, JSON.stringify(cell)).toBeGreaterThanOrEqual(cell.text === 'Dim placeholder' ? 2.25 : 4.5);
    if (cell.text.includes('light background')) expect(cell.background).toEqual([238, 238, 238]);
    if (cell.text.startsWith('Indexed dark background')) expect(cell.background).toEqual([28, 28, 28]);
    if (cell.text.startsWith('RGB dark background')) expect(cell.background).toEqual([30, 30, 30]);
  }
  return cells;
}

for (const theme of ['dark', 'light']) {
  test(`${theme}: explicit backgrounds stay readable in four panes and after switching`, async ({ page }, info) => {
    await fixture(page, theme);
    await page.evaluate(() => {
      for (const tab of state.tabs.slice(1)) attachTerminal(tab, makePane());
      window.originalTerms = panes.map(p => p.term);
      window.originalSockets = panes.map(p => p.ws);
    });
    await page.waitForFunction(() => panes.every(p => p.ws.readyState === 1));
    await paint(page);
    await readable(page);
    await page.screenshot({ path: info.outputPath(`${theme}.png`) });
    await page.locator('#theme-toggle').click();
    const next = theme === 'dark' ? 'light' : 'dark';
    await expect(page.locator('html')).toHaveAttribute('data-theme', next);
    await expect.poll(() => page.evaluate(() => panes.every(p => p.term.options.theme.background === TERM_THEME[currentTheme()].background))).toBe(true);
    await readable(page);
    expect(await page.evaluate(() => panes.every((p, i) => p.term === originalTerms[i] && p.ws === originalSockets[i]))).toBe(true);
    expect(await page.evaluate(() => window.fixtureInput)).toEqual([]);
    await page.reload();
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', next);
    await paint(page);
    await readable(page);
    await page.evaluate(() => { window.previousSocket = active.ws; active.ws.close(); });
    await page.waitForFunction(() => active.ws !== window.previousSocket && active.ws.readyState === 1);
    await readable(page);
  });
}

test('system theme changes update the page and terminal until manually overridden', async ({ page }) => {
  await fixture(page);
  await paint(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => page.evaluate(() => active.term.options.theme.background)).toBe('#FFFFFF');
  await readable(page);
  await page.locator('#theme-toggle').click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => page.evaluate(() => active.term.options.theme.background)).toBe('#1E1E1E');
  expect(await page.evaluate(() => window.fixtureInput)).toEqual([]);
});

test('theme preference changes and clearing storage synchronize existing tabs', async ({ page, context }) => {
  await fixture(page, 'dark');
  const other = await context.newPage();
  await fixture(other);
  await page.locator('#theme-toggle').click();
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => other.evaluate(() => active.term.options.theme.background)).toBe('#FFFFFF');
  await page.evaluate(() => localStorage.clear());
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => other.evaluate(() => active.term.options.theme.background)).toBe('#1E1E1E');
  expect(await other.evaluate(() => window.fixtureInput)).toEqual([]);
});

test('an invalid saved theme follows the system and mobile text remains visible', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, 'invalid', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await paint(page);
  await readable(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile-dark.png') });
});
