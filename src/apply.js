import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';
import { log } from './log.js';

/**
 * Romva Apply — the desktop agent's side.
 *
 * With `apply.enabled` in config.json (this computer may apply) and **Start
 * apply** pressed on romva.space, it keeps a few job tabs open in the agent's
 * Chrome: each one is the application page of a Draft whose Resume and
 * cover letter are made, filled in from the Profile with both files attached
 * (`apply-fill.js`). You check each tab and click Submit yourself; when the
 * page says the application was sent, the tab closes and the next job opens.
 * Closing a tab yourself also counts as done with that job.
 *
 * Every question the form still has open — text boxes, drop-downs, radios,
 * tick boxes, Yes/No buttons — is answered by ChatGPT, from the job post and
 * the Resume, a few seconds after each page of the form loads. A question
 * offering "I don't wish to answer" gets that option. A field the person has
 * filled is left alone; a question ChatGPT cannot answer is left empty.
 *
 * A job whose page wants a sign-in or a new account (a password box, or a
 * page with no form that says "Sign in") is skipped: nothing is typed, the
 * tab stays open, and the next job opens. Sign in there yourself, go to the
 * application form, and press Alt+V: the agent fills that tab in for the
 * job. The key works in any tab of the agent's Chrome: a tab it did not open
 * is matched to its job from the page (the company in the address or on the
 * page) and filled at once; only when that is not clear does the banner ask
 * which job it is, and nothing is touched until you choose.
 *
 * Fixed answers: no relocation, no sponsorship; a U.S. citizen, not a
 * student, primary language English (no secondary language); salary the middle of the
 * posted range (150000 when none); "how did you hear" Jobright AI or a job
 * board; a referrer's name never written.
 *
 * Stop on romva.space: no new tabs are opened; the ones open stay, and are
 * still filled and watched until you submit or close them. The key works
 * either way.
 *
 * Nothing is submitted, screenshotted or changed on romva.space.
 */

const FILL_SOURCE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'apply-fill.js'), 'utf8');
const HANDLED_FILE = path.join(DATA_DIR, 'apply-handled.json');
/** Jobs skipped for a sign-in, kept so the key can still fill them after the agent restarts. */
const PARKED_FILE = path.join(DATA_DIR, 'apply-parked.json');
const HANDLED_DAYS = 14;
const FILL_FOR_MS = 40_000;
/** How often the Start apply / Stop switch on romva.space is looked at. */
const SWITCH_EVERY_MS = 10_000;
/** How long after a page loads its open questions are read (the form renders first). */
const QUESTIONS_AFTER_MS = 6_000;
/** How long a page may take to show its form before "Sign in" on it means it wants a sign-in. */
const SIGN_IN_AFTER_MS = 10_000;
const HOTKEY = 'Alt+V';
const HOTKEY_EVERY_MS = 800;
/** At most this many questions in one ChatGPT message; the rest go in the next. */
const QUESTIONS_PER_ASK = 40;

/** Frames that never hold the form: captchas, trackers, videos, payments. */
const SKIP_FRAME = /recaptcha|hcaptcha|challenges\.cloudflare|turnstile|doubleclick|googletagmanager|google-analytics|facebook\.com|youtube\.com|vimeo\.com|stripe\.com/i;
/** Tabs the key never fills: ChatGPT, romva.space. */
const NOT_A_FORM = /chatgpt\.com|chat\.openai\.com|romva\.space/i;

/** In-page: watches for the key (installed once per page load) and reports it, and a banner choice, once. */
const KEY_PROBE = `(() => {
  let keys = window.__romvaKeys;
  if (!keys) {
    keys = window.__romvaKeys = { pressed: false };
    addEventListener('keydown', (event) => {
      // Alt+V only: not Ctrl+Alt (AltGr on some keyboards types characters with it).
      if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey && event.code === 'KeyV') {
        keys.pressed = true;
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
  }
  const pressed = keys.pressed;
  keys.pressed = false;
  const picked = window.__romvaApply && window.__romvaApply.takePick ? window.__romvaApply.takePick() : null;
  return { pressed, picked };
})()`;

