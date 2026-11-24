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
  'So write finished text only. No placeholders (such as "[verified percentage]", "[Confirm official job title]" or "X%"),',
  'and no notes to the candidate (such as "(verify proficiency)", "confirm", "draft" or "before submission").',
  'Bold markup that the prompt asks for (such as [text][highlight]) is fine.',
  'Where you would leave a placeholder for a detail you do not know, leave that detail out and write the sentence without it.',
].join('\n');

const BOLD_END = '][highlight]';

/**
 * `text` without its bold markup — Resume Maker's `[text][highlight]` and
 * Markdown's `**text**` — keeping the bold words, and any placeholder inside
 * them ("[reducing errors by [verified percentage]][highlight]").
 */
function withoutBold(text) {
  let out = text.replace(/\*\*([^*\n]+?)\*\*/g, '$1');
  for (let end = out.indexOf(BOLD_END); end >= 0; end = out.indexOf(BOLD_END)) {
    // The "[" that opens this bold span, bracket pairs inside it skipped.
    let depth = 0;
    let open = end - 1;
    for (; open >= 0; open -= 1) {
      if (out[open] === ']') depth += 1;
      else if (out[open] === '[') {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    out = open >= 0
      ? out.slice(0, open) + out.slice(open + 1, end) + out.slice(end + BOLD_END.length)
      : out.slice(0, end) + out.slice(end + BOLD_END.length);
  }
  return out.replace(/\[\/?highlight\]/gi, '');
}

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
      const plain = withoutBold(value);
      for (const mark of DRAFT_MARKS) for (const match of plain.matchAll(mark)) found.add(match[0].trim());
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
