import { log } from './log.js';

/**
 * A first draft of the Resume from DeepSeek's free website: the same prompt,
 * answered in JSON, which the chosen AI then works from. Only a help: whatever
 * goes wrong, the Resume is made without it.
 */

const JSON_ONLY = 'Answer with one valid JSON object only: no text before or after it.';
const INVALID = 'Your answer must be one JSON object that JSON.parse accepts (double quotes, no comments, no trailing commas).';

/** After a failure, DeepSeek is left alone this long (its limit, a busy server, signed out). */
const REST_MS = 10 * 60_000;

/** The JSON object in `text`, written out again (on one line when `compact`), or null. */
export function jsonIn(text, { compact = false } = {}) {
  for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
        return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
      }
    } catch {
      // Next.
    }
  }
  return null;
}

/**
 * `message`, with DeepSeek's draft after it for the AI to work from. A
 * `fromProfile` request (romva.space: the Profile's own history, rules and
 * answer shape are all in it) needs one line of introduction, not five.
 */
export function withDraft(message, draft, { fromProfile = false } = {}) {
  if (!draft) return message;
  if (fromProfile) {
    return `${message}\n\nAnother AI's draft of this answer: check it against my work history and the rules above, fix it, and answer in the same JSON shape.\n${draft}`;
  }
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

/**
 * DeepSeek's DeepThink and Search switches for a Resume: on for a prompt that
 * researches (as before), off for a `fromProfile` request — nothing to look
 * up, and without DeepThink's long reasoning the answer is a fraction of the
 * size, which keeps DeepSeek's free usage limit far away.
 */
function switchesFor(job, options) {
  if (job.fromProfile) return { DeepThink: false, Search: false };
  return options.webSearch ? { DeepThink: true, Search: true } : undefined;
}

/** `chat`: createChat for DeepSeek. Returns (job, options) → the draft, or null. */
export function createDrafter(chat) {
  let restUntil = 0;
  return async function draftFor(job, options) {
    if (Date.now() < restUntil) return null;
    const fromProfile = job.fromProfile === true;
    const askOptions = { switches: switchesFor(job, options), name: `${job.company}_deepseek` };
    try {
      log.info('Asking DeepSeek for a draft', { company: job.company });
      // A fromProfile request already ends with "Reply with the JSON only".
      let message = fromProfile ? job.resumeMessage : `${job.resumeMessage}\n\n${JSON_ONLY}`;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const draft = jsonIn(await chat.ask(message, askOptions), { compact: fromProfile });
        if (draft) {
          log.info('DeepSeek draft received', { company: job.company });
          return draft;
        }
        log.warn(`DeepSeek's answer is not valid JSON (attempt ${attempt})`, { company: job.company });
        message = `${job.resumeMessage}\n\n${INVALID}`;
      }
    } catch (error) {
      log.warn(`No DeepSeek draft: ${error.message}`, { company: job.company, ...(error.seen ?? {}) });
    }
    restUntil = Date.now() + REST_MS;
    log.warn('Making the Resume without DeepSeek; it is asked again in 10 minutes at the earliest');
    return null;
  };
}