function questionsPrompt(job, questions, pageText) {
  const a = job.data.applicant ?? {};
  const lines = questions.flatMap((q) => {
    const notes = [q.required ? 'required' : 'optional'];
    if (q.kind === 'text') {
      notes.push(q.multiline ? 'text box' : 'one line');
      if (q.maxLength) notes.push(`at most ${q.maxLength} characters`);
    }
    if (q.kind === 'one') notes.push('pick one option');
    if (q.kind === 'many') notes.push('pick every option that applies, as a list');
    if (q.kind === 'tick') notes.push('a tick box: "Yes" ticks it, "No" leaves it empty');
    const out = [`- id "${q.id}" (${notes.join(', ')}): ${q.question}`];
    if (q.options?.length) out.push(`  options: ${q.options.map((o) => JSON.stringify(o)).join(' | ')}`);
    return out;
  });
  const details = [
    a.fullName,
    [a.currentTitle, a.currentCompany].filter(Boolean).join(' at '),
    a.location && `based in ${a.location}`,
    a.noticePeriod && `notice period: ${a.noticePeriod}`,
    'U.S. citizen',
    'not a student',
    'primary language: English',
    'does not want to relocate (move) for work',
  ].filter(Boolean);
  return [
    `You are filling in a job application form for the applicant below, who is applying to "${job.data.role}" at ${job.data.company}.`,
    'Answer every question as the applicant, from their Resume and from the job post (what the company does, the role, the work).',
    '',
    'Text answers:',
    '- Simple and plain, like a real person typing it quickly: first person, short sentences, everyday words.',
    '- Specific: name real things from the Resume (projects, tools, results) and from the job post. No buzzwords or filler ("passionate", "thrilled", "leverage", "excited to", "synergy"), no em dashes, no markdown, no headings.',
    '- A text box gets 2 to 4 sentences; when the question asks for bullet points, 2 to 4 short lines each starting with "- ". A one-line field gets a few words or a number.',
    '',
    'Choices:',
    '- Answer with the exact text of an option, copied from its list; for "pick every option that applies", a JSON list of option texts.',
    `- If the options include one like "I don't wish to answer", "Decline to self-identify" or "Prefer not to say", choose that one.`,
    '- The applicant is authorised to work and never needs visa sponsorship.',
    '- The applicant does not want to relocate: answer "No" to relocating or moving for the job.',
    '- The applicant is a U.S. citizen (citizenship: "U.S. Citizen"; country of citizenship: United States), is not a student (full-time or part-time: "No"), and their primary language is English. Leave a secondary or other language empty.',
    '- "How did you hear about us": "Jobright AI" if offered, else a job board option; as text, write "Jobright AI".',
    '- Were you referred by someone: "No".',
    '- Yes/no questions about skills or experience: answer truthfully from the Resume.',
    '- Tick boxes: "Yes" to confirm the information is true or to accept the privacy notice or terms needed to apply; "No" to newsletters, marketing and job alerts.',
    '',
    'Salary / compensation expectations: if the job post or the application page gives a pay range for this role, answer the middle of it (for $120,000 to $180,000, answer 150000); if it gives none, answer 150000. Write a plain number with no "$" or commas, unless the field asks for a range or text; for a choice, pick the option that contains that number.',
    '',
    "Nobody referred the applicant. Never write a referrer's name or email: answer those with an empty string, or \"N/A\" when the question says to type N/A if not referred. If any other question needs a fact that is not in the Resume or the details below (a reference, an ID number, a date), or you are not sure, answer with an empty string too: the applicant fills it in.",
    '',
    'Reply with only this JSON, in one code block, with an answer for every id:',
    '{"answers":[{"id":"<id>","answer":"<text, or a list of option texts>"}]}',
    '',
    'Questions:',
    ...lines,
    '',
    `Applicant: ${details.join('; ')}.`,
    '',
    'Job post:',
    (job.data.jobDescription || '(not saved; see the application page below)').slice(0, 12_000),
    '',
    'The application page (company details, pay range):',
    (pageText || '(not available)').slice(0, 8_000),
    '',
    'Resume (JSON):',
    (job.data.resumeText || '(not available)').slice(0, 12_000),
  ].join('\n');
}

