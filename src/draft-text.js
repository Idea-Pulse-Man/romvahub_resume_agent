/**
 * ChatGPT's thinking models (Medium, High) do not make up what they cannot
 * know about the candidate — a job title, a percentage — and answer with a
 * draft for the candidate to finish: "[Confirm official job title]",
 * "by X%", "[verified percentage]", "(verify proficiency)", "Draft for
 * candidate verification: … must be confirmed before submission". The Resume
 * is built from the answer word for word, so that text went into the Resume.
 *
 * Every Resume chat says the answer is the finished text, and an answer that
 * is a draft all the same is asked for once more, with its drafts quoted.
 */

/** Added to every Resume request. */
export const FINISHED_TEXT = [
  'This JSON goes into the final Resume word for word, and the Resume is sent as it is: nobody edits it first.',
  'So write finished text only. No placeholders or brackets (such as "[verified percentage]", "[Confirm official job title]" or "X%"),',
  'and no notes to the candidate (such as "(verify proficiency)", "confirm", "draft" or "before submission").',
  'Where you would leave a placeholder for a detail you do not know, leave that detail out and write the sentence without it.',
].join('\n');

const DRAFT_MARKS = [
  // [Confirm official job title], [verified percentage]
  /\[[^[\]\n]{1,300}\]/g,
  // by X%
  /\b[XYN]{1,2} ?%/g,
  // (verify proficiency), (confirm hands-on experience)
  /\((?:verify|confirm|to be (?:confirmed|verified))[^()\n]{0,80}\)/gi,
  // "Draft for candidate verification", "in this draft require candidate verification"
  /\b(?:candidate verification|in this draft|draft for|placeholders?)\b/gi,
];

/** The answer's JSON, also when there is text around it; undefined when there is none. */
function parse(answer) {
  try {
    return JSON.parse(answer);
  } catch {
    const start = answer.indexOf('{');
    const end = answer.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(answer.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/** The draft text in a Resume answer's values, quoted (a few at most); empty when it is finished. */
export function draftMarks(answer) {
  const json = parse(answer);
  if (json === undefined) return []; // not readable: romva.space's own check says so
  const found = new Set();
  const visit = (value) => {
    if (typeof value === 'string') {
      for (const mark of DRAFT_MARKS) for (const match of value.matchAll(mark)) found.add(match[0].trim());
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  visit(json);
  return [...found].slice(0, 8);
}

/** `request` for a second chat, with the first answer's drafts quoted. */
export function withDraftsPointedOut(request, marks) {
  return [
    request,
    '',
    '================================================================================',
    'YOUR PREVIOUS ANSWER WAS A DRAFT, NOT A FINISHED RESUME',
    '================================================================================',
    'It had placeholders or notes for the candidate in it, such as:',
    ...marks.map((mark) => `- ${mark}`),
    '',
    'Write the whole JSON again, finished, with none of these.',
  ].join('\n');
}
