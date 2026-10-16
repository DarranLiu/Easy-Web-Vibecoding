const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const frontend = process.env.WEBCC_FRONTEND || path.resolve(__dirname, '../../frontend');

async function openTerminal(page, selection = false) {
  await page.addInitScript(selection => {
    localStorage.setItem('cc_ui', 'legacy');
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

async function trustedTouch(client, type, x, y) {
  await client.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4 }],
  });
}

async function swipePhone(page, element = '.xterm-screen', hold = false) {
  const box = await page.locator(element).first().boundingBox();
  const x = box.x + Math.min(45, box.width / 2), y = box.y + Math.min(70, box.height / 4);
  const client = await page.context().newCDPSession(page);
  await trustedTouch(client, 'touchStart', x, y);
  if (hold) await page.waitForTimeout(500);
  for (let i = 1; i <= 8; i++) {
    await trustedTouch(client, 'touchMove', x, y + i * 10);
    await page.waitForTimeout(16);
  }
  await trustedTouch(client, 'touchEnd', x, y + 80);
  await client.detach();
}

for (const selection of [false, true]) {
  for (const mouseApp of [false, true]) {
    test(`trusted phone swipe with selection=${selection} and mouseApp=${mouseApp}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const page = await context.newPage();
      await openTerminal(page, selection);
      await output(page, '\x1b[?1049h' + (mouseApp ? '\x1b[?1003h\x1b[?1006h' : '') + 'Phone history\r\n');
      await page.evaluate(() => {
        window.sent = []; window.trustedMoves = 0;
        active.host.addEventListener('touchmove', e => { if (e.isTrusted) trustedMoves++; }, { capture: true });
      });
      await swipePhone(page);
      expect(await page.evaluate(() => trustedMoves)).toBeGreaterThan(0);
      await expect.poll(() => page.evaluate(mouseApp => sent.some(m => mouseApp ? m.type === 'input' && /\x1b\[<64;/.test(m.data) : m.type === 'scroll' && m.lines < 0), mouseApp)).toBe(true);
      expect(await page.evaluate(() => active.term.hasSelection())).toBe(false);
      await context.close();
    });
  }
}

test('phone Enter and choices stay on screen at 320px', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await openTerminal(page);
  const enter = page.locator('#auxbar [aria-label="↵"],#auxbar [aria-label="回车"]');
  const bar = await page.locator('#auxbar').boundingBox(), key = await enter.boundingBox();
  expect(key.x + key.width).toBeLessThanOrEqual(bar.x + bar.width);
  expect(key.x).toBeGreaterThanOrEqual(bar.x);
  await page.evaluate(() => { window.sent = []; });
  await page.locator('#auxbar [aria-label="↓"]').tap();
  await enter.tap();
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input').map(m => m.data))).toEqual(['\x1b[B', '\r']);
  await context.close();
});

test('phone long press selects without blocking the next swipe', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await openTerminal(page, true);
  await output(page, '\x1b[?1049h\x1b[?1003h\x1b[?1006h' + Array(15).fill('Select this demo output\r\n').join(''));
  await page.evaluate(() => { window.sent = []; });
  await swipePhone(page, '.xterm-screen', true);
  expect(await page.evaluate(() => active.term.getSelection().length)).toBeGreaterThan(1);
  expect(await page.evaluate(() => sent.filter(m => ['input', 'scroll'].includes(m.type)))).toEqual([]);
  expect(await page.evaluate(() => active.touchSelecting)).toBe(false);
  await swipePhone(page);
  await expect.poll(() => page.evaluate(() => sent.some(m => m.type === 'input' && /\x1b\[<64;/.test(m.data)))).toBe(true);
  await context.close();
});

test('phone swipe survives terminal redraws during the gesture', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await openTerminal(page, true);
  await output(page, '\x1b[?1049h' + Array(15).fill('Live output while swiping\r\n').join(''));
  const box = await page.locator('.xterm-screen').boundingBox();
  const x = box.x + 45, y = box.y + 70;
  const client = await context.newCDPSession(page);
  await page.evaluate(() => {
    window.sent = []; window.gestureTarget = null;
    active.host.addEventListener('touchstart', e => { window.gestureTarget = e.target; }, { capture: true, once: true });
  });
  await trustedTouch(client, 'touchStart', x, y);
  expect(await page.evaluate(() => gestureTarget.classList.contains('xterm-screen'))).toBe(true);
  for (let i = 1; i <= 8; i++) {
    await output(page, '\x1b[H' + Array(15).fill(`Live output frame ${i}\r\n`).join(''));
    await trustedTouch(client, 'touchMove', x, y + i * 10);
    await page.waitForTimeout(16);
  }
  await trustedTouch(client, 'touchEnd', x, y + 80);
  await client.detach();
  expect(await page.evaluate(() => gestureTarget.isConnected)).toBe(true);
  await expect.poll(() => page.evaluate(() => sent.some(m => m.type === 'scroll' && m.lines < 0))).toBe(true);
  expect(await page.evaluate(() => active.touchSelecting)).toBe(false);
  expect(await page.evaluate(() => sent.some(m => m.type === 'input'))).toBe(false);
  await context.close();
});

test('phone multitouch cancels pending selection and scrolling', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await openTerminal(page, true);
  await output(page, '\x1b[?1049hMultitouch demo\r\n');
  await page.evaluate(() => { window.sent = []; });
  const box = await page.locator('.xterm-screen').boundingBox();
  const client = await context.newCDPSession(page);
  await trustedTouch(client, 'touchStart', box.x + 40, box.y + 70);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [
      { x: box.x + 40, y: box.y + 70, id: 1 },
      { x: box.x + 100, y: box.y + 70, id: 2 },
    ],
  });
  await page.waitForTimeout(500);
  await trustedTouch(client, 'touchCancel');
  await client.detach();
  expect(await page.evaluate(() => active.term.hasSelection())).toBe(false);
  expect(await page.evaluate(() => sent.filter(m => ['input', 'scroll'].includes(m.type)))).toEqual([]);
  await swipePhone(page);
  await expect.poll(() => page.evaluate(() => sent.some(m => m.type === 'scroll' && m.lines < 0))).toBe(true);
  await context.close();
});

test('phone confirmation uses the terminal cursor key mode and explicit Enter', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('cc_theme', 'dark'));
  await openTerminal(page);
  await output(page, '\x1b[?1049h\x1b[?1h');
  await page.evaluate(() => {
    window.sent = [];
    window.demoChoice = 0; window.demoConfirmed = null;
    const draw = () => active.term.write('\x1b[2J\x1b[HDemo permission request\r\n\r\nAllow example command?\r\n\r\n' +
      (demoChoice === 0 ? '> ' : '  ') + 'Allow once\r\n' + (demoChoice === 1 ? '> ' : '  ') + 'Cancel\r\n');
    const send = active.ws.send.bind(active.ws);
    active.ws.send = data => {
      send(data);
      const m = JSON.parse(data);
      if (m.type !== 'input') return;
      if (m.data === '\x1bOB') demoChoice = 1;
      if (m.data === '\x1bOA') demoChoice = 0;
      if (m.data === '\r') demoConfirmed = demoChoice;
      draw();
    };
    draw();
  });
  expect(await page.evaluate(() => demoConfirmed)).toBe(null);
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input'))).toEqual([]);
  await page.screenshot({ path: '/tmp/webcc-v78-mobile-confirmation-320.png' });
  await page.locator('#auxbar [aria-label="↓"]').tap();
  expect(await page.evaluate(() => demoChoice)).toBe(1);
  await page.locator('#auxbar [aria-label="↑"]').tap();
  expect(await page.evaluate(() => demoChoice)).toBe(0);
  await page.locator('#auxbar [aria-label="↓"]').tap();
  await page.locator('#auxbar [aria-label="回车"]').tap();
  expect(await page.evaluate(() => demoConfirmed)).toBe(1);
  await output(page, '\x1b[?1l');
  await page.locator('#auxbar [aria-label="↓"]').tap();
  await page.locator('#auxbar [aria-label="Esc"]').tap();
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input').map(m => m.data))).toEqual(['\x1bOB', '\x1bOA', '\x1bOB', '\r', '\x1b[B', '\x1b']);
  await context.close();
});

test('phone primary keys stay pinned while secondary keys scroll', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await openTerminal(page);
  await page.evaluate(() => { window.sent = []; });
  const primary = page.locator('.aux-primary'), before = await primary.boundingBox();
  const secondary = await page.locator('.aux-keys').boundingBox();
  const client = await context.newCDPSession(page);
  const x = secondary.x + secondary.width - 4, y = secondary.y + 15;
  await trustedTouch(client, 'touchStart', x, y);
  for (let i = 1; i <= 8; i++) {
    await trustedTouch(client, 'touchMove', x - (secondary.width - 8) * i / 8, y);
    await page.waitForTimeout(16);
  }
  await trustedTouch(client, 'touchEnd', secondary.x + 4, y);
  await client.detach();
  await expect.poll(() => page.locator('.aux-keys').evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => sent.some(m => m.type === 'input'))).toBe(false);
  expect(await primary.boundingBox()).toEqual(before);
  for (const label of ['Esc', 'Tab', 'Ctrl', '↑', '↓', '回车']) {
    const key = await page.locator(`#auxbar [aria-label="${label}"]`).boundingBox();
    expect(key.x).toBeGreaterThanOrEqual(before.x);
    expect(key.x + key.width).toBeLessThanOrEqual(before.x + before.width);
  }
  await context.close();
});

