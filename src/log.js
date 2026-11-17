import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { LOG_FILE } from './config.js';

/** One line per event, to the console and to agent.log (kept under ~2 MB, one old file). */
const MAX_BYTES = 2 * 1024 * 1024;

function write(level, message, details) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}${details ? ` ${JSON.stringify(details)}` : ''}`;
  (level === 'ERROR' ? console.error : console.log)(line);
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.old`);
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // Logging must never stop the agent.
  }
}

export const log = {
  info: (message, details) => write('INFO', message, details),
  warn: (message, details) => write('WARN', message, details),
  error: (message, details) => write('ERROR', message, details),
};
