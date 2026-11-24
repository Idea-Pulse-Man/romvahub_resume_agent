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

/**
 * ChatGPT itself cannot be used right now (signed out, window closed, no
 * connection…): not the application's fault. `keepTab`: leave the tab open for
 * the person (to sign in there) — not when it only shows a connection error.
 */
export class ChatGptUnavailable extends Error {
  constructor(message, { keepTab = true } = {}) {
    super(message);
    this.keepTab = keepTab;
  }
}

/** A Chrome network error for chatgpt.com itself, in words: what to check. */
function connectionProblem(error) {
  const code = /net::ERR_[A-Z0-9_]+/.exec(error?.message ?? '')?.[0];
  if (!code) return null;
  const proxy = /INVALID_AUTH_CREDENTIALS|PROXY|TUNNEL|SOCKS/.test(code);
  return new ChatGptUnavailable(
    proxy
      ? `Could not open chatgpt.com (${code}): a proxy in the agent's Chrome refused the connection. ` +
          "Check the proxy extension there (e.g. SmartProxy) and its password, or turn it off for chatgpt.com."
      : `Could not open chatgpt.com (${code}). Check this computer's internet connection.`,
    { keepTab: false },
  );
}

const SELECTORS = {
  composer: '#prompt-textarea, textarea[name="prompt"], #mobile-composer-prompt, [contenteditable="true"][role="textbox"]',
  /**
   * A tool chosen for the chat before it is sent: chatgpt.com puts it at the
   * start of the message box as a pill ("Web search", from ?hints=search).
   */
  toolPill: '[data-system-hint-type]',
  searchPill: '[data-system-hint-type="search"]',
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

/** `promise`, or `onTimeout()`'s value after `ms` — whichever comes first. The timer never outlives it. */
function within(promise, ms, onTimeout) {
  let timer;
  const late = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (error) {
        reject(error);
      }
    }, ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A step that may hang (closing a tab, listing tabs): an error after `ms` instead. */
function bounded(promise, ms, what) {
  promise.catch(() => undefined); // given up on: never an unhandled rejection later
  return within(promise, ms, () => {
    throw new Error(`${what} took longer than ${Math.round(ms / 1000)} s`);
  });
}

// In-page code as source text, so nothing is rewritten by a bundler on the way in.
const IN_PAGE = {
  fill: (selector, text, how) => `(() => {
    const editor = document.querySelector(${JSON.stringify(selector)});
    if (!editor) return '';
    const text = ${JSON.stringify(text)};
    const isField = editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT';
    editor.focus();
    // A tool pill (Web search) stays: only what follows it is replaced.
    const pill = isField ? null : editor.querySelector(${JSON.stringify(SELECTORS.toolPill)});
    if (isField) {
      editor.select();
      document.execCommand('delete');
    } else if (pill) {
      const after = document.createRange();
      after.setStartAfter(pill);
      after.setEnd(editor, editor.childNodes.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(after);
      // Nothing typed yet: no delete, which would take the pill with it.
      if (after.toString().trim()) document.execCommand('delete');
      else selection.collapseToEnd();
    } else {
      document.execCommand('selectAll');
      document.execCommand('delete');
    }
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
  /**
   * The sign-in as chatgpt.com's own session endpoint has it, fetched fresh:
   * 'in', 'out', or 'unknown' when it does not answer as expected. Unlike the
   * page's buttons, it is right even on a tab still loading (which shows
   * "Log in" for a moment) or one open since before a sign-out.
   */
  session: `(async () => {
    try {
      const response = await fetch('/api/auth/session', {
        credentials: 'include',
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) return 'unknown';
      const session = await response.json();
      if (!session || typeof session !== 'object') return 'unknown';
      if (session.user || session.accessToken) return 'in';
      return Object.keys(session).length === 0 ? 'out' : 'unknown';
    } catch {
      return 'unknown';
    }
  })()`,
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

  let warnedNoAnswer = false;

  /**
   * Opens `url` in `page`. page.goto has a timeout, but once the page has
   * loaded it may still wait — with no timeout at all — for Chrome to report
   * the page's response. That report never comes when a proxy asks for a
   * password on the way (an extension such as SmartProxy), and the agent sat
   * at "Making…" for good. So the page's own DOMContentLoaded also counts as
   * loaded, and goto is not waited for past its timeout; whether ChatGPT is
   * really there is checked right after (its message box).
   */
  async function load(page, url) {
    const origin = new URL(url).origin;
    let failure;
    for (const timeout of [60_000, 90_000]) {
      let onLoaded;
      const loaded = new Promise((resolve) => {
        onLoaded = () => {
          if (page.url().startsWith(origin)) resolve('loaded');
        };
        page.on('domcontentloaded', onLoaded);
      });
      const going = page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      going.catch(() => undefined); // may still be pending when given up on
      const outcome = await within(
        Promise.race([going.then(() => 'loaded', (error) => error), loaded]),
        timeout + 15_000,
        () => 'no answer',
      );
      page.off('domcontentloaded', onLoaded);
      if (outcome === 'loaded') return;
      if (outcome === 'no answer') {
        if (!warnedNoAnswer) {
          warnedNoAnswer = true;
          log.warn('Chrome did not say whether chatgpt.com loaded (a proxy in the way?); carrying on', { url });
        }
        return;
      }
      failure = outcome;
    }
    if (failure?.name === 'TimeoutError') {
      throw new ChatGptUnavailable("chatgpt.com did not load (twice). Look at the agent's Chrome window.");
    }
    throw connectionProblem(failure) ?? failure;
  }

  async function closeChat(page) {
    try {
      if (page.isClosed()) return;
      const pages = await bounded((await browser()).pages(), 30_000, 'Listing the Chrome tabs');
      const others = pages.filter((other) => other !== page);
      if (others.length > 0) await bounded(page.close(), 30_000, 'Closing the tab');
      else await load(page, settings.url);
    } catch (error) {
      log.warn('Could not close the finished ChatGPT tab', { error: error.message });
    }
  }

  /**
   * Whether `page` (a chatgpt.com tab) is signed in — the one check used both
   * before a chat and while waiting, so the two never disagree. The session
   * endpoint decides; only when it gives no answer does the page decide, and
   * then a "Log in" button must still be there after a few seconds (a
   * signed-in page shows one for a moment while it loads).
   */
  async function signedIn(page) {
    const state = await page.evaluate(IN_PAGE.session).catch(() => 'unknown');
    if (state !== 'unknown') return state === 'in';
    const deadline = Date.now() + 8000;
    while (true) {
      const loaded = await page.evaluate(`!!document.querySelector(${JSON.stringify(SELECTORS.composer)})`);
      if (loaded && !(await page.evaluate(IN_PAGE.signedOut))) return true;
      if (Date.now() > deadline) return false;
      await sleep(1000);
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

  let warnedNoSearch = false;

  /** Whether the Web search pill is in the message box (it may show a moment after the box). */
  async function searchOn(page, waitMs) {
    const deadline = Date.now() + waitMs;
    while (true) {
      const on = await page.evaluate(`!!document.querySelector(${JSON.stringify(SELECTORS.searchPill)})`);
      if (on || Date.now() >= deadline) return on;
      await sleep(500);
    }
  }

  async function askIn(page, message, { webSearch = false } = {}) {
    // Not brought to the front: a new tab is already the active one in its
    // window, and focusing the window would pull the person away from an
    // application form they are filling in.
    const url = new URL(settings.url);
    if (settings.temporaryChat) url.searchParams.set('temporary-chat', 'true');
    // chatgpt.com's own link for a new chat with Web search already chosen.
    if (webSearch) url.searchParams.set('hints', 'search');
    await load(page, url.toString());
    try {
      await page.waitForSelector(SELECTORS.composer, { visible: true, timeout: 30_000 });
    } catch {
      throw new ChatGptUnavailable('ChatGPT did not load. Check the Chrome window (sign in, or a "verify you are human" check).');
    }
    if (!(await signedIn(page))) {
      throw new ChatGptUnavailable('ChatGPT is not signed in. Sign in on chatgpt.com in the agent\'s Chrome window.');
    }
    if (!(await waitFresh(page))) {
      await load(page, url.toString());
      await page.waitForSelector(SELECTORS.composer, { visible: true, timeout: 30_000 }).catch(() => undefined);
      if (!(await waitFresh(page))) throw new ChatGptUnavailable('ChatGPT did not open a new, empty chat.');
    }

    // No Web search (chatgpt.com changed, or the account has none): ask without it.
    const searching = webSearch && (await searchOn(page, 5000));
    if (webSearch && !searching && !warnedNoSearch) {
      warnedNoSearch = true;
      log.warn('ChatGPT did not turn on Web search; asking without it');
    }

    const marker = `Request ${randomUUID()}`;
    await fill(page, [message, '', marker].join('\n'));
    if (searching && !(await searchOn(page, 1000))) log.warn('Web search was turned off while the prompt was typed');
    await send(page);

    const deadline = Date.now() + settings.answerTimeoutMinutes * 60_000;
    let started = false;
    let sawStreaming = false;
    let last = '';
    let stableSince = 0;
    while (Date.now() < deadline) {
      await sleep(1000);
      const answer = await page.evaluate(IN_PAGE.answer(marker));
      sawStreaming ||= answer.streaming;
      // Every question asks for JSON, so braces after the request marker mean
      // the answer has begun — even one in plain text (no code block) while
      // chatgpt.com's Stop button is not recognised.
      started ||= answer.streaming || answer.pres.length > 0 || /\{[\s\S]*\}/.test(answer.tail);
      // Without the Stop button to say it is still writing, a pause in the
      // writing must last longer before the answer is taken as finished.
      const settleMs = sawStreaming ? 3000 : 10_000;
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
      if (Date.now() - stableSince >= settleMs) {
        const text = answerText(answer);
        if (text) return text;
      }
    }
    throw new Error(`ChatGPT had not finished answering after ${settings.answerTimeoutMinutes} minutes.`);
  }

  /** One chat at a time: the Resume, then its cover letter. */
  const queue = [];
  let busy = false;

  /**
   * The tab left open when ChatGPT could not be used (signed out, a "verify
   * you are human" check), for the person to sign in there. Only one: an
   * earlier one is closed when a new one is kept, so tabs do not pile up.
   */
  let signInTab = null;
  async function keepForSignIn(page) {
    if (signInTab && signInTab !== page && !signInTab.isClosed()) {
      await bounded(signInTab.close(), 30_000, 'Closing the tab').catch(() => undefined);
    }
    signInTab = page;
  }

  const self = {
    /**
     * One message in a new chat, in its own tab; returns the answer. Chats wait their turn.
     * `webSearch`: the chat starts with ChatGPT's Web search turned on.
     */
    ask(message, options = {}) {
      return new Promise((resolve, reject) => {
        queue.push({ message, options, resolve, reject });
        pump();
      });
    },

    async askNow(message, options = {}) {
      let page;
      try {
        const opening = (await browser()).newPage();
        page = await bounded(opening, 60_000, 'Opening a new tab').catch((error) => {
          opening.then((late) => late.close()).catch(() => undefined); // if it opens after all
          throw error;
        });
      } catch (error) {
        if (error instanceof ChatGptUnavailable) throw error;
        throw new ChatGptUnavailable(`Could not open ChatGPT: ${error.message}`);
      }
      // Last resort: whatever step stops answering, the chat gives up in the end
      // (the tab is closed) — the application is never held at "Making…" for good.
      const limitMinutes = settings.answerTimeoutMinutes + 10;
      let keepOpen = false;
      try {
        const asking = askIn(page, message, options);
        asking.catch(() => undefined); // still running when given up on
        return await within(asking, limitMinutes * 60_000, () => {
          throw new ChatGptUnavailable(
            `ChatGPT got stuck: no answer after ${limitMinutes} minutes. Look at the agent's Chrome window.`,
            { keepTab: false },
          );
        });
      } catch (error) {
        keepOpen = error instanceof ChatGptUnavailable && error.keepTab;
        const text = `${error?.name ?? ''} ${error?.message ?? error}`;
        if (/TargetCloseError|Target closed|Session closed|detached|Connection closed/i.test(text)) {
          throw new ChatGptUnavailable('The ChatGPT window was closed while it was writing.');
        }
        throw error;
      } finally {
        if (page) {
          if (keepOpen) await keepForSignIn(page);
          else await closeChat(page);
        }
      }
    },

    /**
     * Whether ChatGPT is ready — the same check as before a chat, on the tab
     * kept for signing in (else any chatgpt.com tab). Nothing is reloaded, so
     * a sign-in in progress is never interrupted.
     */
    async ready() {
      try {
        const pages = await bounded((await browser()).pages(), 30_000, 'Listing the Chrome tabs');
        const isChat = (page) => /chatgpt\.com|chat\.openai\.com/.test(page.url());
        const kept = signInTab && !signInTab.isClosed() ? signInTab : null;
        // The person is signing in on the kept tab (it has left chatgpt.com): wait.
        if (kept && !isChat(kept)) return false;
        const chat = kept ?? pages.find(isChat);
        if (!chat) {
          if (pages.some((page) => /openai\.com|google\.com|apple\.com|live\.com/.test(page.url()))) return false;
          const page = pages[0] ?? (await bounded((await browser()).newPage(), 60_000, 'Opening a new tab'));
          await load(page, settings.url).catch(() => undefined);
          return false;
        }
        if (!(await signedIn(chat))) return false;
        // Signed in: the kept tab has done its job.
        if (kept) {
          signInTab = null;
          await closeChat(kept);
        }
        return true;
      } catch {
        return false;
      }
    },

    /** Opens the window on chatgpt.com (for signing in during setup). */
    async open() {
      const pages = await (await browser()).pages();
      const page = pages.find((p) => /chatgpt\.com/.test(p.url())) ?? pages[0] ?? (await (await browser()).newPage());
      await page.bringToFront();
      if (!/chatgpt\.com/.test(page.url())) await load(page, settings.url);
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
      .askNow(item.message, item.options)
      .then(item.resolve, item.reject)
      .finally(() => {
        busy = false;
        pump();
      });
  }

  return self;
}
