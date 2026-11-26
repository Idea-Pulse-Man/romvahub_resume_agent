import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { keepFile } from './keep.js';
import { log } from './log.js';
import { SIGN_IN_BUTTON } from './sites.js';

/**
 * Asks an AI website — ChatGPT, Claude or Gemini (sites.js) — in a real Chrome
 * window on this computer, signed in with the person's own account: no API key.
 *
 * Chrome is started as an ordinary Chrome (chatgpt.com and Google sign-in
 * refuse a puppeteer-launched one) with its own profile folder and a DevTools
 * port, and puppeteer connects to it. Sign in to the site in that window once;
 * the profile keeps it. Each question gets its own new tab, closed when the
 * answer is in. The site's markup (sites.js) is the thing to check first if
 * this stops working.
 */

/**
 * The AI site cannot be used right now (signed out, window closed, no
 * connection…): not the application's fault. `keepTab`: leave the tab open for
 * the person (to sign in there) — not when it only shows a connection error.
 */
export class ChatUnavailable extends Error {
  constructor(message, { keepTab = true } = {}) {
    super(message);
    this.keepTab = keepTab;
  }
}

/** A Chrome network error for the site itself, in words: what to check. */
function connectionProblem(error, host) {
  const code = /net::ERR_[A-Z0-9_]+/.exec(error?.message ?? '')?.[0];
  if (!code) return null;
  const proxy = /INVALID_AUTH_CREDENTIALS|PROXY|TUNNEL|SOCKS/.test(code);
  return new ChatUnavailable(
    proxy
      ? `Could not open ${host} (${code}): a proxy in the agent's Chrome refused the connection. ` +
          `Check the proxy extension there (e.g. SmartProxy) and its password, or turn it off for ${host}.`
      : `Could not open ${host} (${code}). Check this computer's internet connection.`,
    { keepTab: false },
  );
}

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

/** How long a tab kept for signing in may sit on a sign-in page before the site is looked at directly. */
const SIGN_IN_WAIT_MS = 10 * 60_000;

