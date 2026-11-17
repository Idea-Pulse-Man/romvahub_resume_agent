import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { log } from './log.js';

/**
 * Asks ChatGPT through chatgpt.com in a real Chrome window on this computer,
 * signed in with the person's own ChatGPT account — no API key.
 *
 * Chrome is started as an ordinary Chrome (chatgpt.com and Google sign-in
 * refuse a puppeteer-launched one) with its own profile folder and a DevTools
 * port, and puppeteer connects to it. Sign in to ChatGPT in that window once;
 * the profile keeps it. Each question gets its own new tab, closed when the
 * answer is in. The same driver as the romva.space API's local one
 * (backend/src/local/chatgpt-web.ts) — chatgpt.com's markup is the thing to
 * check first if this stops working.
 */

/** ChatGPT itself cannot be used right now (signed out, window closed…): not the application's fault. */
export class ChatGptUnavailable extends Error {}

const SELECTORS = {
  composer: '#prompt-textarea, textarea[name="prompt"], #mobile-composer-prompt, [contenteditable="true"][role="textbox"]',
  send: [
    'button[data-testid="send-button"]',
    '#composer-submit-button',
    'button[aria-label="Send message"]',
    'button[aria-label="Send prompt"]',
  ].join(', '),
};

const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// In-page code as source text, so nothing is rewritten by a bundler on the way in.
const IN_PAGE = {
  fill: (selector, text, how) => `(() => {
    const editor = document.querySelector(${JSON.stringify(selector)});
    if (!editor) return '';
    const text = ${JSON.stringify(text)};
    const isField = editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT';
    editor.focus();
    if (isField) { editor.select(); } else { document.execCommand('selectAll'); }
    document.execCommand('delete');
    if (${JSON.stringify(how)} === 'insert') {
      document.execCommand('insertText', false, text);
    } else if (isField) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value').set;
      setter.call(editor, text);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }
    return isField ? editor.value : editor.innerText;
  })()`,
  signedOut: `Array.from(document.querySelectorAll('button, a')).some((el) => /^log in$/i.test((el.innerText || '').trim()))`,
  freshChat: `(() => !location.pathname.startsWith('/c/')
    && document.querySelectorAll('pre').length === 0
    && !/(You said:|ChatGPT said:)/.test(document.body.innerText || ''))()`,
  answer: (marker) => `(() => {
    const pres = Array.from(document.querySelectorAll('pre'), (p) => p.innerText || '');
    const body = document.body.innerText || '';
    const at = body.lastIndexOf(${JSON.stringify(marker)});
    const tail = at >= 0 ? body.slice(at + ${marker.length}) : '';
    const streaming = Array.from(document.querySelectorAll('button')).some((b) => {
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '');
      return /\\bstop\\b|stop[-_ ]?(generating|streaming|response|button)/i.test(label);
    });
    return { pres, tail, streaming };
  })()`,
  click: `(() => {
    const button = Array.from(document.querySelectorAll(${JSON.stringify(SELECTORS.send)}))
      .find((b) => b.offsetParent !== null && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    if (!button) return false;
    button.click();
    return true;
  })()`,
};

