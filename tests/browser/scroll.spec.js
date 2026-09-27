const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const frontend = process.env.WEBCC_FRONTEND || path.resolve(__dirname, '../../frontend');

async function openTerminal(page, selection = false) {
  await page.addInitScript(selection => {
    localStorage.setItem('cc_select_mode', selection ? '1' : '0');
    window.sent = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 10); }
      send(data) { window.sent.push({ ...JSON.parse(data), socket: this.url }); }
      close() { this.readyState = 3; }
    };
  }, selection);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://webcc.test') return route.abort();
    const api = {
      '/api/config': { defaultDir: '/workspace/demo', types: { shell: true } },
      '/api/sessions': { sessions: [{ id: 'demo01', name: 'Demo', cwd: '/workspace/demo', type: 'shell', alive: true }], groups: {}, manualGroups: [] },
      '/api/presence': { count: 1, strangers: 0, ips: [] },
    };
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: api[url.pathname] || {} });
    const file = path.resolve(frontend, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(frontend + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.ttf': 'font/ttf' };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto('http://webcc.test/');
  await page.waitForFunction(() => typeof active !== 'undefined' && active?.ws?.readyState === 1);
  await page.evaluate(() => document.fonts.ready);
}

async function output(page, text) {
  await page.evaluate(text => new Promise(resolve => active.term.write(text, resolve)), text);
}

async function wheel(page, deltaY = -120) {
  await page.locator('.xterm-screen').hover();
  await page.evaluate(() => { window.sent = []; });
  await page.mouse.wheel(0, deltaY);
}

for (const selection of [false, true]) {
  test(`mouse-reporting app receives wheel with selection=${selection}`, async ({ page }) => {
    await openTerminal(page, selection);
    await output(page, '\x1b[?1049h\x1b[?1003h\x1b[?1006hDemo output\r\n');
    await wheel(page);
    await expect.poll(() => page.evaluate(() => sent.filter(m => m.type === 'input' && /\x1b\[<64;/.test(m.data)).length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => sent.some(m => m.type === 'scroll'))).toBe(false);
  });
}

for (const selection of [false, true]) {
  test(`ordinary shell uses server history with selection=${selection}`, async ({ page }) => {
    await openTerminal(page, selection);
    await output(page, '\x1b[?1049hDemo shell\r\n');
    for (const delta of [-120, 120, -120]) {
      await wheel(page, delta);
      await expect.poll(() => page.evaluate(sign => sent.filter(m => m.type === 'scroll' && Math.sign(m.lines) === sign).length, Math.sign(delta))).toBe(1);
      expect(await page.evaluate(() => sent.some(m => m.type === 'input'))).toBe(false);
    }
  });
}

test('selection survives pointer movement and drag reports stay blocked', async ({ page }) => {
  await openTerminal(page, true);
  await output(page, '\x1b[?1049h\x1b[?1003h\x1b[?1006hSelectable output\r\n');
  const box = await page.locator('.xterm-screen').boundingBox();
  await page.mouse.move(box.x + 2, box.y + 6);
  await page.evaluate(() => { window.sent = []; });
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 6, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => active.term.getSelection().length)).toBeGreaterThan(0);
  const selected = await page.evaluate(() => active.term.getSelection());
  await page.mouse.move(box.x + 150, box.y + 30, { steps: 5 });
  expect(await page.evaluate(() => active.term.getSelection())).toBe(selected);
  expect(await page.evaluate(() => sent.some(m => m.type === 'input'))).toBe(false);
  await wheel(page, 120);
  await expect.poll(() => page.evaluate(() => sent.some(m => m.type === 'input' && /\x1b\[<65;/.test(m.data)))).toBe(true);
});

test('wheel classification covers modifiers and excludes pointer reports', async ({ page }) => {
  await openTerminal(page, true);
  expect(await page.evaluate(() => {
    for (const modifiers of [0, 4, 8, 16, 28]) {
      for (const button of [0, 1, 2, 3, 32, 35, 64, 65, 66, 67, 96]) {
        const code = button | modifiers;
        const reports = [
          `\x1b[<${code};1;2M`,
          `\x1b[${code + 32};1;2M`,
          '\x1b[M' + String.fromCharCode(code + 32, 33, 34),
        ];
        if (reports.some(report => isMouseWheelReport(report) !== (button >= 64 && button <= 67))) return false;
      }
    }
    return ['hello', '\x1b[A', '\x1b[<64;1M'].every(data => !isMouseWheelReport(data));
  })).toBe(true);
  await page.evaluate(() => {
    window.sent = [];
    active.term._core.coreService.triggerDataEvent('typed text', true);
  });
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input').map(m => m.data))).toEqual(['typed text']);
});

for (const mouseApp of [false, true]) {
  test(`touch drag routes scrolling with mouseApp=${mouseApp}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openTerminal(page);
    await output(page, '\x1b[?1049h' + (mouseApp ? '\x1b[?1003h\x1b[?1006h' : '') + 'Touch output\r\n');
    await page.evaluate(() => {
      window.sent = [];
      const screen = active.host.querySelector('.xterm-screen');
      const rect = screen.getBoundingClientRect();
      const touch = y => new Touch({ identifier: 1, target: screen, clientX: rect.x + 40, clientY: rect.y + y });
      for (const [type, y] of [['touchstart', 70], ['touchmove', 140], ['touchend', 140]]) {
        screen.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [touch(y)] }));
      }
    });
    await expect.poll(() => page.evaluate(mouseApp => sent.some(m => mouseApp ? m.type === 'input' && /\x1b\[<64;/.test(m.data) : m.type === 'scroll' && m.lines < 0), mouseApp)).toBe(true);
  });
}

test('small trackpad deltas accumulate instead of jumping a line per event', async ({ page }) => {
  await openTerminal(page);
  await output(page, '\x1b[?1049hDemo shell\r\n');
  const result = await page.evaluate(() => {
    window.sent = [];
    const screen = active.host.querySelector('.xterm-screen');
    const emit = delta => screen.dispatchEvent(new WheelEvent('wheel', {
      deltaY: rowPx(active.term) * delta, bubbles: true, cancelable: true,
    }));
    for (let i = 0; i < 4; i++) emit(0.2);
    const before = sent.length;
    for (let i = 0; i < 2; i++) emit(0.2);
    return { before, lines: sent.filter(m => m.type === 'scroll').map(m => m.lines) };
  });
  expect(result).toEqual({ before: 0, lines: [1] });
});

test('changing direction and reconnecting do not reuse stale fractional movement', async ({ page }) => {
  await openTerminal(page);
  await output(page, '\x1b[?1049hDemo shell\r\n');
  const result = await page.evaluate(() => {
    window.sent = [];
    const screen = active.host.querySelector('.xterm-screen');
    const emit = deltaY => screen.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaMode: 1, bubbles: true, cancelable: true }));
    emit(0.75);
    emit(-0.75);
    emit(-0.5);
    const reversed = sent.filter(m => m.type === 'scroll').map(m => m.lines);
    window.sent = [];
    active.ws.readyState = 0;
    emit(0.75);
    active.ws.readyState = 1;
    emit(0.75);
    const pending = sent.length;
    emit(0.5);
    return { reversed, pending, lines: sent.filter(m => m.type === 'scroll').map(m => m.lines) };
  });
  expect(result).toEqual({ reversed: [-1], pending: 0, lines: [1] });
});

for (const mouseApp of [false, true]) {
  test(`zoom gestures do not reach the terminal with mouseApp=${mouseApp}`, async ({ page }) => {
    await openTerminal(page);
    await output(page, '\x1b[?1049h' + (mouseApp ? '\x1b[?1003h\x1b[?1006h' : ''));
    const result = await page.evaluate(() => {
      window.sent = [];
      const screen = active.host.querySelector('.xterm-screen');
      const rect = screen.getBoundingClientRect();
      const event = new WheelEvent('wheel', {
        deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true,
        clientX: rect.x + 40, clientY: rect.y + 40,
      });
      screen.dispatchEvent(event);
      return { prevented: event.defaultPrevented, count: sent.length };
    });
    expect(result).toEqual({ prevented: false, count: 0 });
  });
}

test('wheel targets the hovered split without changing keyboard focus', async ({ page }) => {
  await openTerminal(page, true);
  await page.evaluate(() => {
    window.firstPane = active;
    attachTerminal({ id: 'demo02', name: 'Other', cwd: '/workspace/demo', type: 'shell', alive: true }, makePane());
  });
  await page.waitForFunction(() => panes.every(p => p.ws?.readyState === 1));
  await page.evaluate(async () => {
    for (const pane of panes) await new Promise(resolve => pane.term.write('\x1b[?1049hDemo shell\r\n', resolve));
  });
  await page.locator('.xterm-screen').first().hover();
  await page.evaluate(() => { window.sent = []; });
  await page.mouse.wheel(0, -120);
  await expect.poll(() => page.evaluate(() => sent.filter(m => m.type === 'scroll').length)).toBe(1);
  expect(await page.evaluate(() => ({
    correctSocket: sent.filter(m => m.type === 'scroll').every(m => m.socket === firstPane.ws.url),
    focusUnchanged: active !== firstPane,
    noInput: !sent.some(m => m.type === 'input'),
  }))).toEqual({ correctSocket: true, focusUnchanged: true, noInput: true });
});

test('gesture pause, socket replacement and mode switch clear fractional movement', async ({ page }) => {
  await openTerminal(page);
  await output(page, '\x1b[?1049hDemo shell\r\n');
  const result = await page.evaluate(async () => {
    window.sent = [];
    const screen = active.host.querySelector('.xterm-screen');
    const rect = screen.getBoundingClientRect();
    const emit = deltaY => screen.dispatchEvent(new WheelEvent('wheel', {
      deltaY, deltaMode: 1, bubbles: true, cancelable: true,
      clientX: rect.x + 40, clientY: rect.y + 40,
    }));
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
      emit(0.75);
      now += 300;
      emit(0.75);
      const afterPause = sent.length;
      const socket = active.ws;
      active.ws = { readyState: 1, send: socket.send.bind(socket) };
      emit(0.75);
      const afterReplacement = sent.length;
      await new Promise(resolve => active.term.write('\x1b[?1003h\x1b[?1006h', resolve));
      emit(-1);
      await new Promise(resolve => active.term.write('\x1b[?1003l', resolve));
      window.sent = [];
      emit(0.75);
      const afterModeSwitch = sent.length;
      emit(0.5);
      return { afterPause, afterReplacement, afterModeSwitch, lines: sent.map(m => m.lines) };
    } finally { Date.now = originalNow; }
  });
  expect(result).toEqual({ afterPause: 0, afterReplacement: 0, afterModeSwitch: 0, lines: [1] });
});

test('line and page units, font height and extreme deltas are normalized', async ({ page }) => {
  await openTerminal(page);
  expect(await page.evaluate(() => {
    const term = active.term;
    return {
      pixel: wheelToLines({ deltaY: rowPx(term) * 2, deltaMode: 0 }, term),
      line: wheelToLines({ deltaY: -3, deltaMode: 1 }, term),
      page: wheelToLines({ deltaY: 1, deltaMode: 2 }, term),
      rows: term.rows,
      capped: wheelToLines({ deltaY: 100000, deltaMode: 0 }, term),
      invalid: wheelToLines({ deltaY: Infinity, deltaMode: 0 }, term),
      horizontal: wheelToLines({ deltaY: 0, deltaX: 120, deltaMode: 0 }, term),
    };
  })).toEqual(expect.objectContaining({ pixel: 2, line: -3, capped: 120, invalid: 0, horizontal: 0 }));
  expect(await page.evaluate(() => wheelToLines({ deltaY: 1, deltaMode: 2 }, active.term))).toBe(await page.evaluate(() => Math.min(120, active.term.rows)));
});
