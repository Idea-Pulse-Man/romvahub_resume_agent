/**
 * Small repairs to ChatGPT's Resume JSON before it is handed in.
 *
 * Skill groups: romva.space takes each key of `technicalskills` as the
 * group's name ("Programming & Data Analysis: Python, SQL"). ChatGPT sometimes
 * names the keys after the template's tags and puts the real name in the
 * value — { "Skill-Group-1": "Programming & Data Analysis: Python, SQL" } —
 * and the Resume then read "Skill-Group-1: Programming & Data Analysis:
 * Python, SQL". Such a key is given its own name back from the value; one
 * whose value has no name is reported, for ChatGPT to be asked again.
 */

const TAG_NAME = /^\s*Skill-Groups?-\d+\s*$/i;
/** "Programming & Data Analysis: Python, SQL" → the name, and the skills after it. */
const NAMED = /^\s*([^:\n]{2,80}?)\s*:\s*([\s\S]+)$/;

/** The answer's JSON, also with text around it, and where it was; undefined when there is none. */
function parse(answer) {
  try {
    return { json: JSON.parse(answer), before: '', after: '' };
  } catch {
    const start = answer.indexOf('{');
    const end = answer.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      return { json: JSON.parse(answer.slice(start, end + 1)), before: answer.slice(0, start), after: answer.slice(end + 1) };
    } catch {
      return undefined;
    }
  }
}

/**
 * `answer` with its skill groups named; `unnamed`: the groups still called
 * after a template tag (their value gave no name).
 */
export function nameSkillGroups(answer) {
  const parsed = parse(answer);
  const json = parsed?.json;
  const key = json && typeof json === 'object' && ['technicalskills', 'technicalSkills'].find((k) => json[k]);
  const groups = key ? json[key] : null;
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return { text: answer, unnamed: [] };

  let changed = false;
  const unnamed = [];
  const named = {};
  for (const [name, value] of Object.entries(groups)) {
    const split = TAG_NAME.test(name) && typeof value === 'string' ? NAMED.exec(value) : null;
    if (split && !(split[1] in named)) {
      named[split[1]] = split[2].trim();
      changed = true;
    } else {
      if (TAG_NAME.test(name)) unnamed.push(name.trim());
      named[name] = value;
    }
  }
  if (!changed) return { text: answer, unnamed };
  json[key] = named;
  return { text: `${parsed.before}${JSON.stringify(json, null, 2)}${parsed.after}`, unnamed };
}