test('phone confirmation controls fit a reduced keyboard-height viewport', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await openTerminal(page);
  for (const height of [540, 440, 844]) {
    await page.setViewportSize({ width: 320, height });
    await expect.poll(() => page.evaluate(() => {
      const footer = document.getElementById('workspace-footer').getBoundingClientRect();
      const screen = active.host.querySelector('.xterm-screen').getBoundingClientRect();
      const inView = rect => rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= visualViewport.height + 1;
      return inView(footer) && inView(screen) && screen.bottom <= footer.top && active.term.rows > 0 &&
        [...document.querySelectorAll('.aux-primary .keycap')].every(key => inView(key.getBoundingClientRect()));
    })).toBe(true);
  }
  await page.evaluate(() => { window.sent = []; });
  await page.locator('#auxbar [aria-label="回车"]').tap();
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input').map(m => m.data))).toEqual(['\r']);
  await context.close();
});

test('phone swipes focus the touched split without sending task input', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await openTerminal(page, true);
  await page.evaluate(() => {
    window.firstPane = active;
    attachTerminal({ id: 'demo02', name: 'Other', cwd: '/workspace/demo', type: 'shell', alive: true }, makePane());
  });
  await page.waitForFunction(() => panes.every(p => p.ws?.readyState === 1));
  await page.evaluate(async () => {
    for (const pane of panes) await new Promise(resolve => pane.term.write('\x1b[?1049hSplit demo\r\n', resolve));
    window.sent = [];
  });
  await swipePhone(page, '.pane-host');
  expect(await page.evaluate(() => active === firstPane)).toBe(true);
  expect(await page.evaluate(() => sent.some(m => m.type === 'input'))).toBe(false);
  await page.locator('#auxbar [aria-label="↓"]').tap();
  await page.locator('#auxbar [aria-label="回车"]').tap();
  expect(await page.evaluate(() => sent.filter(m => m.type === 'input').map(m => ({ data: m.data, correct: m.socket === firstPane.ws.url })))).toEqual([
    { data: '\x1b[B', correct: true }, { data: '\r', correct: true },
  ]);
  expect(await page.evaluate(() => active.term.textarea.getAttribute('inputmode'))).toBe('none');
  await context.close();
});

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

