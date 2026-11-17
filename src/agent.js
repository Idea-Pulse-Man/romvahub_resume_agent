import { mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ApiError, createApi } from './api.js';
import { createApplier } from './apply.js';
import { ChatGptUnavailable, createChatGpt } from './chatgpt.js';
import { DATA_DIR, loadConfig, loadSession } from './config.js';
import { log } from './log.js';

/**
 * Romva Resume Agent: makes the Resume and cover letter for each new Draft
 * application on romva.space, in the background, with this computer's
 * signed-in ChatGPT.
 *
 *   1. ask romva.space for the next application (it hands out each one to one
 *      worker only — this agent, the Chrome extension, or the local API)
 *   2. ChatGPT, new chat: the Profile's Resume prompt + the posting → JSON
 *   3. romva.space builds the Resume (Word template + PDF) and stores it
 *   4. ChatGPT, new chat: the cover letter prompt → JSON
 *   5. romva.space builds and stores the cover letter
 *   6. the five files are saved to <saveDir>\<Profile>\<Company_Role>\
 *
 * Does nothing while Auto resume is at Stop on romva.space. Waits (without
 * reloading anything) while ChatGPT is signed out. `--once`: one application,
 * then exit.
 */

const once = process.argv.includes('--once');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One agent per settings folder: a second start (the logon task and a manual
 * one) exits at once. A lock file holding the running agent's process id; a
 * lock left by an agent that has died is taken over.
 */
function singleInstance() {
  const lock = path.join(DATA_DIR, 'agent.lock');
  mkdirSync(DATA_DIR, { recursive: true });
  try {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (pid && pid !== process.pid) {
      process.kill(pid, 0); // throws when no such process
      return false;
    }
  } catch {
    // No lock, or its agent is gone.
  }
  writeFileSync(lock, String(process.pid));
  process.on('exit', () => {
    try {
      if (Number(readFileSync(lock, 'utf8')) === process.pid) unlinkSync(lock);
    } catch {
      // Already gone.
    }
  });
  return true;
}

async function saveFiles(saveDir, job, files) {
  const directory = path.join(saveDir, job.profileFolderName, job.folderName);
  await mkdir(directory, { recursive: true });
  for (const file of Object.values(files)) {
    if (file?.name && file.base64) await writeFile(path.join(directory, file.name), Buffer.from(file.base64, 'base64'));
  }
  return directory;
}

async function makeOne(api, chatgpt, config, job) {
  log.info(`Making #${job.number ?? '?'} ${job.company} — ${job.role}`);

  const resumeAnswer = await chatgpt.ask(job.resumeMessage);
  const resume = await api.submitResume(job.bidId, resumeAnswer);
  const directory = await saveFiles(config.saveDir, job, resume.files);
  log.info(`Resume saved`, { company: job.company, directory });

  // The letter: once more if the first try fails (a slow page, an odd answer).
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const letterAnswer = await chatgpt.ask(resume.coverLetterMessage);
      const letter = await api.submitCoverLetter(job.bidId, letterAnswer);
      await saveFiles(config.saveDir, job, letter.files);
      log.info(`Cover letter saved — done`, { company: job.company, directory });
      return;
    } catch (error) {
      lastError = error;
      log.warn(`Cover letter attempt ${attempt} failed`, { company: job.company, error: error.message });
      // ChatGPT unavailable between the two chats: the Resume is already in, so
      // wait for ChatGPT here (up to 10 minutes) rather than leave the letter out.
      if (error instanceof ChatGptUnavailable && attempt === 1) {
        const deadline = Date.now() + 10 * 60_000;
        while (Date.now() < deadline && !(await chatgpt.ready())) await sleep(15_000);
      }
    }
  }
  // The Resume is in; the letter is given up on (Remake on romva.space redoes both).
  await api.release(job.bidId, true, `Cover letter: ${lastError?.message ?? 'failed'}`).catch(() => undefined);
}

async function main() {
  const config = loadConfig();
  if (!loadSession()) {
    log.error('Not signed in to romva.space. Run setup first: npm run setup');
    process.exit(1);
  }
  if (!singleInstance()) {
    log.info('Another Romva Resume Agent is already running on this computer; exiting.');
    process.exit(0);
  }

  const api = createApi(config.apiUrl);
  const chatgpt = createChatGpt(config.chrome);
  const me = await api.me().catch((error) => {
    log.error('Could not sign in to romva.space', { error: error.message });
    process.exit(1);
  });
  log.info(`Romva Resume Agent started`, {
    user: me?.user?.email ?? me?.email,
    worker: config.workerName,
    saveDir: config.saveDir,
    api: config.apiUrl,
  });

  // Apply runs alongside, in tabs of its own (apply.js), while Start apply is
  // on at romva.space; it never submits.
  if (config.apply.enabled && !once) {
    void createApplier(api, chatgpt, config.apply).run();
  }

  let waitingForChatGpt = false;
  let stoppedLogged = false;

  while (true) {
    try {
      // Signed out of ChatGPT last time: look at the window (no reload) until it is back.
      if (waitingForChatGpt) {
        if (!(await chatgpt.ready())) {
          await sleep(config.pollSeconds * 1000);
          continue;
        }
        waitingForChatGpt = false;
        log.info('ChatGPT is ready again');
      }

      const { enabled, job } = await api.claim(config.workerName);
      if (!enabled) {
        if (!stoppedLogged) log.info('Auto resume is at Stop on romva.space; waiting for Start');
        stoppedLogged = true;
        await sleep(config.pollSeconds * 1000);
        continue;
      }
      stoppedLogged = false;
      if (!job) {
        if (once) return;
        await sleep(config.pollSeconds * 1000);
        continue;
      }

      try {
        await makeOne(api, chatgpt, config, job);
      } catch (error) {
        if (error instanceof ChatGptUnavailable) {
          log.warn(`Paused: ${error.message}`);
          waitingForChatGpt = true;
          await api.release(job.bidId, false, error.message).catch(() => undefined);
        } else if (error instanceof ApiError && error.status >= 500 && error.status !== 502) {
          // romva.space itself in trouble (its database full or down): hand the
          // application back uncounted and wait a minute.
          log.warn(`romva.space error, retrying later: ${error.message}`, { company: job.company });
          await api.release(job.bidId, false, error.message).catch(() => undefined);
          await sleep(60_000);
        } else {
          // romva.space already counted a bad answer (400/502) when it refused it.
          const counted = error instanceof ApiError && (error.status === 400 || error.status === 502);
          log.error(`Failed: ${job.company}`, { error: error.message });
          if (!counted) await api.release(job.bidId, true, error.message).catch(() => undefined);
        }
      }
      if (once) return;
    } catch (error) {
      // romva.space unreachable, signed out of it, the network down: wait and try again.
      log.error('Could not reach romva.space', { error: error.message });
      if (error instanceof ApiError && error.status === 401) {
        log.error('The romva.space sign-in has expired. Run setup again: npm run setup');
      }
      await sleep(Math.max(60, config.pollSeconds) * 1000);
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    log.error('Agent stopped', { error: error?.stack ?? String(error) });
    process.exit(1);
  },
);
