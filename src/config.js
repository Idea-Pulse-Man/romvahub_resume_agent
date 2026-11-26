import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';

/**
 * Where the agent keeps its settings and its Romva token, per Windows user:
 *
 *   %APPDATA%\RomvaResumeAgent\config.json   settings and the Romva token (edit by hand, or run setup again)
 *   %APPDATA%\RomvaResumeAgent\agent.log     what it did
 *   %LOCALAPPDATA%\RomvaResumeAgent\chrome   the ChatGPT Chrome profile (sign in to ChatGPT once)
 */

const appData = process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');

/** ROMVA_AGENT_HOME: keep settings elsewhere (a second agent, or a test). */
export const DATA_DIR = process.env.ROMVA_AGENT_HOME || path.join(appData, 'RomvaResumeAgent');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const LOG_FILE = path.join(DATA_DIR, 'agent.log');

/** What to do about a missing or refused token. */
export const TOKEN_HELP =
  "Ask the Super Admin for your Profile's token (romva.space → Tokens), then click “Change token…” in the " +
  'Romva Resume Agent window (or run npm run setup).';

export const DEFAULTS = {
  /** The romva.space site (its /api is the backend). */
  apiUrl: 'https://www.romva.space',
  /** The Romva token (rmv_…) for one Profile: the agent acts as it, with no sign-in. */
  token: '',
  /** Where the five files of each application are saved: <saveDir>\<Profile>\<Company_Role>\ */
  saveDir: path.join(homedir(), 'Documents', 'Resume'),
  /** This computer's name in the queue and in the logs. */
  workerName: `agent · ${hostname()}`,
  /** How often to ask for the next application when idle, in seconds. */
  pollSeconds: 20,
  /** The AI website asked for the Resumes and cover letters: "chatgpt", "claude" or "gemini" (sites.js). */
  ai: 'chatgpt',
  /** Ask DeepSeek's free website for a Resume draft first, which the AI above then works from. */
  deepseekFirst: true,
  /** The Chrome window the agent uses for the AI website (signed in there once). */
  chrome: {
    path: '',
    profileDir: path.join(localAppData, 'RomvaResumeAgent', 'chrome'),
    debugPort: 9334,
    /** ChatGPT's address; Claude and Gemini have theirs in sites.js. */
    url: 'https://chatgpt.com/',
    temporaryChat: true,
    /** The Resume chats start with web search on, where the site lets the agent choose it (ChatGPT). */
    resumeWebSearch: true,
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
    // ROMVA_TOKEN: a token from the environment instead (a second agent, or a test).
    token: process.env.ROMVA_TOKEN || saved.token || '',
    // The romva hub desktop app also passes its server and AI website.
    ...(process.env.ROMVA_API_URL ? { apiUrl: process.env.ROMVA_API_URL } : {}),
    ...(process.env.ROMVA_AI ? { ai: process.env.ROMVA_AI } : {}),
    chrome: { ...DEFAULTS.chrome, ...(saved.chrome ?? {}) },
  };
}

export function saveConfig(config) {
  writeJson(CONFIG_FILE, config);
}

/** config.json as saved (no defaults filled in, no ROMVA_TOKEN), or null. */
export function readSavedConfig() {
  return readJson(CONFIG_FILE);
}

/** Changes some keys of config.json and keeps the rest as it is. */
export function updateConfig(changes) {
  writeJson(CONFIG_FILE, { ...(readJson(CONFIG_FILE) ?? {}), ...changes });
}