test('non-mouse history scrolling includes terminal padding and unpainted space', async ({ page }) => {
  await openTerminal(page);
  await output(page, '\x1b[?1049hDemo shell\r\n');
  for (const target of ['host', 'screen']) {
    const result = await page.evaluate(target => {
      window.sent = [];
      const el = target === 'host' ? active.host : active.host.querySelector('.xterm-screen');
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -3, deltaMode: 1, bubbles: true, cancelable: true }));
      return sent.map(m => ({ type: m.type, lines: m.lines }));
    }, target);
    expect(result).toEqual([{ type: 'scroll', lines: -3 }]);
  }
});

test('native history scrolling preserves the actual terminal row', async ({ page }) => {
  await openTerminal(page);
  await output(page, '\x1b[?1049hCodex transcript\r\n');
  const result = await page.evaluate(() => {
    const screen = active.host.querySelector('.xterm-screen');
    const rect = screen.getBoundingClientRect();
    const send = (target, clientY) => {
      window.sent = [];
      target.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -3, deltaMode: 1, bubbles: true, cancelable: true,
        clientX: rect.x + 10, clientY,
      }));
      return sent.map(({ type, lines, row }) => ({ type, lines, row }));
    };
    return [1, 2, active.term.rows].map(row => ({
      expected: row,
      messages: send(screen, rect.top + (row - 0.5) * rowPx(active.term)),
    })).concat([{ expected: 2, messages: send(active.host, rect.bottom + 2) }]);
  });
  for (const { expected, messages } of result) {
    expect(messages).toEqual([{ type: 'scroll', lines: -3, row: expected }]);
  }
});

for (const mouseApp of [false, true]) {
  test(`touch retains the original transcript row with mouseApp=${mouseApp}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openTerminal(page);
    await output(page, '\x1b[?1049h' + (mouseApp ? '\x1b[?1003h\x1b[?1006h' : '') + 'Touch transcript\r\n');
    await page.evaluate(() => {
      window.sent = [];
      const screen = active.host.querySelector('.xterm-screen');
      const rect = screen.getBoundingClientRect();
      const startY = rect.y + 1.5 * rowPx(active.term);
      const touch = y => new Touch({ identifier: 1, target: screen, clientX: rect.x + 10, clientY: y });
      for (const [type, y] of [['touchstart', startY], ['touchmove', startY + 6 * rowPx(active.term)], ['touchend', startY + 6 * rowPx(active.term)]]) {
        screen.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [touch(y)] }));
      }
    });
    await expect.poll(() => page.evaluate(() => sent.length)).toBeGreaterThan(0);
    if (mouseApp) {
      expect(await page.evaluate(() => sent.filter(m => m.type === 'input').every(m => /\x1b\[<64;\d+;2M/.test(m.data)))).toBe(true);
    } else {
      expect(await page.evaluate(() => sent.filter(m => m.type === 'scroll').map(m => m.row))).toEqual([2]);
    }
  });
}
