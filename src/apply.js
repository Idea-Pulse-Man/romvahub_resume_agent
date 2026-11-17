import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';
import { log } from './log.js';

/**
 * Romva Apply — the desktop agent's side.
 *
 * With `apply.enabled` in config.json, it keeps a few job windows open in the
 * agent's Chrome: each one is the application page of a Draft whose Resume and
 * cover letter are made, filled in from the Profile with both files attached
 * (`apply-fill.js`, the same script the Chrome extension uses). You check each
 * window and click Submit yourself; when the page says the application was
 * sent, the window closes and the next job opens. Closing a window yourself
 * also counts as done with that job.
 *
 * Nothing is submitted, screenshotted or changed on romva.space.
 */

const FILL_SOURCE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'apply-fill.js'), 'utf8');
const HANDLED_FILE = path.join(DATA_DIR, 'apply-handled.json');
const HANDLED_DAYS = 14;
const FILL_FOR_MS = 40_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadHandled() {
  try {
    const saved = existsSync(HANDLED_FILE) ? JSON.parse(readFileSync(HANDLED_FILE, 'utf8')) : {};
    const cutoff = Date.now() - HANDLED_DAYS * 24 * 60 * 60_000;
    return Object.fromEntries(Object.entries(saved).filter(([, at]) => at >= cutoff));
  } catch {
    return {};
  }
}

export function createApplier(api, chatgpt, settings) {
  const handled = loadHandled(); // bidId → when
  const open = new Map(); // bidId → { page, data, company, filledUntil }

  function markHandled(bidId) {
    handled[bidId] = Date.now();
    try {
      writeFileSync(HANDLED_FILE, JSON.stringify(handled));
    } catch {
      // Remembered for this run at least.
    }
  }

  async function fillPage(job) {
    try {
      await job.page.evaluate(FILL_SOURCE);
      return await job.page.evaluate((data) => window.__romvaApply.fill(data), job.data);
    } catch {
      return null; // the page is navigating; the next pass fills it
    }
  }

  async function submitted(job) {
    try {
      await job.page.evaluate(FILL_SOURCE);
      return await job.page.evaluate(() => window.__romvaApply.submitted());
    } catch {
      return false;
    }
  }

  async function openNext() {
    const room = settings.tabs - open.size;
    if (room <= 0) return;
    const skip = [...Object.keys(handled), ...open.keys()].slice(-150);
    const { jobs = [] } = await api.applyNext(room, skip);
    for (const job of jobs) {
      try {
        const data = await api.applyData(job.bidId);
        const page = await chatgpt.openWindow(job.jobUrl);
        const entry = { page, data, company: job.company, filledUntil: Date.now() + FILL_FOR_MS };
        open.set(job.bidId, entry);
        // Every page this window loads (a multi-step form) is filled again.
        page.on('load', () => {
          entry.filledUntil = Date.now() + FILL_FOR_MS;
        });
        log.info(`Apply: opened ${job.company} — ${job.role}`);
      } catch (error) {
        markHandled(job.bidId);
        log.warn(`Apply: could not open ${job.company}`, { error: error.message });
      }
    }
  }

  /** One pass: close sent and closed windows, keep filling fresh ones, open more. */
  async function tick() {
    for (const [bidId, job] of open) {
      if (job.page.isClosed()) {
        open.delete(bidId);
        markHandled(bidId);
        log.info(`Apply: window closed — ${job.company}`);
        continue;
      }
      if (await submitted(job)) {
        open.delete(bidId);
        markHandled(bidId);
        log.info(`Apply: sent — ${job.company}`);
        await sleep(2500);
        await job.page.close().catch(() => undefined);
        continue;
      }
      if (Date.now() < job.filledUntil) await fillPage(job);
    }
    await openNext();
  }

  return {
    async run() {
      log.info('Apply is on: job windows open for you to check and submit', { windows: settings.tabs });
      while (true) {
        try {
          await tick();
        } catch (error) {
          log.warn('Apply: could not reach romva.space', { error: error.message });
          await sleep(30_000);
        }
        await sleep(3000);
      }
    },
  };
}
