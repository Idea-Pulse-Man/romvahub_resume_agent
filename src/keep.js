import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

/**
 * What the AI site did, to look at later: the answers asked for again, and
 * the pages whose answer could not be used (no JSON, never finished). The
 * newest 30 files.
 */
export const ANSWERS_DIR = path.join(DATA_DIR, 'answers');

/**
 * Saves `content` (text, or a Buffer with `extension`) as
 * answers\<time>_<name>_<label>.<extension>. Its path, or undefined: only for
 * looking at later, so it never throws.
 */
export function keepFile(name, label, content, extension = 'txt') {
  try {
    mkdirSync(ANSWERS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = String(name || 'chat').replace(/[^\w.-]+/g, '_').slice(0, 40);
    const file = path.join(ANSWERS_DIR, `${stamp}_${safe}_${label}.${extension}`);
    writeFileSync(file, content);
    for (const old of readdirSync(ANSWERS_DIR).sort().reverse().slice(30)) unlinkSync(path.join(ANSWERS_DIR, old));
    return file;
  } catch {
    return undefined;
  }
}
