import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ApiError, createApi, isTemporary } from './api.js';
import { ChatGptUnavailable, createChatGpt } from './chatgpt.js';
import { DATA_DIR, TOKEN_HELP, loadConfig } from './config.js';
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
 * An application whose Resume is stored but whose cover letter failed comes
 * back later as a letter-only job (steps 4–6 only).
 *
 * Does nothing while Auto resume is at Stop on romva.space. Waits (without
 * reloading anything) while ChatGPT is signed out. `--once`: one application,
 * then exit.
 */

const once = process.argv.includes('--once');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How often the agent checks in while busy: well inside romva.space's 2-minute "online" and 15-minute hold. */
const HEARTBEAT_MS = 60_000;

/**
 * Whether `pid` is a running Node process. A lock left by an agent that was
 * killed (sign-out, shutdown, a crash) stays behind, and Windows soon gives its
 * process id to some other program: alive, but not an agent. So on Windows
 * the program's name is checked too, not only that the id is in use.
 */
function isNodeProcess(pid) {
  try {
    process.kill(pid, 0); // throws when no such process
  } catch (error) {
    return error.code === 'EPERM'; // exists, but not ours to signal
  }
  if (process.platform !== 'win32') return true;
  try {
    const row = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    const image = row.trim().match(/^"([^"]+)"/)?.[1] ?? '';
    return /^node(\.exe)?$/i.test(image);
  } catch {
    return true; // Could not tell: assume it is an agent rather than run two.
  }
}

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
    if (pid && pid !== process.pid && isNodeProcess(pid)) return false;
  } catch {
    // No lock.
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

/**
 * The files to disk. They are already stored on romva.space, so a disk
 * problem (a folder path too long, the disk full) is logged and the work
 * carries on — it never costs the application its cover letter.
 */
async function saveQuietly(saveDir, job, files, what) {
  try {
    const directory = await saveFiles(saveDir, job, files);
    log.info(`${what} saved`, { company: job.company, directory });
  } catch (error) {
    log.warn(`${what} is on romva.space, but could not be saved to this computer`, {
      company: job.company,
      error: error.message,
    });
  }
}

/**
 * While an application is being made, check in every minute: romva.space
 * shows this computer as running, and the hold on the application is renewed
 * so a slow ChatGPT does not lose it to another worker.
 */
function keepHolding(api, job) {
  let warned = false;
  const timer = setInterval(() => {
    api.heartbeat(job.bidId).catch((error) => {
      if (error instanceof ApiError && error.status === 409 && !warned) {
        warned = true;
        log.warn('romva.space says this application is no longer ours', { company: job.company });
      }
    });
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
}

/**
 * The cover letter: once more if the first try fails (a slow page, an odd
 * answer). Throws when it could not be made: as it is when retrying later will
 * do (ChatGPT unavailable, romva.space unreachable, the application gone to
 * another worker), else as a plain error for the application to be counted.
 */
async function makeLetter(api, chatgpt, config, job, message) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let letter;
    try {
      const letterAnswer = await chatgpt.ask(message);
      letter = await api.submitCoverLetter(job.bidId, letterAnswer);
    } catch (error) {
      // ChatGPT cannot be used (signed out…): no second try now. The agent
      // pauses, and the application comes back as a letter-only job — uncounted.
      if (error instanceof ChatGptUnavailable) throw error;
      if ((error instanceof ApiError && error.status === 409) || isTemporary(error)) throw error;
      lastError = error;
      log.warn(`Cover letter attempt ${attempt} failed`, { company: job.company, error: error.message });
      continue;
    }
    await saveQuietly(config.saveDir, job, letter.files, 'Cover letter');
    log.info('Done', { company: job.company });
    return;
  }
  // The Resume is in; the letter is counted as failed and tried again later on its own.
  throw new Error(`Cover letter: ${lastError?.message ?? 'failed'}`);
}

/**
 * ChatGPT's Resume answer, looked over by romva.space before it is handed in:
 * readable JSON that fills the template's summary, skills, job titles and
 * bullet points? When something is missing, ChatGPT is asked once more in a
 * new chat, told exactly what was missing — rather than a Resume with empty
 * sections being made. The second answer is handed in as it is (romva.space
 * refuses it if it is still incomplete, and the application is tried later).
 */
async function askForResume(api, chatgpt, job) {
  const answer = await chatgpt.ask(job.resumeMessage);
  let check;
  try {
    check = await api.checkResume(job.bidId, answer);
  } catch (error) {
    // An older romva.space without the check: hand the answer in as before.
    if (error instanceof ApiError && error.status === 404) return answer;
    throw error;
  }
  if (check.ok || !check.retryMessage) return answer;
  log.warn('Resume answer incomplete; asking ChatGPT again', { company: job.company, problems: check.problems });
  return chatgpt.ask(check.retryMessage);
}

async function makeOne(api, chatgpt, config, job) {
  const stopHolding = keepHolding(api, job);
  try {
    if (job.letterOnly) {
      log.info(`Making the cover letter for #${job.number ?? '?'} ${job.company} — ${job.role}`);
      await makeLetter(api, chatgpt, config, job, job.coverLetterMessage);
      return;
    }
    log.info(`Making #${job.number ?? '?'} ${job.company} — ${job.role}`);
    const resumeAnswer = await askForResume(api, chatgpt, job);
    const resume = await api.submitResume(job.bidId, resumeAnswer);
    await saveQuietly(config.saveDir, job, resume.files, 'Resume');
    await makeLetter(api, chatgpt, config, job, resume.coverLetterMessage);
  } finally {
    stopHolding();
  }
}

async function main() {
  const config = loadConfig();
  if (!config.token) {
    log.error(`No Romva token. ${TOKEN_HELP}`);
    process.exit(1);
  }
  if (!singleInstance()) {
    log.info('Another Romva Resume Agent is already running on this computer; exiting.');
    process.exit(0);
  }

  const api = createApi(config.apiUrl, config.workerName, config.token);
  const chatgpt = createChatGpt(config.chrome);
  const me = await api.me().catch((error) => {
    log.error('romva.space did not take the Romva token', { error: error.message });
    process.exit(1);
  });
  log.info(`Romva Resume Agent started`, {
    profile: me?.token?.profile?.name,
    worker: config.workerName,
    saveDir: config.saveDir,
    api: config.apiUrl,
  });

  // Whatever this computer's previous run was making when it stopped is free
  // again at once, rather than after romva.space's 15-minute hold runs out.
  await api
    .releaseHeld()
    .then(({ released }) => {
      if (released > 0) log.info(`Handed back ${released} application(s) left by the previous run`);
    })
    .catch((error) => log.warn('Could not hand back the previous run\'s applications', { error: error.message }));

  let waitingForChatGpt = false;
  let stoppedLogged = false;
  let checkedInAt = 0;
  // Paused for ChatGPT: not before `resumeAfter`. A pause that comes back
  // soon after resuming doubles the wait (30 s, 1, 2, 4, 8, 10 min), so a
  // ChatGPT that keeps failing is never retried every few seconds.
  let pauses = 0;
  let resumedAt = 0;
  let resumeAfter = 0;

  while (true) {
    try {
      // Signed out of ChatGPT last time: look at the window (no reload) until it is back.
      if (waitingForChatGpt) {
        if (Date.now() < resumeAfter || !(await chatgpt.ready())) {
          // Still check in, so romva.space shows this computer as up (and why it waits).
          if (Date.now() - checkedInAt >= HEARTBEAT_MS) {
            checkedInAt = Date.now();
            await api.heartbeat().catch(() => undefined);
          }
          await sleep(config.pollSeconds * 1000);
          continue;
        }
        waitingForChatGpt = false;
        resumedAt = Date.now();
        log.info('ChatGPT is ready again');
      }

      const { enabled, job } = await api.claim();
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
          pauses = resumedAt && Date.now() - resumedAt < 10 * 60_000 ? pauses + 1 : 1;
          const holdMs = Math.min(10 * 60_000, 30_000 * 2 ** (pauses - 1));
          resumeAfter = Date.now() + holdMs;
          log.warn(`Paused: ${error.message} Trying again in ${Math.round(holdMs / 1000)} s at the earliest.`);
          waitingForChatGpt = true;
          await api.release(job.bidId, false, error.message).catch(() => undefined);
        } else if (error instanceof ApiError && error.status === 409) {
          // Our hold ran out and the application went to another worker (or was
          // finished): it is theirs now, so it is left alone — not handed back.
          log.warn(`No longer ours, moving on: ${error.message}`, { company: job.company });
        } else if (isTemporary(error)) {
          // romva.space unreachable or in trouble (its database full or down):
          // hand the application back uncounted and wait a minute.
          log.warn(`romva.space error, retrying later: ${error.message}`, { company: job.company });
          await api.release(job.bidId, false, error.message).catch(() => undefined);
          await sleep(60_000);
        } else {
          // romva.space already counted a bad Resume answer (400/502) when it
          // refused it; everything else (a failed cover letter included) is counted here.
          const counted = error instanceof ApiError && (error.status === 400 || error.status === 502);
          log.error(`Failed: ${job.company}`, { error: error.message });
          if (!counted) await api.release(job.bidId, true, error.message).catch(() => undefined);
        }
      }
      if (once) return;
    } catch (error) {
      // romva.space unreachable, the token revoked, the network down: wait and try again.
      // A 401 here already says what to do (a new token, and setup).
      log.error(
        error instanceof ApiError && error.status === 401 ? 'The Romva token was refused' : 'Could not reach romva.space',
        { error: error.message },
      );
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