export function createChatGpt(settings) {
  const browserPath = settings.path || BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));
  let connection = null;

  async function debuggerUp() {
    try {
      const response = await fetch(`http://127.0.0.1:${settings.debugPort}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Chrome took its last ending (with the agent) for a crash; say it closed normally, so no "Restore pages?". */
  function markExitedCleanly() {
    const file = path.join(settings.profileDir, 'Default', 'Preferences');
    try {
      if (!existsSync(file)) return;
      const prefs = JSON.parse(readFileSync(file, 'utf8'));
      prefs.profile = { ...prefs.profile, exit_type: 'Normal', exited_cleanly: true };
      writeFileSync(file, JSON.stringify(prefs));
    } catch {
      // Cosmetic only.
    }
  }

  async function connect() {
    if (!(await debuggerUp())) {
      if (!browserPath) throw new ChatGptUnavailable('No Chrome or Edge found. Install Chrome, or set chrome.path in config.json.');
      mkdirSync(settings.profileDir, { recursive: true });
      markExitedCleanly();
      const child = spawn(
        browserPath,
        [
          `--remote-debugging-port=${settings.debugPort}`,
          `--user-data-dir=${settings.profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--hide-crash-restore-bubble',
          settings.url,
        ],
        { detached: true, stdio: 'ignore' },
      );
      child.on('error', (error) => log.error('Could not start Chrome', { error: error.message }));
      child.unref();
      const deadline = Date.now() + 20_000;
      while (!(await debuggerUp())) {
        if (Date.now() > deadline) {
          throw new ChatGptUnavailable(
            `Chrome did not start. If a Chrome window already uses ${settings.profileDir}, close it.`,
          );
        }
        await sleep(500);
      }
    }
    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${settings.debugPort}`,
      defaultViewport: null,
      protocolTimeout: settings.answerTimeoutMinutes * 60_000 + 60_000,
    });
    browser.on('disconnected', () => {
      connection = null;
    });
    return browser;
  }

  async function browser() {
    if (connection) {
      const current = await connection.catch(() => null);
      if (current?.connected) return current;
    }
    connection = connect();
    connection.catch(() => {
      connection = null;
    });
    return connection;
  }

  async function closeChat(page) {
    try {
      if (page.isClosed()) return;
      const others = (await (await browser()).pages()).filter((other) => other !== page);
      if (others.length > 0) await page.close();
      else await page.goto(settings.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (error) {
      log.warn('Could not close the finished ChatGPT tab', { error: error.message });
    }
  }

  async function waitFresh(page) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await page.evaluate(IN_PAGE.freshChat)) return true;
      await sleep(500);
    }
    return false;
  }

  async function fill(page, message) {
    const length = (text) => text.replace(/\s+/g, '').length;
    const expected = length(message);
    for (const how of ['insert', 'set']) {
      const got = String(await page.evaluate(IN_PAGE.fill(SELECTORS.composer, message, how)));
      if (length(got) >= expected * 0.95) return;
      await sleep(300);
    }
    throw new Error('Could not type the prompt into ChatGPT. The chatgpt.com page may have changed.');
  }

  async function send(page) {
    for (let tries = 0; tries < 30; tries += 1) {
      if (await page.evaluate(IN_PAGE.click)) return;
      await sleep(500);
    }
    await page.keyboard.press('Enter');
  }

  /** The answer's JSON-looking part: the last code block holding `{…}`, else the text after the marker. */
  function answerText(answer) {
    const block = [...answer.pres].reverse().find((text) => text.includes('{') && text.includes('}'));
    return (block ?? answer.tail).trim();
  }

  async function askIn(page, message) {
    // Not brought to the front: a new tab is already the active one in its
    // window, and focusing the window would pull the person away from an
    // application form they are filling in.
    const url = new URL(settings.url);
    if (settings.temporaryChat) url.searchParams.set('temporary-chat', 'true');
    try {
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch {
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 90_000 });
    }
    try {
      await page.waitForSelector(SELECTORS.composer, { visible: true, timeout: 30_000 });
    } catch {
      throw new ChatGptUnavailable('ChatGPT did not load. Check the Chrome window (sign in, or a "verify you are human" check).');
    }
    if (await page.evaluate(IN_PAGE.signedOut)) {
      throw new ChatGptUnavailable('ChatGPT is not signed in. Sign in on chatgpt.com in the agent\'s Chrome window.');
    }
    if (!(await waitFresh(page))) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector(SELECTORS.composer, { visible: true, timeout: 30_000 }).catch(() => undefined);
      if (!(await waitFresh(page))) throw new ChatGptUnavailable('ChatGPT did not open a new, empty chat.');
    }

    const marker = `Request ${randomUUID()}`;
    await fill(page, [message, '', marker].join('\n'));
    await send(page);

    const deadline = Date.now() + settings.answerTimeoutMinutes * 60_000;
    let started = false;
    let last = '';
    let stableSince = 0;
    while (Date.now() < deadline) {
      await sleep(1000);
      const answer = await page.evaluate(IN_PAGE.answer(marker));
      started ||= answer.streaming || answer.pres.length > 0;
      const key = JSON.stringify([answer.pres, answer.tail]);
      if (!started || answer.streaming) {
        stableSince = 0;
        last = key;
        continue;
      }
      if (key !== last || !stableSince) {
        last = key;
        stableSince = Date.now();
        continue;
      }
      if (Date.now() - stableSince >= 3000) {
        const text = answerText(answer);
        if (text) return text;
      }
    }
    throw new Error(`ChatGPT had not finished answering after ${settings.answerTimeoutMinutes} minutes.`);
  }

  /**
   * One chat at a time: a Resume being made and a form's questions take turns.
   * `first` (a form someone is looking at) goes ahead of the chats waiting.
   */
  const queue = [];
  let busy = false;

  const self = {
    /** One message in a new chat, in its own tab; returns the answer. Chats wait their turn. */
    ask(message, { first = false } = {}) {
      return new Promise((resolve, reject) => {
        const item = { message, resolve, reject };
        if (first) queue.unshift(item);
        else queue.push(item);
        pump();
      });
    },

    async askNow(message) {
      let page;
      try {
        page = await (await browser()).newPage();
      } catch (error) {
        if (error instanceof ChatGptUnavailable) throw error;
        throw new ChatGptUnavailable(`Could not open ChatGPT: ${error.message}`);
      }
      let keepOpen = false;
      try {
        return await askIn(page, message);
      } catch (error) {
        keepOpen = error instanceof ChatGptUnavailable;
        const text = `${error?.name ?? ''} ${error?.message ?? error}`;
        if (/TargetCloseError|Target closed|Session closed|detached|Connection closed/i.test(text)) {
          throw new ChatGptUnavailable('The ChatGPT window was closed while it was writing.');
        }
        throw error;
      } finally {
        if (!keepOpen && page) await closeChat(page);
      }
    },

    /** Whether ChatGPT is ready, from the open tabs only — nothing reloaded, so a sign-in is never interrupted. */
    async ready() {
      try {
        const pages = await (await browser()).pages();
        const chat = pages.find((page) => /chatgpt\.com|chat\.openai\.com/.test(page.url()));
        if (!chat) {
          if (pages.some((page) => /openai\.com|google\.com|apple\.com|live\.com/.test(page.url()))) return false;
          const page = pages[0] ?? (await (await browser()).newPage());
          await page.goto(settings.url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
          return false;
        }
        if (!(await chat.evaluate(`!!document.querySelector(${JSON.stringify(SELECTORS.composer)})`))) return false;
        return !(await chat.evaluate(IN_PAGE.signedOut));
      } catch {
        return false;
      }
    },

    /** Opens the window on chatgpt.com (for signing in during setup). */
    async open() {
      const pages = await (await browser()).pages();
      const page = pages.find((p) => /chatgpt\.com/.test(p.url())) ?? pages[0] ?? (await (await browser()).newPage());
      await page.bringToFront();
      if (!/chatgpt\.com/.test(page.url())) await page.goto(settings.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    },

    /**
     * A job's application page as a new tab in the agent's Chrome window (for
     * Apply), opened in the background so the tab in front is not taken away.
     */
    async openWindow(url) {
      const b = await browser();
      const session = await b.target().createCDPSession();
      try {
        const { targetId } = await session.send('Target.createTarget', { url, newWindow: false, background: true });
        const target = await b.waitForTarget((t) => t._targetId === targetId, { timeout: 30_000 });
        return await target.page();
      } catch {
        const page = await b.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
        return page;
      } finally {
        await session.detach().catch(() => undefined);
      }
    },

    /** The tabs open in the agent's Chrome; [] when that Chrome is not running (it is not started for this). */
    async tabs() {
      try {
        if (!connection && !(await debuggerUp())) return [];
        return await (await browser()).pages();
      } catch {
        return [];
      }
    },

    disconnect() {
      connection?.then((b) => b.disconnect()).catch(() => undefined);
    },
  };

  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    const item = queue.shift();
    self
      .askNow(item.message)
      .then(item.resolve, item.reject)
      .finally(() => {
        busy = false;
        pump();
      });
  }

  return self;
}