// In-page code as source text, so nothing is rewritten by a bundler on the way in.
const IN_PAGE = {
  fill: (selector, toolPill, text, how) => `(() => {
    const editor = document.querySelector(${JSON.stringify(selector)});
    if (!editor) return '';
    const text = ${JSON.stringify(text)};
    const isField = editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT';
    editor.focus();
    // A tool pill (ChatGPT's Web search) stays: only what follows it is replaced.
    const pill = isField || !${JSON.stringify(toolPill)} ? null : editor.querySelector(${JSON.stringify(toolPill)});
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
  /**
   * The reply, and whether it is still being written or finished.
   *
   * The reply is the site's last reply element (sites.js replySelector), or
   * what follows its last reply heading (replyHeading: ChatGPT's "ChatGPT
   * said:") — never the question. A long question is shown folded ("Show
   * more") without its last line, the request marker; the marker is also in
   * ChatGPT's page header, above the chat, and the text after that one is the
   * whole question: its INPUT example ({"target_company": …}) was once taken
   * for the answer. So the marker is only the fallback, for a page with
   * neither (the site changed).
   *
   * Finished is the site's own sign: the Copy / Read aloud / Redo… buttons
   * under the reply. The question has its own "Copy message" / "Copy prompt",
   * and a code block its "Copy code": none of them counts.
   */
  answer: (site, marker) => `(() => {
    const replySelector = ${JSON.stringify(site.replySelector ?? null)};
    const heading = ${JSON.stringify(site.replyHeading ?? null)};
    let anchor = null;
    let headingText = '';
    if (replySelector) {
      const replies = document.querySelectorAll(replySelector);
      anchor = replies[replies.length - 1] || null;
    }
    if (!anchor && heading) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const pattern = new RegExp(heading, 'i');
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (pattern.test(node.nodeValue || '')) anchor = node;
      }
      headingText = anchor ? (anchor.nodeValue || '').trim() : '';
    }
    const inReply = (el) => !anchor || anchor === el || (anchor.contains && anchor.contains(el))
      || Boolean(anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    const pres = Array.from(document.querySelectorAll('pre')).filter(inReply).map((p) => p.innerText || '');
    let tail = '';
    if (anchor && anchor.nodeType === Node.ELEMENT_NODE) {
      tail = anchor.innerText || '';
    } else {
      const body = document.body.innerText || '';
      const marker = headingText || ${JSON.stringify(marker)};
      const at = body.lastIndexOf(marker);
      tail = at >= 0 ? body.slice(at + marker.length) : '';
    }
    const buttons = Array.from(document.querySelectorAll('button'));
    const label = (b) => ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '')).trim();
    const streamingSelector = ${JSON.stringify(site.streamingSelector ?? null)};
    const streaming = buttons.some((b) => /\\bstop\\b|stop[-_ ]?(generating|streaming|response|button)/i.test(label(b)))
      || Boolean(streamingSelector && document.querySelector(streamingSelector));
    const finished = buttons.filter(inReply).some((b) =>
      /^(copy|read aloud|more actions|redo|retry|show more options|good response|bad response|give (positive|negative) feedback)\\b/i.test(label(b))
      && !/^copy (message|code|prompt)\\b/i.test(label(b)));
    return { pres, tail, streaming, finished, reply: Boolean(anchor) };
  })()`,
  /** What the page shows, for a chat whose answer never came (kept in answers\ by agent.js). */
  state: (site, marker) => `(() => {
    const answer = ${IN_PAGE.answer(site, marker)};
    const buttons = Array.from(document.querySelectorAll('button'))
      .map((b) => (b.getAttribute('aria-label') || b.getAttribute('data-testid') || b.innerText || '').trim().slice(0, 60))
      .filter(Boolean);
    const body = document.body.innerText || '';
    return { url: location.href, ...answer, buttons: buttons.slice(-40), pageEnd: body.slice(-4000) };
  })()`,
  /**
   * Turns on the switch labelled `label` when the page shows it is off: 'on'
   * (already), 'clicked', or 'unknown' (not found, or its state cannot be
   * told: left alone rather than turned off).
   */
  toggle: (label) => `(() => {
    const wanted = ${JSON.stringify(label.toLowerCase())};
    const button = Array.from(document.querySelectorAll('button, [role="button"], .ds-toggle-button'))
      .find((el) => el.offsetParent !== null && (el.innerText || '').trim().toLowerCase() === wanted);
    if (!button) return 'unknown';
    const pressed = button.getAttribute('aria-pressed');
    const name = String(button.className || '');
    if (pressed === 'true' || name.includes('--selected')) return 'on';
    if (pressed !== 'false' && !name.includes('toggle-button')) return 'unknown';
    button.click();
    return 'clicked';
  })()`,
  /**
   * Chooses `model` and thinking `effort` in ChatGPT's model menu (sites.js
   * modelPicker): { model, effort, label } as the menu then shows them, or
   * { problem }. The menu is a Radix menu, which opens on pointerdown, not a
   * click; and the agent's tab is in the background (never brought to the
   * front), where puppeteer's mouse clicks hang — so the events are fired in
   * the page. The menu shows the effort slider; its model list is a second
   * view, switched to by the model row ("Select model"). The slider moves
   * with the arrow keys, its status reading "High, 3 of 3.".
   */
  pickModel: (trigger, model, effort) => `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async (check, ms = 3000) => {
      const end = Date.now() + ms;
      for (;;) {
        const value = check();
        if (value || Date.now() > end) return value;
        await sleep(100);
      }
    };
    const press = (el) => {
      const o = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerdown', o));
      el.dispatchEvent(new MouseEvent('mousedown', o));
      el.dispatchEvent(new PointerEvent('pointerup', o));
      el.dispatchEvent(new MouseEvent('mouseup', o));
      el.click();
    };
    const key = (el, k) => {
      el.focus();
      for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: k, code: k, bubbles: true, cancelable: true }));
    };
    const wantedModel = ${JSON.stringify(model)}.trim().toLowerCase();
    const wantedEffort = ${JSON.stringify(effort)}.trim().toLowerCase();
    const button = document.querySelector(${JSON.stringify(trigger)});
    if (!button) return { problem: 'its model menu was not found' };
    const found = () => (button.id ? document.querySelector('[role="menu"][data-state="open"][aria-labelledby="' + CSS.escape(button.id) + '"]') : null);
    const open = async () => {
      if (found()) return found();
      press(button);
      return until(found);
    };
    const name = (radio) => ((radio.querySelector('span') || radio).innerText || '').split('\\n')[0].trim();
    const radios = () => Array.from(found()?.querySelectorAll('[role="menuitemradio"]') ?? []);
    const radio = () => radios().find((r) => name(r).toLowerCase() === wantedModel);
    const selected = () => name(radios().find((r) => r.getAttribute('aria-checked') === 'true') ?? document.createElement('i'));
    const power = () => found()?.querySelector('[aria-label="Power"]');
    const level = () => {
      const p = power();
      const status = p && document.getElementById((p.getAttribute('aria-describedby') || '').split(' ')[0]);
      return ((status || found()?.querySelector('[role="status"]'))?.innerText || '').split(',')[0].trim();
    };
    const close = async () => {
      const menu = found();
      if (!menu) return;
      key(menu.contains(document.activeElement) ? document.activeElement : menu, 'Escape');
      await until(() => !found(), 2000);
    };
    if (!(await open())) return { problem: 'its model menu did not open' };
    try {
      if (wantedModel) {
        const target = radio();
        if (!target) return { problem: 'its model menu has no ' + ${JSON.stringify(model)} + ' (it has: ' + radios().map(name).join(', ') + ')' };
        if (target.getAttribute('aria-checked') !== 'true') {
          if (target.closest('[inert]')) {
            const toggle = found().querySelector('[data-model-picker-view-toggle]');
            if (toggle) press(toggle);
            await until(() => !radio()?.closest('[inert]'), 2000);
          }
          press(radio() ?? target);
          // The menu may stay open (it did) or close on the pick: then it is opened again to look.
          const picked = await until(() => radio()?.getAttribute('aria-checked') === 'true' || !found(), 3000);
          if (!picked || !((await open()) && radio()?.getAttribute('aria-checked') === 'true')) {
            const why = (radio()?.getAttribute('aria-describedby') || '').split(' ')
              .map((id) => document.getElementById(id)?.innerText).filter(Boolean).join(', ');
            return { problem: 'it did not take ' + ${JSON.stringify(model)} + (why ? ' (' + why + ')' : '') + '; it is on ' + (selected() || 'its default') };
          }
        }
      }
      if (wantedEffort) {
        if (!(await open()) || !power()) return { problem: 'its model menu has no thinking effort to choose' };
        // Right first (High is the top one), then left; each press must move the slider.
        for (const k of ['ArrowRight', 'ArrowLeft']) {
          for (let i = 0; i < 8 && level().toLowerCase() !== wantedEffort; i += 1) {
            const before = level();
            key(power(), k);
            if (!(await until(() => level() !== before, 1500))) break;
          }
          if (level().toLowerCase() === wantedEffort) break;
        }
        if (level().toLowerCase() !== wantedEffort) {
          return { problem: 'it did not take thinking effort ' + ${JSON.stringify(effort)} + '; it is on ' + (level() || 'unknown') };
        }
      }
      const label = found()?.querySelector('[data-model-selection-label]')?.getAttribute('data-model-selection-label') || '';
      const now = { model: selected(), effort: level(), label };
      if (wantedModel && now.model.toLowerCase() !== wantedModel) return { problem: 'the model went back to ' + (now.model || 'its default') };
      return now;
    } finally {
      await close();
    }
  })()`,
  click: (selector) => `(() => {
    const button = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .find((b) => b.offsetParent !== null && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    if (!button) return false;
    button.click();
    return true;
  })()`,
};

/** `settings`: config.json "chrome". `site`: one of sites.js SITES. */
export function createChat(settings, site) {
  const browserPath = settings.path || BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));
  const home = site.id === 'chatgpt' && settings.url ? settings.url : site.home;
  const isSite = (page) => site.isSite.test(page.url());
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
      if (!browserPath) throw new ChatUnavailable('No Chrome or Edge found. Install Chrome, or set chrome.path in config.json.');
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
          home,
        ],
        { detached: true, stdio: 'ignore' },
      );
      child.on('error', (error) => log.error('Could not start Chrome', { error: error.message }));
      child.unref();
      const deadline = Date.now() + 20_000;
      while (!(await debuggerUp())) {
        if (Date.now() > deadline) {
          throw new ChatUnavailable(`Chrome did not start. If a Chrome window already uses ${settings.profileDir}, close it.`);
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
   * loaded, and goto is not waited for past its timeout; whether the site is
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
          log.warn(`Chrome did not say whether ${site.host} loaded (a proxy in the way?); carrying on`, { url });
        }
        return;
      }
      failure = outcome;
    }
    if (failure?.name === 'TimeoutError') {
      throw new ChatUnavailable(`${site.host} did not load (twice). Look at the agent's Chrome window.`);
    }
    throw connectionProblem(failure, site.host) ?? failure;
  }

  async function closeChat(page) {
    try {
      if (page.isClosed()) return;
      const pages = await bounded((await browser()).pages(), 30_000, 'Listing the Chrome tabs');
      const others = pages.filter((other) => other !== page);
      if (others.length > 0) await bounded(page.close(), 30_000, 'Closing the tab');
      else await load(page, home);
    } catch (error) {
      log.warn(`Could not close the finished ${site.name} tab`, { error: error.message });
    }
  }

  /**
   * Whether `page` (a tab on the site) is signed in — the one check used both
   * before a chat and while waiting, so the two never disagree. The site's
   * own check decides (sites.js session); only when it gives no answer does
   * the page decide, and then a "Log in" / "Sign in" button must still be
   * there after a few seconds (a signed-in page shows one for a moment while
   * it loads).
   */
  async function signedIn(page) {
    const state = await page.evaluate(site.session).catch(() => 'unknown');
    if (state !== 'unknown') return state === 'in';
    const deadline = Date.now() + 8000;
    while (true) {
      const loaded = await page.evaluate(`!!document.querySelector(${JSON.stringify(site.composer)})`).catch(() => false);
      if (loaded && !(await page.evaluate(SIGN_IN_BUTTON).catch(() => true))) return true;
      if (Date.now() > deadline) return false;
      await sleep(1000);
    }
  }

  async function waitFresh(page) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await page.evaluate(site.freshChat)) return true;
      await sleep(500);
    }
    return false;
  }

  async function fill(page, message) {
    const length = (text) => text.replace(/\s+/g, '').length;
    const expected = length(message);
    for (const how of ['insert', 'set']) {
      const got = String(await page.evaluate(IN_PAGE.fill(site.composer, site.toolPill ?? null, message, how)));
      if (length(got) >= expected * 0.95) return;
      await sleep(300);
    }
    throw new Error(`Could not type the prompt into ${site.name}. The ${site.host} page may have changed.`);
  }

  async function send(page) {
    // No send button to name (DeepSeek): Enter in the message box, where the prompt was just typed.
    if (!site.send) {
      await sleep(500);
      await page.focus(site.composer);
      await page.keyboard.press('Enter');
      return;
    }
    for (let tries = 0; tries < 30; tries += 1) {
      if (await page.evaluate(IN_PAGE.click(site.send))) return;
      await sleep(500);
    }
    await page.keyboard.press('Enter');
  }

  /** The answer's JSON-looking part: the last code block holding `{…}`, else the reply's text. */
  function answerText(answer) {
    const block = [...answer.pres].reverse().find((text) => text.includes('{') && text.includes('}'));
    return (block ?? answer.tail).trim();
  }

  /** Whether `text` holds a whole JSON object (a half-written one does not parse). */
  function wholeJson(text) {
    for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
      try {
        const value = JSON.parse(candidate);
        if (value && typeof value === 'object' && !Array.isArray(value)) return true;
      } catch {
        // Next.
      }
    }
    return false;
  }

  /** Unchanged this long, with no sign of finishing either way, an answer is taken as it is. */
  const NO_SIGN_MS = 120_000;
  let warnedNoSign = false;
  let warnedNoSearch = false;

  /** Whether ChatGPT's Web search pill is in the message box (it may show a moment after the box). */
  async function searchOn(page, waitMs) {
    if (!site.searchPill) return false;
    const deadline = Date.now() + waitMs;
    while (true) {
      const on = await page.evaluate(`!!document.querySelector(${JSON.stringify(site.searchPill)})`);
      if (on || Date.now() >= deadline) return on;
      await sleep(500);
    }
  }

  const warnedModel = new Set();
  let modelSaid = '';

  /**
   * ChatGPT's model and thinking effort (config.json chrome.model, chrome.effort),
   * chosen in its model menu in each new chat: chatgpt.com puts a new chat back on
   * its default. If they cannot be chosen (the menu changed, the model is gone or
   * at its usage limit), the chat goes on with what is chosen, and the log says
   * so once for each reason.
   */
  async function chooseModel(page) {
    const model = settings.model ?? '';
    const effort = settings.effort ?? '';
    if (!site.modelPicker || (!model && !effort)) return;
    const result = await bounded(page.evaluate(IN_PAGE.pickModel(site.modelPicker, model, effort)), 30_000, 'Choosing the model')
      .catch((error) => ({ problem: error.message }));
    if (result.problem) {
      if (!warnedModel.has(result.problem)) {
        warnedModel.add(result.problem);
        log.warn(`${site.name}: could not choose ${[model, effort].filter(Boolean).join(', ')}: ${result.problem}; asking with what is chosen`);
      }
      return;
    }
    const said = `${result.model || model} · ${result.effort || effort}`;
    if (said !== modelSaid) {
      modelSaid = said;
      log.info(`${site.name}: ${said}${result.label ? ` (${result.label})` : ''}`);
    }
  }

  /** The site's message box, visible — or the site could not be used. */
  async function waitForComposer(page) {
    try {
      await page.waitForSelector(site.composer, { visible: true, timeout: 30_000 });
    } catch {
      // Sent to the site's sign-in page (claude.ai/login): signed out, not a page that did not load.
      if (site.signInPages.test(page.url())) {
        throw new ChatUnavailable(`${site.name} is not signed in. Sign in on ${site.host} in the agent's Chrome window.`);
      }
      throw new ChatUnavailable(`${site.name} did not load. Check the Chrome window (sign in, or a "verify you are human" check).`);
    }
  }

  /**
   * What the page showed, for an answer that could not be used: its reply,
   * buttons and end of page, and a screenshot, kept in answers\ (keep.js).
   * Where they were kept: { page, screenshot }.
   */
  async function keepPage(page, marker, name, label) {
    const state = await bounded(page.evaluate(IN_PAGE.state(site, marker)), 15_000, 'Reading the page')
      .catch((failed) => ({ error: failed.message }));
    const shot = await bounded(page.screenshot({ type: 'png' }), 15_000, 'Taking a screenshot').catch(() => undefined);
    return {
      page: keepFile(name, label, JSON.stringify(state, null, 2)),
      ...(shot ? { screenshot: keepFile(name, label, Buffer.from(shot), 'png') } : {}),
    };
  }

  /** `name`: what the chat is for (the company), in the names of the files keepPage keeps. */
  async function askIn(page, message, { webSearch = false, name = '' } = {}) {
    // Not brought to the front: a new tab is already the active one in its
    // window, and focusing the window would pull the person away from an
    // application form they are filling in.
    const url = site.newChatUrl(home, { temporary: settings.temporaryChat, webSearch });
    await load(page, url);
    await waitForComposer(page);
    if (!(await signedIn(page))) {
      // The site says "signed out" for a moment now and then (ChatGPT, while
      // it renews the session): most such pauses ended by themselves within a
      // minute. So it is asked once more, after a reload, before pausing.
      await sleep(5000);
      await load(page, url);
      await waitForComposer(page);
      if (!(await signedIn(page))) {
        throw new ChatUnavailable(`${site.name} is not signed in. Sign in on ${site.host} in the agent's Chrome window.`);
      }
      log.info(`${site.name} said "signed out" for a moment; it was not`);
    }
    if (!(await waitFresh(page))) {
      await load(page, url);
      await page.waitForSelector(site.composer, { visible: true, timeout: 30_000 }).catch(() => undefined);
      if (!(await waitFresh(page))) throw new ChatUnavailable(`${site.name} did not open a new, empty chat.`);
    }

    await chooseModel(page);

    let searching = false;
    if (webSearch && site.searchPill) {
      // No Web search (the site changed, or the account has none): ask without it.
      searching = await searchOn(page, 5000);
      if (!searching && !warnedNoSearch) {
        warnedNoSearch = true;
        log.warn(`${site.name} did not turn on Web search; asking without it`);
      }
    } else if (webSearch && site.webSearchNote && !warnedNoSearch) {
      warnedNoSearch = true;
      log.info(site.webSearchNote);
    }

    if (webSearch) {
      for (const label of site.toggles ?? []) {
        const state = await page.evaluate(IN_PAGE.toggle(label)).catch(() => 'unknown');
        if (state === 'unknown') log.info(`${site.name}: could not tell whether ${label} is on; left as it is`);
      }
    }

    const marker = `Request ${randomUUID()}`;
    await fill(page, [message, '', marker].join('\n'));
    if (searching && !(await searchOn(page, 1000))) log.warn('Web search was turned off while the prompt was typed');
    await send(page);

    // When is the answer finished? Not when the page has stopped changing for
    // a few seconds: a thinking model thinks and searches the web with no
    // Stop button shown and nothing changing for long stretches, and an
    // answer taken then was half an answer. Finished is the site's own sign:
    // the Copy / Read aloud / Redo… buttons under the reply. Failing that, it
    // was being written (Stop showed) and has stopped with its JSON whole;
    // failing both, nothing has changed for 2 minutes.
    const deadline = Date.now() + settings.answerTimeoutMinutes * 60_000;
    let sawStreaming = false;
    let last = '';
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      await sleep(1000);
      const answer = await page.evaluate(IN_PAGE.answer(site, marker));
      sawStreaming ||= answer.streaming;
      const key = JSON.stringify([answer.pres, answer.tail, answer.finished]);
      if (key !== last) {
        last = key;
        stableSince = Date.now();
        continue;
      }
      if (answer.streaming) continue;
      const text = answerText(answer);
      const still = Date.now() - stableSince;
      // Finished, JSON or not (a question back is reported by romva.space, and asked again).
      if (answer.finished && text && still >= 2000) {
        // Seen 2026-11-24: a finished reply whose text was only the page's
        // footer ("ChatGPT can make mistakes…") — the answer was somewhere else.
        if (!/\{[\s\S]*\}/.test(text)) {
          log.warn(`${site.name}'s reply has no JSON; kept what the page showed`, await keepPage(page, marker, name, 'no-json'));
        }
        return text;
      }
      // A site with no "finished" sign (DeepSeek): its whole JSON, left alone for a while.
      if (site.jsonDoneMs && answer.reply && still >= site.jsonDoneMs && wholeJson(text)) return text;
      if (site.refusal && still >= 15_000 && text.length < 400 && !wholeJson(text) && new RegExp(site.refusal, 'i').test(text)) {
        throw new Error(`${site.name} did not answer: ${text.slice(0, 200)}`);
      }
      // Every question asks for JSON: no braces, no answer yet.
      if (!/\{[\s\S]*\}/.test(text)) continue;
      // Only within the reply: text found by the marker may be the question's.
      if (answer.reply && sawStreaming && still >= 2000 && wholeJson(text)) return text;
      if (still >= NO_SIGN_MS && (answer.reply || answer.pres.length > 0)) {
        if (!warnedNoSign) {
          warnedNoSign = true;
          log.warn(`${site.name} showed no sign of finishing (${site.host} changed?); took the answer after 2 minutes unchanged`);
        }
        return text;
      }
    }
    const error = new Error(`${site.name} had not finished answering after ${settings.answerTimeoutMinutes} minutes.`);
    // Still thinking, an error box, a usage limit, or an answer not recognised as one: the page says which.
    error.seen = await keepPage(page, marker, name, 'unfinished');
    throw error;
  }

  /** One chat at a time: the Resume, then its cover letter. */
  const queue = [];
  let busy = false;

  /**
   * The tab left open when the site could not be used (signed out, a "verify
   * you are human" check), for the person to sign in there. Only one: an
   * earlier one is closed when a new one is kept, so tabs do not pile up.
   */
  let signInTab = null;
  let signInSince = 0;
  async function keepForSignIn(page) {
    if (signInTab && signInTab !== page && !signInTab.isClosed()) {
      await bounded(signInTab.close(), 30_000, 'Closing the tab').catch(() => undefined);
    }
    signInTab = page;
    signInSince = Date.now();
  }

  /** A tab of ours for looking at the site between chats, reused so tabs do not pile up. */
  let checkTab = null;

  const self = {
    site,

    /**
     * One message in a new chat, in its own tab; returns the answer. Chats wait their turn.
     * `webSearch`: the chat starts with the site's web search on, where the agent can choose it (ChatGPT).
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
        if (error instanceof ChatUnavailable) throw error;
        throw new ChatUnavailable(`Could not open ${site.name}: ${error.message}`);
      }
      // Last resort: whatever step stops answering, the chat gives up in the end
      // (the tab is closed) — the application is never held at "Making…" for good.
      const limitMinutes = settings.answerTimeoutMinutes + 10;
      let keepOpen = false;
      try {
        const asking = askIn(page, message, options);
        asking.catch(() => undefined); // still running when given up on
        return await within(asking, limitMinutes * 60_000, () => {
          throw new ChatUnavailable(
            `${site.name} got stuck: no answer after ${limitMinutes} minutes. Look at the agent's Chrome window.`,
            { keepTab: false },
          );
        });
      } catch (error) {
        keepOpen = error instanceof ChatUnavailable && error.keepTab;
        const text = `${error?.name ?? ''} ${error?.message ?? error}`;
        if (/TargetCloseError|Target closed|Session closed|detached|Connection closed/i.test(text)) {
          throw new ChatUnavailable(`The ${site.name} window was closed while it was writing.`);
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
     * Whether the site is ready (signed in) — the same check as before a
     * chat. A tab the person is signing in on is left alone, but only while
     * it is on a sign-in page, and for 10 minutes at most: the agent once
     * waited hours on a tab left on a login or error page while the site was
     * signed in all along (a restart was the only way out).
     */
    async ready() {
      try {
        const pages = await bounded((await browser()).pages(), 30_000, 'Listing the Chrome tabs');
        let kept = signInTab && !signInTab.isClosed() ? signInTab : null;
        if (kept && !isSite(kept)) {
          if (site.signInPages.test(kept.url()) && Date.now() - signInSince < SIGN_IN_WAIT_MS) return false;
          // An error page, a blank tab, or a sign-in left for 10 minutes: look at the site itself.
          if (!site.signInPages.test(kept.url())) await bounded(kept.close(), 30_000, 'Closing the tab').catch(() => undefined);
          signInTab = null;
          kept = null;
        }
        let tab = kept ?? pages.find((page) => isSite(page) && !page.isClosed());
        if (!tab) {
          if (!checkTab || checkTab.isClosed()) {
            checkTab = pages.find((page) => page.url() === 'about:blank')
              ?? (await bounded((await browser()).newPage(), 60_000, 'Opening a new tab'));
          }
          await load(checkTab, home);
          tab = checkTab;
        }
        let ok = await signedIn(tab);
        if (!ok && site.recheckByReload && tab !== kept) {
          // The page itself decides (Gemini): read it afresh.
          await load(tab, home).catch(() => undefined);
          ok = await signedIn(tab);
        }
        if (!ok) return false;
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

    /** Opens the window on the site, in front (for signing in). */
    async open() {
      const pages = await (await browser()).pages();
      const page = pages.find(isSite) ?? pages[0] ?? (await (await browser()).newPage());
      await page.bringToFront();
      if (!isSite(page)) await load(page, home);
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
