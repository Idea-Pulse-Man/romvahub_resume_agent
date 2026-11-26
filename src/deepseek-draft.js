import { log } from './log.js';

/**
 * The first of two prompts (config.json method "two"): a first draft of the
 * Resume from the first AI (draftAi: DeepSeek's free website by default, or any
 * of the AIs) — the same prompt, answered in JSON, which the second AI then
 * works from. Only a help: whatever goes wrong, the Resume is made without it.
 */

const JSON_ONLY = 'Answer with one valid JSON object only: no text before or after it.';
const INVALID = 'Your answer must be one JSON object that JSON.parse accepts (double quotes, no comments, no trailing commas).';

/** After a failure, the first AI is left alone this long (its limit, a busy server, signed out). */
const REST_MS = 10 * 60_000;

/** The JSON object in `text`, written out again, or null. */
export function jsonIn(text) {
  for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
        return JSON.stringify(value, null, 2);
      }
    } catch {
      // Next.
    }
  }
  return null;
}

/** `message`, with the first AI's draft after it for the second AI to work from. */
export function withDraft(message, draft) {
  if (!draft) return message;
  return [
    message,
    '',
    'Another AI answered this same request with the draft below. Use it only as a first draft:',
    'check every claim against what is given above, correct and improve it, and leave out',
    'anything invented. The instructions above take priority over the draft, and your answer',
    'is in the format they ask for.',
    '',
    'DRAFT:',
    draft,
  ].join('\n');
}

/** `chat`: createChat for the first AI. Returns (job, options) → the draft, or null. */
export function createDrafter(chat) {
  const ai = chat.site.name;
  let restUntil = 0;
  return async function draftFor(job, options) {
    if (Date.now() < restUntil) return null;
    try {
      log.info(`Asking ${ai} for a draft`, { company: job.company });
      let message = `${job.resumeMessage}\n\n${JSON_ONLY}`;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const draft = jsonIn(await chat.ask(message, { ...options, name: `${job.company}_draft_${chat.site.id}` }));
        if (draft) {
          log.info(`${ai} draft received`, { company: job.company });
          return draft;
        }
        log.warn(`${ai}'s draft is not valid JSON (attempt ${attempt})`, { company: job.company });
        message = `${job.resumeMessage}\n\n${INVALID}`;
      }
    } catch (error) {
      log.warn(`No ${ai} draft: ${error.message}`, { company: job.company, ...(error.seen ?? {}) });
    }
    restUntil = Date.now() + REST_MS;
    log.warn(`Making the Resume without ${ai}'s draft; it is asked again in 10 minutes at the earliest`);
    return null;
  };
}
