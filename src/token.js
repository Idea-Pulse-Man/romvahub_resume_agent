import { createApi } from './api.js';
import { loadConfig, saveConfig } from './config.js';

/**
 * For the GUI (gui/RomvaAgent.exe). Never prints the token itself.
 *
 *   node src/token.js status   → {"hasToken":true,"profile":"…","expiresAt":"…"} (or "error", and "refused" on a 401)
 *   node src/token.js set      ← the new token on stdin; checked with romva.space, then saved
 *                              → {"ok":true,"profile":"…","expiresAt":"…"} or {"ok":false,"error":"…"}
 */

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}

function profileOf(me) {
  return { profile: me?.token?.profile?.name ?? null, expiresAt: me?.token?.expiresAt ?? null };
}

async function status() {
  const config = loadConfig();
  if (!config.token) return print({ hasToken: false });
  try {
    const me = await createApi(config.apiUrl, undefined, config.token).me();
    print({ hasToken: true, ...profileOf(me) });
  } catch (error) {
    const refused = error.status === 401;
    print({ hasToken: true, refused, error: refused ? 'romva.space refused it (expired or revoked).' : error.message });
  }
}

async function set() {
  const token = await readStdin();
  if (!token) return print({ ok: false, error: 'No token given.' });
  if (/\s/.test(token)) return print({ ok: false, error: 'The token has spaces in it. Copy it again.' });
  const config = loadConfig();
  try {
    const me = await createApi(config.apiUrl, undefined, token).me();
    saveConfig({ ...config, token });
    print({ ok: true, ...profileOf(me) });
  } catch (error) {
    print({ ok: false, error: error.status === 401 ? 'romva.space refused this token.' : error.message });
  }
}

const command = process.argv[2];
(command === 'set' ? set() : command === 'status' ? status() : Promise.reject(new Error('Use: status | set')))
  // No process.exit(): right after a fetch it can trip a Node bug on Windows. Node ends by itself.
  .catch((error) => {
    print({ ok: false, error: error.message });
    process.exitCode = 1;
  });
