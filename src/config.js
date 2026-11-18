import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the agent keeps its settings and sign-in, per Windows user:
 *
 *   %APPDATA%\RomvaResumeAgent\config.json   settings (edit by hand, or run setup again)
 *   %APPDATA%\RomvaResumeAgent\session.json  romva.space sign-in (tokens, never the password)
 *   %APPDATA%\RomvaResumeAgent\agent.log     what it did
 *   %LOCALAPPDATA%\RomvaResumeAgent\chrome   the ChatGPT Chrome profile (sign in to ChatGPT once)
 */

const appData = process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');

/** ROMVA_AGENT_HOME: keep settings elsewhere (a second agent, or a test). */
export const DATA_DIR = process.env.ROMVA_AGENT_HOME || path.join(appData, 'RomvaResumeAgent');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const SESSION_FILE = path.join(DATA_DIR, 'session.json');
export const LOG_FILE = path.join(DATA_DIR, 'agent.log');

/**
 * The romva.space email and password, in the agent's own folder
 * (resume_agent\credentials.txt), for signing in again by itself whenever
 * its sign-in ends. Optional; kept out of git. ROMVA_AGENT_CREDENTIALS: a
 * file elsewhere.
 */
export const CREDENTIALS_FILE =
  process.env.ROMVA_AGENT_CREDENTIALS ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'credentials.txt');

export const DEFAULTS = {
  /** The romva.space site (its /api is the backend). */
  apiUrl: 'https://www.romva.space',
  /** Where the five files of each application are saved: <saveDir>\<Profile>\<Company_Role>\ */
  saveDir: path.join(homedir(), 'Documents', 'Resume'),
  /** This computer's name in the queue and in the logs. */
  workerName: `agent · ${hostname()}`,
  /** How often to ask for the next application when idle, in seconds. */
  pollSeconds: 20,
  /** The Chrome window the agent uses for ChatGPT. */
  chrome: {
    path: '',
    profileDir: path.join(localAppData, 'RomvaResumeAgent', 'chrome'),
    debugPort: 9334,
    url: 'https://chatgpt.com/',
    temporaryChat: true,
    answerTimeoutMinutes: 8,
  },
};

function readJson(file) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) : null;
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function loadConfig() {
  const saved = readJson(CONFIG_FILE) ?? {};
  return {
    ...DEFAULTS,
    ...saved,
    chrome: { ...DEFAULTS.chrome, ...(saved.chrome ?? {}) },
  };
}

export function saveConfig(config) {
  writeJson(CONFIG_FILE, config);
}

export function loadSession() {
  return readJson(SESSION_FILE);
}

export function saveSession(session) {
  writeJson(SESSION_FILE, session);
}

/**
 * credentials.txt, read afresh each time (edit it while the agent runs):
 *
 *   email=you@example.com
 *   password=your password
 *
 * Lines starting with # are notes. Everything after the first `=` is the
 * value, so a password may hold `=` or `#`. Null when the file is missing or
 * either line is empty.
 */
export function loadCredentials() {
  try {
    if (!existsSync(CREDENTIALS_FILE)) return null;
    const values = {};
    for (const raw of readFileSync(CREDENTIALS_FILE, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const at = line.indexOf('=');
      if (at < 0) continue;
      values[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    return values.email && values.password ? { email: values.email, password: values.password } : null;
  } catch {
    return null;
  }
}