function parseAnswers(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('ChatGPT did not answer with JSON.');
  const parsed = JSON.parse(text.slice(start, end + 1));
  return Array.isArray(parsed?.answers) ? parsed.answers : [];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The promise, or a rejection after `ms` (a page with a dialog open never answers). */
function within(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The page did not answer in time.')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A tab's id in Chrome: the same across reloads, navigations and agent restarts. */
const tabId = (page) => page.target()._targetId;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const norm = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const compact = (text) => norm(text).replace(/[^a-z0-9]/g, '');

/** A company name as it shows on its pages: "Honest Health, Inc." → "honest health". */
function companyKey(name) {
  return norm(name)
    .replace(/[,.()&']/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|the|group|holdings|plc|gmbh|technologies|labs)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The jobs a page is for, from what is on it: the company in the site's
 * address (3 points), the company named on the page (2), the role named on
 * it (1). Only the best-scoring jobs, and only when the company was found.
 */
function matchPage(jobs, url, info) {
  const host = hostOf(url);
  const labels = host.split(/[.-]/);
  const text = norm(`${info.title} ${info.text}`);
  const words = (phrase) => new RegExp(`(^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text);
  const scored = jobs
    .map((job) => {
      const key = companyKey(job.company);
      const tight = compact(key);
      if (tight.length < 3) return { job, score: 0 };
      let score = 0;
      if (labels.includes(tight) || (tight.length >= 5 && compact(host).includes(tight))) score += 3;
      if (words(key)) score += 2;
      if (score && job.role && text.includes(norm(job.role))) score += 1;
      return { job, score };
    })
    .filter((s) => s.score >= 2);
  if (!scored.length) return [];
  const best = Math.max(...scored.map((s) => s.score));
  return scored.filter((s) => s.score === best).map((s) => s.job);
}

function loadHandled() {
  try {
    const saved = existsSync(HANDLED_FILE) ? JSON.parse(readFileSync(HANDLED_FILE, 'utf8')) : {};
    const cutoff = Date.now() - HANDLED_DAYS * 24 * 60 * 60_000;
    return Object.fromEntries(Object.entries(saved).filter(([, at]) => at >= cutoff));
  } catch {
    return {};
  }
}

function loadParked() {
  try {
    const saved = existsSync(PARKED_FILE) ? JSON.parse(readFileSync(PARKED_FILE, 'utf8')) : [];
    const cutoff = Date.now() - HANDLED_DAYS * 24 * 60 * 60_000;
    return (Array.isArray(saved) ? saved : []).filter((job) => job?.bidId && job.at >= cutoff);
  } catch {
    return [];
  }
}

/** Runs `fn` in a frame, with apply-fill.js put there first. */
async function inFrame(frame, fn, arg, ms = 10_000) {
  if (!(await within(frame.evaluate('!!window.__romvaApply'), 3000))) await within(frame.evaluate(FILL_SOURCE), 5000);
  return within(arg === undefined ? frame.evaluate(fn) : frame.evaluate(fn, arg), ms);
}

/**
 * The frames of a tab that may hold the form, each with what is on it: the
 * page itself, and any frame with an application form, a sign-in box or a
 * "sent" message (Greenhouse and others embed the form in a frame).
 */
async function formFrames(page) {
  const main = page.mainFrame();
  const found = await Promise.all(
    page.frames().map(async (frame) => {
      if (frame !== main && (!/^https?:/i.test(frame.url()) || SKIP_FRAME.test(frame.url()))) return null;
      try {
        const state = await inFrame(frame, () => window.__romvaApply.state(), undefined, 4000);
        if (frame !== main && !(state.application || state.password || state.sent)) return null;
        return { frame, main: frame === main, state };
      } catch {
        return null; // navigating, or gone
      }
    }),
  );
  return found.filter(Boolean);
}

/** Where to fill: the frames with an application form, else (a short form) any frame with fields. */
function fillTargets(frames) {
  const forms = frames.filter((f) => f.state.application);
  return forms.length ? forms : frames.filter((f) => f.state.fields > 0);
}

export function createApplier(api, chatgpt, settings) {
  const handled = loadHandled(); // bidId → when
  const open = new Map(); // bidId → job (see newJob)
  /** Skipped for a sign-in, waiting for the key: bidId → job (its page is null after a restart). */
  const parked = new Map(loadParked().map((job) => [job.bidId, { ...job, page: null, data: null }]));
  /** Jobs offered in a banner's "which job is this?" list: bidId → job. */
  const offered = new Map();
  const busyTabs = new Set();
  /** The Start apply switch as last seen (null: not yet looked), and when. */
  let switchOn = null;
  let switchSeenAt = 0;

  /** Whether Start apply is on, from romva.space at most every few seconds. */
  async function applyOn() {
    if (Date.now() - switchSeenAt < SWITCH_EVERY_MS && switchOn !== null) return switchOn;
    const { applyEnabled } = await api.status();
    switchSeenAt = Date.now();
    // A romva.space from before the Start apply button has no switch: apply, as before.
    const on = applyEnabled === undefined ? true : applyEnabled === true;
    if (on !== switchOn) {
      log.info(on ? 'Apply started on romva.space: opening job tabs' : 'Apply is at Stop on romva.space; waiting for Start apply');
    }
    switchOn = on;
    return on;
  }

  function markHandled(bidId) {
    handled[bidId] = Date.now();
    try {
      writeFileSync(HANDLED_FILE, JSON.stringify(handled));
    } catch {
      // Remembered for this run at least.
    }
  }

  function saveParked() {
    try {
      const list = [...parked.values()].map(({ bidId, company, role, jobUrl, tab, at }) => ({ bidId, company, role, jobUrl, tab, at }));
      writeFileSync(PARKED_FILE, JSON.stringify(list));
    } catch {
      // Remembered for this run at least.
    }
  }

  /** Every page the tab loads (a multi-step form) is filled again, and its questions answered. */
  function watchLoads(job, page) {
    if (job.watching === page) return;
    job.watching = page;
    page.on('load', () => {
      if (job.page !== page) return;
      job.filledUntil = Date.now() + FILL_FOR_MS;
      job.loadedAt = Date.now();
    });
  }

  /** A note in the tab's banner (and buttons to choose from). */
  async function notice(page, text, choices = []) {
    try {
      await inFrame(page.mainFrame(), (args) => window.__romvaApply.notice(args.text, args.choices), { text, choices }, 4000);
    } catch {
      // The page is navigating; the note is not needed there.
    }
  }

  async function openNext() {
    const room = settings.tabs - open.size;
    if (room <= 0) return;
    const skip = [...Object.keys(handled), ...open.keys()].slice(-150);
    const { jobs = [] } = await api.applyNext(room, skip);
    for (const next of jobs) {
      try {
        const data = await api.applyData(next.bidId);
        const page = await chatgpt.openWindow(next.jobUrl);
        const job = {
          bidId: next.bidId,
          company: next.company,
          role: next.role,
          jobUrl: next.jobUrl,
          data,
          page,
          tab: tabId(page),
          at: Date.now(),
          filledUntil: Date.now() + FILL_FOR_MS,
          loadedAt: Date.now(),
          asked: new Set(), // questions already sent to ChatGPT
          asking: false,
          askAfter: 0,
          formSeen: false, // the application form has shown (not a sign-in page)
          manual: false, // filled because the person pressed the key: never skipped
        };
        watchLoads(job, page);
        open.set(job.bidId, job);
        log.info(`Apply: opened ${job.company} — ${job.role}`);
      } catch (error) {
        markHandled(next.bidId);
        log.warn(`Apply: could not open ${next.company}`, { error: error.message });
      }
    }
  }

  /** A sign-in or sign-up page: the job is skipped, its tab left open as it is, for the key. */
  async function park(job) {
    open.delete(job.bidId);
    markHandled(job.bidId);
    job.at = Date.now();
    parked.set(job.bidId, job);
    saveParked();
    await notice(
      job.page,
      `This job needs you to sign in or create an account, so Romva skipped it and left this tab for you. Sign in, go to the application form, then press ${HOTKEY} and Romva fills it in.`,
    );
    log.info(`Apply: sign-in needed — skipped ${job.company}; the tab stays open (${HOTKEY} fills it once you are on the form)`);
  }

  /** Fills `page` in for `job` from now on: the key was pressed there (or the job chosen in its banner). */
  async function start(job, page) {
    if (!job.data) {
      try {
        job.data = await api.applyData(job.bidId);
      } catch (error) {
        await notice(page, `Romva could not load ${job.company} from romva.space (${error.message}). Nothing was touched; press ${HOTKEY} to try again.`);
        return;
      }
    }
    if (parked.delete(job.bidId)) saveParked();
    offered.delete(job.bidId);
    job.page = page;
    job.tab = tabId(page);
    job.manual = true;
    job.formSeen = true;
    job.filledUntil = Date.now() + FILL_FOR_MS;
    job.loadedAt = Date.now() - QUESTIONS_AFTER_MS + 1500; // questions right after the first fill
    job.asked = new Set();
    job.askAfter = 0;
    job.signInNoted = null;
    watchLoads(job, page);
    open.set(job.bidId, job);
    await notice(page, `Filling this in for ${job.company} — ${job.role}. ChatGPT answers the questions in a moment.`);
    log.info(`Apply: ${HOTKEY} — filling ${job.company} — ${job.role}`);
  }

  /** The key, pressed in `page`: fill it for its job, or ask which job it is. */
  async function onHotkey(page) {
    const id = tabId(page);
    if (busyTabs.has(id)) return;
    busyTabs.add(id);
    try {
      const active = [...open.values()].find((job) => job.tab === id);
      if (active) return await start(active, page);

      const waiting = [...parked.values()];
      const openerId = page.target().opener()?._targetId;
      const host = hostOf(page.url());
      const sameSite = waiting.filter((job) => host && hostOf(job.jobUrl) === host);
      const job =
        waiting.find((j) => j.tab === id) ??
        (openerId ? waiting.find((j) => j.tab === openerId) : undefined) ??
        (sameSite.length === 1 ? sameSite[0] : undefined);
      if (job) return await start(job, page);

      // A tab Romva did not open: read the page and find its job by company (and role) among the
      // skipped jobs, the open ones and the ones ready on romva.space.
      await notice(page, 'Reading this page to find its job…');
      const info = await within(
        page.evaluate(() => ({ title: document.title, text: (document.body?.innerText || '').slice(0, 20_000) })),
        4000,
      ).catch(() => ({ title: '', text: '' }));
      const candidates = new Map();
      for (const j of [...waiting, ...open.values()]) candidates.set(j.bidId, j);
      const ready = await api.applyNext(20, []).then((r) => r?.jobs ?? [], () => []);
      for (const r of ready) if (!candidates.has(r.bidId)) candidates.set(r.bidId, { ...r, at: 0, data: null });
      const matches = matchPage([...candidates.values()], page.url(), info);
      if (matches.length === 1) return await start(matches[0], page);

      // Not sure: ask, and touch nothing until a job is chosen.
      const list = (matches.length ? matches : [...candidates.values()]).sort((x, y) => (y.at ?? 0) - (x.at ?? 0)).slice(0, 8);
      if (!list.length) {
        await notice(page, 'Romva found no job on romva.space for this page (a Draft with its Resume made), so it left the page alone.');
        return;
      }
      for (const j of list) offered.set(j.bidId, j);
      const choices = list.map((j) => ({ value: j.bidId, label: `${j.company} — ${j.role}` }));
      await notice(page, 'Which job is this form for? Nothing has been touched; Romva fills it in once you choose.', choices);
      log.info('Apply: key pressed in a tab whose job is not clear; asked which job it is', { matches: matches.length });
    } catch (error) {
      log.warn('Apply: could not start filling this tab', { error: error.message });
    } finally {
      busyTabs.delete(id);
    }
  }

  async function onPicked(page, bidId) {
    const job = parked.get(bidId) ?? open.get(bidId) ?? offered.get(bidId);
    if (!job) {
      await notice(page, 'That job is no longer waiting. Nothing was touched.');
      return;
    }
    await start(job, page);
  }

  /** Looks at every tab of the agent's Chrome for the key (and banner choices). */
  async function watchHotkey() {
    while (true) {
      try {
        const pages = await chatgpt.tabs();
        await Promise.all(
          pages.map(async (page) => {
            if (page.isClosed() || !/^https?:/i.test(page.url()) || NOT_A_FORM.test(page.url())) return;
            const main = page.mainFrame();
            for (const frame of page.frames()) {
              if (frame !== main && (!/^https?:/i.test(frame.url()) || SKIP_FRAME.test(frame.url()))) continue;
              let probe;
              try {
                probe = await within(frame.evaluate(KEY_PROBE), 1500);
              } catch {
                continue;
              }
              if (probe?.picked) void onPicked(page, probe.picked);
              if (probe?.pressed) {
                void onHotkey(page);
                break;
              }
            }
          }),
        );
      } catch {
        // Chrome closing or restarting: look again shortly.
      }
      await sleep(HOTKEY_EVERY_MS);
    }
  }

  async function fillPage(job, frames) {
    await Promise.all(
      fillTargets(frames).map(({ frame }) =>
        inFrame(frame, (data) => window.__romvaApply.fill(data), job.data, 15_000).catch(() => null),
      ),
    );
  }

  /** The page's open questions not yet sent to ChatGPT: answered by it in the background. */
  function answerQuestions(job, frames) {
    if (job.asking || Date.now() - job.loadedAt < QUESTIONS_AFTER_MS || Date.now() < job.askAfter) return;
    const targets = fillTargets(frames);
    if (!targets.length) return;
    job.asking = true;
    const page = job.page;
    void (async () => {
      let fresh = [];
      try {
        const lists = await Promise.all(
          targets.map(({ frame }) =>
            inFrame(frame, (applicant) => window.__romvaApply.questions({ applicant }), job.data.applicant ?? {}, 45_000).then(
              (list) => list.map((q) => ({ ...q, frame })),
              () => [],
            ),
          ),
        );
        const askKey = (q) => `${q.kind}|${q.question}`;
        fresh = lists.flat().filter((q) => !job.asked.has(askKey(q))).slice(0, QUESTIONS_PER_ASK);
        if (!fresh.length) return;
        for (const q of fresh) job.asked.add(askKey(q));

        log.info(`Apply: asking ChatGPT ${fresh.length} question(s) — ${job.company}`);
        if (job.manual) await notice(page, `Asking ChatGPT ${fresh.length} question(s)…`);
        const pageText = await within(page.evaluate(() => document.body.innerText.slice(0, 12_000)), 5000).catch(() => '');
        const questions = fresh.map(({ frame, ...q }) => q);
        const answers = parseAnswers(await chatgpt.ask(questionsPrompt(job, questions, pageText), { first: true }));
        if (page.isClosed()) return;

        const frames = [...new Set(fresh.map((q) => q.frame))];
        const typed = (
          await Promise.all(
            frames.map((frame) => inFrame(frame, (list) => window.__romvaApply.answer(list), answers, 60_000).catch(() => 0)),
          )
        ).reduce((sum, n) => sum + (Number(n) || 0), 0);
        log.info(`Apply: ChatGPT answered ${typed} of ${fresh.length} question(s) — ${job.company}`);
        await notice(
          page,
          typed === fresh.length
            ? `ChatGPT answered ${typed} question(s). Check them, then click Submit.`
            : `ChatGPT answered ${typed} of ${fresh.length} question(s); the rest are left for you.`,
        );
      } catch (error) {
        log.warn(`Apply: could not answer the questions — ${job.company}; trying again in a minute`, { error: error.message });
        for (const q of fresh) job.asked.delete(`${q.kind}|${q.question}`);
        job.askAfter = Date.now() + 60_000;
        if (fresh.length) await notice(page, `ChatGPT could not answer just now, so nothing was typed. Romva tries again in a minute.`);
      } finally {
        job.asking = false;
      }
    })();
  }

  /** One pass: close sent and closed tabs, skip sign-in pages, keep filling fresh ones, open more. */
  async function tick() {
    for (const [bidId, job] of open) {
      if (job.page.isClosed()) {
        open.delete(bidId);
        markHandled(bidId);
        log.info(`Apply: tab closed — ${job.company}`);
        continue;
      }
      const frames = await formFrames(job.page);
      if (!frames.length) continue; // navigating
      if (frames.some((f) => f.state.sent)) {
        open.delete(bidId);
        markHandled(bidId);
        log.info(`Apply: sent — ${job.company}`);
        await sleep(2500);
        await job.page.close().catch(() => undefined);
        continue;
      }

      const password = frames.some((f) => f.state.password);
      const form = frames.some((f) => f.state.application);
      if (!job.manual && !job.formSeen) {
        const main = frames.find((f) => f.main);
        const waited = Date.now() - job.loadedAt >= SIGN_IN_AFTER_MS;
        if (password || (!form && waited && main?.state.signIn)) {
          await park(job);
          continue;
        }
        if (!form) continue; // not the form yet: nothing is typed
        job.formSeen = true;
      }
      if (password) {
        // The person pressed the key on a sign-in page: it is never filled.
        if (job.signInNoted !== job.loadedAt) {
          job.signInNoted = job.loadedAt;
          await notice(job.page, `This is a sign-in page, so Romva left it alone. Sign in, go to the application form, then press ${HOTKEY}.`);
        }
        continue;
      }
      if (Date.now() < job.filledUntil) await fillPage(job, frames);
      answerQuestions(job, frames);
    }
    if (await applyOn()) await openNext();
  }

  return {
    async run() {
      log.info('Apply is allowed on this computer: Start apply on romva.space opens job tabs', { tabs: settings.tabs, key: HOTKEY });
      void watchHotkey();
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
