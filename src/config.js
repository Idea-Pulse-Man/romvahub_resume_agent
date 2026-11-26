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
  /**
   * How a Resume is made (sites.js names the AIs: "chatgpt", "deepseek", "claude", "gemini"):
   *   "one": one prompt — `ai` writes it;
   *   "two": two prompts — `draftAi` writes a first draft (JSON), and `ai` writes the
   *          Resume from the prompt and that draft.
   * Unset, "deepseekFirst" decides (the agent window's switch): on → "two", off → "one".
   */
  method: undefined,
  /** The AI that writes the Resume: the only one ("one"), or the second ("two"). */
  ai: 'chatgpt',
  /** The AI that writes the first draft ("two"). */
  draftAi: 'deepseek',
  /** The AI that writes the cover letter (one prompt); '' = the same as `ai`. */
  letterAi: '',
  /** Ask DeepSeek's free website for a Resume draft first: the older switch for "method" (true → "two"). */
  deepseekFirst: true,
  /**
   * Each AI's own choices, made in every chat with it ('' or unset leaves the site's own):
   *   chatgpt: { mode: "chat" | "work", model (as its model menu names it: the models
   *            differ between Chat and Work), effort: "low" | "medium" | "high" (or a
   *            level's name in the menu) }. Work chats are ordinary chats (kept in
   *            ChatGPT's history): a temporary chat has no Work mode.
   *   deepseek: { deepThink: true | false, search: true | false } — it has no model menu.
   *   claude, gemini: nothing yet (their default model).
   */
  models: {
    chatgpt: { mode: 'chat', model: 'GPT-6', effort: 'high' },
    deepseek: { deepThink: true, search: true },
    claude: {},
    gemini: {},
  },
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

/** ROMVA_MODELS (the desktop app): {"chatgpt": {...}, "deepseek": {...}}, or {}. */
function modelsFromEnv() {
  try {
    const value = JSON.parse(process.env.ROMVA_MODELS || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/** "one" or "two" (see DEFAULTS.method): ROMVA_METHOD, else config.json's "method", else its "deepseekFirst". */
function methodOf(saved) {
  const method = String(process.env.ROMVA_METHOD || saved?.method || '').toLowerCase();
  if (method === 'one' || method === 'two') return method;
  return (saved?.deepseekFirst ?? DEFAULTS.deepseekFirst) === false ? 'one' : 'two';
}

/** The Resume method as config.json has it now: the agent window's switch counts from the next application on. */
export function currentMethod() {
  return methodOf(readJson(CONFIG_FILE));
}

export function loadConfig() {
  const saved = readJson(CONFIG_FILE) ?? {};
  const env = modelsFromEnv();
  const models = {};
  for (const id of new Set([...Object.keys(DEFAULTS.models), ...Object.keys(saved.models ?? {}), ...Object.keys(env)])) {
    models[id] = { ...(DEFAULTS.models[id] ?? {}), ...(saved.models?.[id] ?? {}), ...(env[id] ?? {}) };
  }
  const config = {
    ...DEFAULTS,
    ...saved,
    // ROMVA_TOKEN: a token from the environment instead (a second agent, or a test).
    token: process.env.ROMVA_TOKEN || saved.token || '',
    // The romva hub desktop app also passes its server, the method and the AI websites.
    ...(process.env.ROMVA_API_URL ? { apiUrl: process.env.ROMVA_API_URL } : {}),
    ...(process.env.ROMVA_AI ? { ai: process.env.ROMVA_AI } : {}),
    ...(process.env.ROMVA_DRAFT_AI ? { draftAi: process.env.ROMVA_DRAFT_AI } : {}),
    ...(process.env.ROMVA_LETTER_AI ? { letterAi: process.env.ROMVA_LETTER_AI } : {}),
    method: methodOf(saved),
    models,
    chrome: { ...DEFAULTS.chrome, ...(saved.chrome ?? {}) },
  };
  if (!config.letterAi) config.letterAi = config.ai;
  return config;
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
