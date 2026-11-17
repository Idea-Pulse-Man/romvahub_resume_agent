/**
 * Romva Apply — runs inside a job's application page, and inside each frame
 * of it that holds the form (puppeteer evaluates it there).
 *
 * Fills in the form from the applicant's Profile, attaches the Resume and
 * cover letter, and shows a small banner. It NEVER submits: the person checks
 * the form and clicks Submit. After that, `submitted()` reports the
 * confirmation page, and the tab is closed by whoever opened it.
 *
 * The desktop agent uses this file. The altv Chrome extension (Romva Apply,
 * Alt+V) uses a copy of it (altv/apply-fill.js): change both together.
 *
 *   window.__romvaApply.state()                → { fields, application, password, signIn, sent }
 *   window.__romvaApply.fill(data)             → { filled, files, unfilledRequired, signIn }   (safe to call again)
 *   window.__romvaApply.submitted()            → true on the "application sent" page
 *   await window.__romvaApply.questions(data)  → the questions still open once the rules have answered what
 *                                                they can: [{ id, kind, question, required, maxLength, multiline, options }]
 *                                                kind: text | one (pick one option) | many (tick any) | tick (one tick box)
 *   await window.__romvaApply.answer(list)     → puts ChatGPT's [{ id, answer }] in; fields the person touched are left alone
 *   window.__romvaApply.notice(text, choices)  → a note in the banner, with buttons [{ value, label }] to choose from
 *   window.__romvaApply.takePick()             → the banner button clicked, once
 *
 * Only empty fields are filled, so calling fill() again as the page renders
 * more of the form never overwrites what the person typed. Gender, race,
 * veteran and disability questions get the Profile's answer; one the Profile
 * leaves empty (or "Prefer not to say"), and any other question that offers
 * "I don't wish to answer" ("Decline to self-identify", "Prefer not to say"…),
 * gets that option, unless it is about work authorisation, sponsorship or
 * relocation. A sign-in page (one with a password box) is never touched.
 */
(() => {
  if (window.__romvaApply) return;

  const norm = (text) =>
    String(text ?? '')
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const esc = (text) =>
    String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** An option meaning "I don't wish to answer": chosen when a question offers one and the Profile has no answer. */
  const DECLINE = /(do not|don't|dont) (wish|want) to|wish not to|decline|prefer not|rather not|choose not to|not to (answer|say|disclose|specify|self[- ]?identify)/;
  /** A placeholder option ("Select…"), not an answer. */
  const PLACEHOLDER = /^(select|choose|please select|pick one|--|—|start typing)/;
  /** "How did you hear about us?" */
  const SOURCE = /how did you (hear|find|learn|come across)|where did you (hear|find|see|learn)|\b(lead|application|referral|candidate) source\b|^source\b/;
  /** Job board options, best first: Jobright AI, then any job board. */
  const JOB_BOARDS = [/job ?right|job ?light/, /job ?board|job site|online job|job (search )?(website|platform)/];
  /** A referrer's name or email: never filled in. */
  const REFERRER = /referr(er|ed by|al name)|who referred|referring (employee|person)|name of (the )?(person|employee) who/;
  /** Salary questions: ChatGPT answers them (the middle of the posted range, else 150000). */
  const SALARY = /salary|compensation|pay (expectation|requirement)|desired (pay|rate)|expected (pay|rate)/;
  /** More options than this (a list of countries) is not sent to ChatGPT. */
  const MAX_OPTIONS = 60;
  /** Everything a person can fill in. */
  const FIELD =
    'input:not([type=hidden]):not([type=password]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=search]), textarea, select';
  const COMBO =
    'input[role=combobox], input[aria-autocomplete=list], input[aria-autocomplete=both], [role=combobox]:not(input):not(select), button[aria-haspopup=listbox]';

  function visible(el) {
    if (!el || el.disabled) return false;
    if (el.type === 'file') return true; // file inputs are often hidden behind a styled button
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function labelElement(el) {
    if (!el) return null;
    return (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label');
  }

  /** Visible itself, or (a styled radio / tick box) through its label. */
  function shown(el) {
    return !!el && !el.disabled && (visible(el) || visible(labelElement(el)));
  }

  /** In the site's header, menu, footer or cookie banner — not part of the application. */
  function inChrome(el) {
    const outer = el.closest(
      'header, nav, footer, [role=navigation], [role=search], [id*="cookie" i], [class*="cookie" i], [id*="onetrust" i]',
    );
    if (!outer) return false;
    const form = el.closest('form');
    return !(form && form.contains(outer));
  }

  function isSearch(el) {
    if (el.type === 'search' || el.getAttribute('role') === 'searchbox') return true;
    return /search|keyword/.test(norm([el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' ')));
  }

  function isCombo(el) {
    return el.matches('[role=combobox], [aria-autocomplete=list], [aria-autocomplete=both]');
  }

  function fields() {
    return Array.from(document.querySelectorAll(FIELD)).filter((el) => shown(el) && !inChrome(el) && !isSearch(el));
  }

  function passwordShown() {
    return Array.from(document.querySelectorAll('input[type=password]')).some(visible);
  }

  /** Everything that says what a field is for: its label, name, id, placeholder, nearby question text. */
  function describe(el) {
    const parts = [
      el.name,
      el.id,
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
      el.getAttribute('autocomplete'),
      el.getAttribute('data-qa'),
    ];
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) parts.push(label.innerText);
    }
    const wrapping = el.closest('label');
    if (wrapping) parts.push(wrapping.innerText);
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const node = document.getElementById(id);
      if (node) parts.push(node.innerText);
    }
    const container = el.closest(
      'fieldset, .field, .form-group, .application-question, [class*="field"], [class*="question"], [class*="Field"], [class*="Question"], li',
    );
    if (container) {
      const legend = container.querySelector('legend, label, [class*="label"], [class*="Label"]');
      if (legend) parts.push(legend.innerText);
      parts.push((container.innerText || '').slice(0, 160));
    }
    return norm(parts.filter(Boolean).join(' | '));
  }

  /** A field's question, as the person reads it: its label, else what is around it. */
  function labelOf(el) {
    const parts = [];
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) parts.push(label.innerText);
    }
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const node = document.getElementById(id);
      if (node && !parts.includes(node.innerText)) parts.push(node.innerText);
    }
    if (!parts.length && el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    if (!parts.length && el.closest('label')) parts.push(el.closest('label').innerText);
    if (!parts.length) {
      let node = el;
      for (let depth = 0; depth < 4 && node.parentElement && !parts.length; depth += 1) {
        node = node.parentElement;
        const text = (node.innerText || '').trim();
        if (text.length > 5) parts.push(text);
      }
    }
    if (!parts.length && el.getAttribute('placeholder')) parts.push(el.getAttribute('placeholder'));
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 600);
  }

  const clean = (label) => String(label || '').replace(/\s*\*\s*$/, '').trim();

  function isRequired(el, label) {
    return (
      !!el.required ||
      el.getAttribute('aria-required') === 'true' ||
      /\*\s*$|\(required\)|\brequired\s*$/i.test(String(label || ''))
    );
  }

  /**
   * A referrer's name or email box: no one referred the applicant, so a name is
   * never written. "N/A" when the box must be filled ("If No, type N/A", or
   * required); otherwise it is left empty.
   */
  function referrerText(el, label) {
    if (el.type === 'email') return undefined; // "N/A" is not an email address: left for the person
    const text = norm(label);
    return /\bn\/?a\b|not applicable/.test(text) || isRequired(el, label) ? 'N/A' : undefined;
  }

  /** Sets a value the way typing would, so React/Vue forms notice it. */
  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    el.focus();
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    mark(el);
  }

  function mark(el) {
    if (!el?.style) return;
    el.style.outline = '2px solid rgba(16,185,129,.7)';
    el.style.outlineOffset = '1px';
  }

  function restoreFocus(before) {
    try {
      if (before && before !== document.body && before.isConnected && typeof before.focus === 'function') {
        before.focus({ preventScroll: true });
      }
    } catch {
      // Not focusable any more.
    }
  }

  const affirmative = (value) => /^(yes|y|true|tick|ticked|check|checked|agree)\b/.test(norm(value));

  /** The text to type into a field described as `d`, or undefined when it is not one we know. */
  function textFor(d, el, a, data) {
    const isTextarea = el.tagName === 'TEXTAREA';
    if (isTextarea && /cover[\s_-]*letter/.test(d)) return data.coverLetterText || undefined;
    if (isTextarea) return undefined; // free-text questions: ChatGPT answers them (questions())
    const own = norm(`${labelOf(el)} ${el.name || ''}`);
    if (REFERRER.test(own)) return referrerText(el, labelOf(el)); // a referrer's name is never written
    if (SOURCE.test(own)) return 'Jobright AI';
    const fixed = fixedAnswer(own);
    if (fixed) return fixed[0];
    if (el.type === 'email' || /e-?mail/.test(d)) return a.email;
    if (el.type === 'tel' || /phone|mobile|\bcell\b/.test(d)) return a.phone;
    if (/linkedin/.test(d)) return a.linkedin;
    if (/github/.test(d)) return a.github;
    if (/portfolio|website|personal (site|url|page)|other (url|link|website)/.test(d)) return a.website;
    if (/preferred|middle|nick ?name/.test(d)) return undefined;
    if (/first[\s_-]*name|given[\s_-]*name|\bfname\b|firstname/.test(d)) return a.firstName;
    if (/last[\s_-]*name|family[\s_-]*name|surname|\blname\b|lastname/.test(d)) return a.lastName;
    if (/current (company|employer)|company name|\borg\b|current organi[sz]ation/.test(d)) return a.currentCompany;
    if (/current (job )?(title|role|position)|job title/.test(d)) return a.currentTitle;
    if (/\b(full[\s_-]*)?name\b|your name|legal name/.test(d) && !/company|employer|school|university|reference|manager|user ?name|recruiter|referr/.test(d)) {
      return a.fullName;
    }
    if (/zip|postal/.test(d)) return a.zipCode;
    if (/\bcity\b/.test(d) && !/state|country/.test(d)) return a.city;
    if (/\b(state|province)\b/.test(d) && !/statement|united states/.test(d)) return a.state;
    if (/\bcountry\b/.test(d)) return a.country;
    if (/address|street/.test(d)) return a.address;
    if (/location|where are you (based|located)|city,? state/.test(d)) return a.location;
    if (/notice period|when can you start|start date|availability to start/.test(d)) return a.noticePeriod;
    return undefined;
  }

  /**
   * Facts fixed for every applicant: a U.S. citizen, not a student, English
   * as the primary language. The answers to try, best first (option lists
   * word them differently); a secondary language is left empty.
   */
  function fixedAnswer(d) {
    if (/\b(secondary|second|other|additional) language/.test(d)) return undefined;
    if (/\b(primary|first|native|main) language\b|mother tongue/.test(d)) return ['English'];
    if (/\b(full|part)[\s-]?time student\b|\bare you (currently )?an? (current |enrolled )?student\b|\bcurrently (an? )?(student|enrolled)\b|\benrolled (as a student|in (an? )?(school|college|university|degree))/.test(d)) {
      return ['No'];
    }
    // "Are you a citizen of Cuba, Iran…?" (export control) is not about U.S. citizenship: ChatGPT answers it.
    // Whole phrases only: `d` may hold the field's option texts ("Other", "Non-U.S. Citizen").
    if (/sanction|embargo|export control|\bitar\b|\bofac\b|\bcuba\b|\biran\b|north korea|\bsyria\b|crimea/.test(d)) return undefined;
    if (/dual (citizen|national)|(other|another|additional|second|any) (countr(y|ies)|citizenships?|nationalit(y|ies))\b/.test(d)) return undefined;
    if (/countr(y|ies) of (your )?citizenship|citizenship country|\bnationality\b/.test(d)) {
      return ['United States', 'United States of America', 'USA', 'U.S.'];
    }
    if (/citizen/.test(d)) {
      return ['U.S. Citizen', 'US Citizen', 'United States Citizen', 'Citizen of the United States', 'Yes'];
    }
    return undefined;
  }

  /** Questions with a fixed answer for this applicant, which "I don't wish to answer" never overrides. */
  function ruleAnswer(d, a) {
    // The applicant never needs a visa sponsored, for any country.
    if (/sponsor/.test(d)) return 'No';
    const fixed = fixedAnswer(d);
    if (fixed) return fixed;
    if (/authori[sz]ed to work|legally (authori[sz]ed|eligible|able)|eligible to work|right to work/.test(d)) {
      return (a.authorizedCountries ?? []).length > 0 ? 'Yes' : undefined;
    }
    // The applicant does not want to move for work.
    if (/relocat/.test(d)) return 'No';
    return undefined;
  }

  /** A Profile value meaning "I don't wish to answer" (or none): the question gets the form's decline option. */
  const unset = (value) => !norm(value) || DECLINE.test(norm(value)) || /^other$/.test(norm(value));

  /**
   * The Profile's EEO choices (romva.space Profile → Male / Asian / I am not a
   * veteran / No, I do not have a disability…) in the words job forms use for
   * them, best first.
   */
  function genderAnswers(value) {
    const v = norm(value);
    if (unset(v)) return [];
    if (/^(male|man)$/.test(v)) return ['Male', 'Man', 'Cisgender man', 'Cis man'];
    if (/^(female|woman)$/.test(v)) return ['Female', 'Woman', 'Cisgender woman', 'Cis woman'];
    if (/non[\s-]?binary/.test(v)) return ['Non-binary', 'Nonbinary', 'Non binary', 'Genderqueer'];
    return [value];
  }

  function raceAnswers(value) {
    const v = norm(value);
    if (unset(v)) return [];
    // The last answer serves "Are you Hispanic or Latino?" (Yes / No).
    if (/hispanic|latin/.test(v)) return ['Hispanic or Latino', 'Hispanic/Latino', 'Hispanic', 'Latino', 'Latinx', 'Yes'];
    const words = {
      asian: ['Asian'],
      white: ['White', 'Caucasian'],
      black: ['Black or African American', 'Black', 'African American'],
      'american indian': ['American Indian or Alaska Native', 'American Indian', 'Native American'],
      'native hawaiian': ['Native Hawaiian or Other Pacific Islander', 'Native Hawaiian', 'Pacific Islander'],
      'two or more': ['Two or More Races', 'Two or more', 'Multiracial', 'Multi-racial'],
    };
    const key = Object.keys(words).find((k) => v.includes(k));
    return [...new Set([value, ...(key ? words[key] : []), 'No'])];
  }

  function veteranAnswers(value) {
    const v = norm(value);
    if (unset(v)) return [];
    if (/\bnot\b|^no\b/.test(v)) {
      return [
        'I am not a veteran',
        'I am not a protected veteran',
        "I don't identify as a protected veteran",
        'I do not identify as a protected veteran',
        'I identify as not a protected veteran',
        'Not a protected veteran',
        'Not a veteran',
        'No',
      ];
    }
    return ['I am a veteran', 'I am a protected veteran', 'I identify as one or more of the classifications of protected veteran', 'Protected veteran', 'Yes'];
  }

  function disabilityAnswers(value) {
    const v = norm(value);
    if (unset(v)) return [];
    if (/^no\b|do not|don't/.test(v)) {
      return ['No, I do not have a disability', "No, I don't have a disability", 'I do not have a disability', "I don't have a disability", 'No'];
    }
    return ['Yes, I have a disability', 'Yes, I have a disability (or previously had a disability)', 'I have a disability', 'Yes'];
  }

  /**
   * Answers from the Profile, best first; tried before the form's "I don't
   * wish to answer". When the description names several (a field's text runs
   * into its neighbours'), the one named first comes first.
   */
  function profileAnswer(d, a) {
    const found = [];
    const add = (pattern, answers) => {
      const at = d.search(pattern);
      if (at >= 0 && answers.length) found.push([at, answers]);
    };
    add(/\bgender\b|\bsex\b/, genderAnswers(a.gender));
    add(/\brace\b|ethnic|hispanic|latin[oax]/, raceAnswers(a.ethnicity));
    add(/veteran/, veteranAnswers(a.veteranStatus));
    add(/disabilit/, disabilityAnswers(a.disabilityStatus));
    add(/country/, a.country ? [a.country] : []);
    add(/\bstate\b|province/, a.state ? [a.state] : []);
    return found.sort((x, y) => x[0] - y[0]).flatMap(([, answers]) => answers);
  }

  const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** Whether `phrase` appears in `text` as whole words ("no" is not in "latino"). */
  const hasWords = (text, phrase) => new RegExp(`(^|[^a-z0-9])${escapeRe(phrase)}([^a-z0-9]|$)`).test(text);
  const usable = (options) => options.filter((o) => o.text && !PLACEHOLDER.test(o.text));

  /** The option (or radio) whose text best matches the answer: exact, then starts with it, then contains it as words. */
  function pick(options, answer) {
    const want = norm(answer).replace(/[.!]+$/, '');
    if (!want) return null;
    const list = usable(options);
    return (
      list.find((o) => o.text === want) ||
      list.find((o) => o.text.startsWith(want) && hasWords(o.text, want)) ||
      list.find((o) => hasWords(o.text, want)) ||
      list.find((o) => o.text.length > 3 && hasWords(want, o.text)) ||
      null
    );
  }

  /** The option matching the first answer that matches any. */
  function pickAny(options, answers) {
    for (const answer of [].concat(answers ?? [])) {
      const option = pick(options, answer);
      if (option) return option;
    }
    return null;
  }

  /** The option the rules choose: a fixed answer, else the Profile's (gender, race…), else "I don't wish to answer". */
  function choose(question, options, a) {
    const list = usable(options);
    if (SOURCE.test(question)) {
      for (const board of JOB_BOARDS) {
        const option = list.find((o) => board.test(o.text));
        if (option) return option;
      }
    }
    return (
      pickAny(list, ruleAnswer(question, a)) ||
      pickAny(list, profileAnswer(question, a)) ||
      list.find((o) => DECLINE.test(o.text)) ||
      null
    );
  }

  /** A "select all that apply" group the Profile answers (race), else its "I don't wish to answer". */
  function chooseInGroup(group, a) {
    const options = choicesOf(group.members);
    return pickAny(options, profileAnswer(norm(questionAround(group.key, group.members)), a)) || options.find((o) => DECLINE.test(o.text)) || null;
  }

  /** Radios / tick boxes as options: { el, text (for matching), label (as shown) }. */
  function choicesOf(inputs) {
    return inputs.map((input) => {
      const label = labelElement(input);
      const raw = (label?.innerText || input.getAttribute('aria-label') || input.value || '').replace(/\s+/g, ' ').trim();
      return { el: input, text: norm(raw), label: raw };
    });
  }

  function optionsOf(select) {
    return Array.from(select.options, (o) => ({ el: o, text: norm(o.text), label: o.text.replace(/\s+/g, ' ').trim() }));
  }

  /**
   * A choice question's own wording — its heading or label — without the text
   * of its answers, so "Race: … Hispanic or Latino …" is read as a race
   * question, not as the Hispanic yes/no one.
   */
  function questionOf(container, members) {
    if (!container) return '';
    const own = members.map(labelElement).filter(Boolean);
    const isOwn = (node) =>
      members.some((m) => node.contains(m) || m.contains(node)) || own.some((l) => l === node || l.contains(node) || node.contains(l));
    const heading = Array.from(
      container.querySelectorAll('legend, h1, h2, h3, h4, h5, label, [class*="label"], [class*="Label"], [class*="title"], [class*="question"]'),
    ).find((node) => norm(node.innerText) && !isOwn(node));
    if (heading) return norm(heading.innerText).slice(0, 300);
    let text = container.innerText || '';
    for (const node of [...own, ...members]) if (node.innerText) text = text.replace(node.innerText, ' ');
    return norm(text).slice(0, 300);
  }

  /** The question a group of options answers, looked for in ever wider blocks that hold no other field. */
  function questionAround(start, members) {
    const others = fields().filter((el) => !members.includes(el));
    let node = start;
    let top = start;
    for (let depth = 0; node && node !== document.body && depth < 5; depth += 1, node = node.parentElement) {
      if (others.some((el) => node.contains(el))) break;
      top = node;
      const question = questionOf(node, members);
      if (question.length > 3) return question;
    }
    // A flat form: the question is the text just before the options.
    for (let sib = top?.previousElementSibling, i = 0; sib && i < 3; sib = sib.previousElementSibling, i += 1) {
      const text = norm(sib.innerText);
      if (text && !others.some((el) => sib.contains(el))) return text.slice(0, 300);
    }
    return '';
  }

  function base64File(file, type) {
    const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    return new File([bytes], file.name, { type });
  }

  function attach(input, file) {
    const transfer = new DataTransfer();
    transfer.items.add(base64File(file, 'application/pdf'));
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    mark(input.closest('label, div') || input);
  }

  const attached = new WeakSet();
  const clickedGroups = new WeakSet();
  const doneGroups = new WeakSet();

  /** A button that looks chosen: pressed, checked, or styled as active/selected. */
  function selected(button) {
    if (/^(true|mixed)$/.test(button.getAttribute('aria-pressed') || '')) return true;
    if (button.getAttribute('aria-checked') === 'true' || button.getAttribute('aria-selected') === 'true') return true;
    if (/^(on|checked|active|selected)$/.test(button.getAttribute('data-state') || '')) return true;
    return /(^|[\s_-])(active|selected|checked|is-?selected|pressed)([\s_-]|$)/i.test(String(button.className || ''));
  }

  /**
   * Groups of 2–6 short sibling buttons answering one question ("Yes" / "No"),
   * with the question read from the surrounding field. Submit and navigation
   * buttons are never part of one.
   */
  function buttonGroups() {
    const parents = new Set();
    for (const button of document.querySelectorAll('button, [role=button], [role=radio]')) {
      if (visible(button) && button.parentElement && !inChrome(button)) parents.add(button.parentElement);
    }
    const groups = [];
    for (const parent of parents) {
      const buttons = Array.from(parent.children).filter(
        (child) => child.matches('button, [role=button], [role=radio]') && visible(child),
      );
      if (buttons.length < 2 || buttons.length > 6) continue;
      if (buttons.some((b) => b.type === 'submit' || !norm(b.innerText) || norm(b.innerText).length > 40)) continue;
      if (buttons.some((b) => /submit|apply|next|back|continue|save|cancel|upload|attach|remove|replace/.test(norm(b.innerText)))) continue;
      if (buttons.some((b) => b.getAttribute('aria-haspopup'))) continue;
      let container = parent;
      let question = '';
      for (let depth = 0; depth < 4 && container.parentElement; depth += 1) {
        container = container.parentElement;
        // The field's own label or legend, when it has one ("Gender").
        const heading = Array.from(container.querySelectorAll('label, legend, [class*="label"], [class*="Label"]')).find(
          (node) => !node.contains(parent) && norm(node.innerText),
        );
        if (heading) {
          question = norm(heading.innerText).slice(0, 300);
          break;
        }
        let text = container.innerText || '';
        for (const b of buttons) text = text.replace(b.innerText, ' ');
        question = norm(text).slice(0, 300);
        if (question.length > 3) break;
      }
      if (question) groups.push({ parent, buttons, question });
    }
    return groups;
  }

  function radioGroups() {
    const groups = new Map();
    for (const el of document.querySelectorAll('input[type=radio]')) {
      if (!el.name || inChrome(el)) continue;
      if (!groups.has(el.name)) groups.set(el.name, []);
      groups.get(el.name).push(el);
    }
    return [...groups.values()].filter((radios) => radios.some(shown));
  }

  function commonParent(els) {
    let node = els[0].parentElement;
    while (node && !els.every((el) => node.contains(el))) node = node.parentElement;
    return node || document.body;
  }

  /** Tick boxes, grouped by question: by name, else the block around them that holds nothing but tick boxes. */
  function checkboxGroups() {
    const boxes = Array.from(document.querySelectorAll('input[type=checkbox]')).filter((el) => shown(el) && !inChrome(el));
    const seen = new Set();
    const groups = [];
    for (const box of boxes) {
      if (seen.has(box)) continue;
      let members = box.name ? boxes.filter((other) => other.name === box.name && !seen.has(other)) : [box];
      if (members.length === 1) {
        for (let node = box.parentElement, depth = 0; node && node !== document.body && depth < 6; node = node.parentElement, depth += 1) {
          const inside = Array.from(node.querySelectorAll(FIELD)).filter(shown);
          if (inside.length <= 1) continue;
          if (inside.every((el) => el.type === 'checkbox')) members = inside.filter((el) => boxes.includes(el) && !seen.has(el));
          break;
        }
      }
      for (const member of members) seen.add(member);
      groups.push({ members, key: commonParent(members) });
    }
    return groups;
  }

  // ---- Custom drop-downs (react-select, Workday's lists…): opened to read their options ----

  function combos() {
    const found = new Set();
    for (const el of document.querySelectorAll(COMBO)) {
      if (!shown(el) || inChrome(el) || isSearch(el) || el.closest('[role=listbox]')) continue;
      if (el.tagName !== 'INPUT' && el.querySelector('input[role=combobox], input[aria-autocomplete]')) continue;
      found.add(el);
    }
    return [...found];
  }

  /** What the drop-down shows as chosen; '' while it still shows its placeholder. */
  function comboValue(el) {
    const control = el.closest('[class*="control"], [class*="Control"]');
    if (control) {
      const placeholder = control.querySelector('[class*="placeholder"], [class*="Placeholder"]');
      if (placeholder && visible(placeholder)) return '';
      const text = norm(control.innerText);
      return PLACEHOLDER.test(text) ? '' : text;
    }
    if (el.tagName === 'INPUT') return norm(el.value);
    const text = norm(el.innerText);
    return PLACEHOLDER.test(text) ? '' : text;
  }

  function allOptions() {
    return Array.from(document.querySelectorAll('[role=option]')).filter(visible);
  }

  /** The options that appeared since `before` (so a list already on the page is never taken for this one's). */
  function comboOptionEls(el, before) {
    const fresh = (list) => list.filter((o) => visible(o) && !before.has(o) && !el.contains(o));
    for (const node of [el, el.querySelector?.('input')].filter(Boolean)) {
      for (const id of `${node.getAttribute('aria-controls') || ''} ${node.getAttribute('aria-owns') || ''}`.split(/\s+/).filter(Boolean)) {
        const list = document.getElementById(id);
        const found = list ? fresh(Array.from(list.querySelectorAll('[role=option]'))) : [];
        if (found.length) return found;
      }
    }
    const options = fresh(Array.from(document.querySelectorAll('[role=option]')));
    if (options.length) return options;
    return fresh(Array.from(document.querySelectorAll('[class*="menu"] [class*="option"]'))).filter(
      (o) => !o.querySelector('[class*="option"]'),
    );
  }

  const key = (el, name, code) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, keyCode: code, which: code, bubbles: true, cancelable: true }));

  /** Opens the drop-down; its options, or [] when none appeared (a search-as-you-type box). */
  async function comboOpen(el) {
    const before = new Set(allOptions());
    if (el.tagName === 'INPUT') {
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0 }));
    } else {
      el.focus?.();
      el.click();
    }
    for (let i = 0; i < 8; i += 1) {
      await wait(100);
      const found = comboOptionEls(el, before);
      if (found.length) return found;
    }
    key(el.tagName === 'INPUT' ? el : el.querySelector('input') || el, 'ArrowDown', 40);
    for (let i = 0; i < 8; i += 1) {
      await wait(100);
      const found = comboOptionEls(el, before);
      if (found.length) return found;
    }
    return [];
  }

  function comboClose(el) {
    key(el.tagName === 'INPUT' ? el : el.querySelector('input') || el, 'Escape', 27);
    if (el.tagName === 'INPUT') el.blur();
  }

  async function comboChoose(el, answer) {
    const options = await comboOpen(el);
    const option = pick(
      options.map((o) => ({ el: o, text: norm(o.innerText) })),
      answer,
    );
    if (!option) {
      comboClose(el);
      return false;
    }
    option.el.scrollIntoView?.({ block: 'nearest' });
    option.el.click();
    await wait(200);
    if (!comboValue(el)) {
      comboClose(el);
      return false;
    }
    mark(el.closest('[class*="control"], [class*="Control"]') || el);
    return true;
  }

  const comboSeen = new WeakMap(); // drop-down → its options, read once

  // ---- Questions for ChatGPT ----

  const docKey = Math.random().toString(36).slice(2, 7);
  let nextId = 1;
  const ids = new WeakMap();
  const registry = new Map(); // id → what to fill and how

  function register(keyEl, entry, found) {
    let id = ids.get(keyEl);
    if (!id) {
      id = `${docKey}-${nextId++}`;
      ids.set(keyEl, id);
    }
    registry.set(id, entry);
    found.push({
      id,
      kind: entry.kind,
      question: entry.question,
      required: !!entry.required,
      maxLength: entry.maxLength ?? null,
      multiline: !!entry.multiline,
      ...(entry.options ? { options: entry.options.map((o) => o.label) } : {}),
    });
  }

  function selectOption(el, option) {
    el.value = option.el.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    mark(el);
  }

  async function questions(data) {
    const a = data?.applicant || {};
    if (passwordShown()) return [];
    view.form = view.form || fields().length > 0;
    const found = [];
    let settled = 0;

    // Text boxes, and the required one-line fields fill() left empty.
    for (const el of document.querySelectorAll('textarea, input:not([type]), input[type=text], input[type=number]')) {
      if (!visible(el) || el.readOnly || isCombo(el) || isSearch(el) || inChrome(el) || String(el.value || '').trim()) continue;
      const label = labelOf(el);
      const question = clean(label);
      if (!question) continue;
      const required = isRequired(el, label);
      const asked = norm(question);
      if (el.tagName !== 'TEXTAREA' && !required && !SALARY.test(asked)) continue;
      if (/cover[\s_-]*letter/.test(asked)) continue;
      if (REFERRER.test(asked)) {
        const text = referrerText(el, label);
        if (text) {
          setValue(el, text);
          settled += 1;
        }
        continue;
      }
      if (SOURCE.test(asked) && el.tagName !== 'TEXTAREA') {
        setValue(el, 'Jobright AI');
        settled += 1;
        continue;
      }
      register(
        el,
        { kind: 'text', el, question, required, maxLength: el.maxLength > 0 ? el.maxLength : null, multiline: el.tagName === 'TEXTAREA' },
        found,
      );
    }

    // Drop-downs.
    for (const el of document.querySelectorAll('select')) {
      if (!shown(el) || inChrome(el) || (el.value && el.selectedIndex > 0)) continue;
      const options = usable(optionsOf(el));
      if (!options.length) continue;
      const local = choose(describe(el), options, a);
      if (local) {
        selectOption(el, local);
        settled += 1;
        continue;
      }
      const label = labelOf(el);
      if (options.length > MAX_OPTIONS || !clean(label)) continue;
      register(el, { kind: 'one', via: 'select', el, options, question: clean(label), required: isRequired(el, label) }, found);
    }

    // Radio groups.
    for (const radios of radioGroups()) {
      if (radios.some((r) => r.checked)) continue;
      const options = usable(choicesOf(radios));
      const question = questionAround(radios[0].parentElement, radios);
      const local = choose(question, options, a);
      if (local) {
        local.el.click();
        mark(labelElement(local.el) || local.el);
        settled += 1;
        continue;
      }
      if (!question || !options.length || options.length > MAX_OPTIONS) continue;
      register(
        radios[0],
        { kind: 'one', via: 'radio', members: radios, options, question, required: radios.some((r) => r.required) || /\*/.test(question) },
        found,
      );
    }

    // Tick boxes: a group ("select all that apply"), or one box on its own ("I agree…").
    for (const group of checkboxGroups()) {
      if (group.members.some((c) => c.checked) || doneGroups.has(group.key)) continue;
      const options = choicesOf(group.members);
      if (group.members.length > 1) {
        const chosen = chooseInGroup(group, a);
        if (chosen) {
          chosen.el.click();
          doneGroups.add(group.key);
          mark(labelElement(chosen.el) || chosen.el);
          settled += 1;
          continue;
        }
        const question = questionAround(group.key, group.members);
        if (!question || options.length > MAX_OPTIONS) continue;
        register(group.key, { kind: 'many', members: group.members, options, question, required: /\*/.test(question) }, found);
      } else {
        const box = group.members[0];
        const label = options[0].label;
        if (!label) continue;
        const around = questionAround(box.parentElement, [box]);
        const question = around && !norm(label).includes(around) ? `${around}: ${label}` : label;
        register(box, { kind: 'tick', el: box, question, required: box.required || box.getAttribute('aria-required') === 'true' }, found);
      }
    }

    // Yes / No drawn as buttons.
    for (const group of buttonGroups()) {
      if (clickedGroups.has(group.parent) || group.buttons.some(selected)) continue;
      const options = usable(group.buttons.map((b) => ({ el: b, text: norm(b.innerText), label: b.innerText.replace(/\s+/g, ' ').trim() })));
      const local = choose(group.question, options, a);
      if (local) {
        local.el.click();
        clickedGroups.add(group.parent);
        mark(local.el);
        settled += 1;
        continue;
      }
      register(group.parent, { kind: 'one', via: 'buttons', group, options, question: group.question, required: /\*/.test(group.question) }, found);
    }

    // Custom drop-downs: opened once to read their options, then closed.
    const before = document.activeElement;
    for (const el of combos()) {
      if (comboValue(el)) continue;
      let options = comboSeen.get(el);
      if (!options) {
        const opened = await comboOpen(el);
        options = opened.map((o) => ({ text: norm(o.innerText), label: o.innerText.replace(/\s+/g, ' ').trim() })).filter((o) => o.text);
        comboClose(el);
        comboSeen.set(el, options);
        await wait(100);
      }
      const list = usable(options);
      if (!list.length) continue; // search-as-you-type (a city): left to the person
      const label = labelOf(el);
      const question = clean(label);
      const local = choose(norm(question), list, a);
      if (local) {
        if (await comboChoose(el, local.label)) settled += 1;
        continue;
      }
      if (!question || list.length > MAX_OPTIONS) continue;
      register(el, { kind: 'one', via: 'combo', el, options: list, question, required: isRequired(el, label) }, found);
    }
    restoreFocus(before);

    if (settled) count(settled);
    return found;
  }

  async function put(entry, values) {
    if (entry.kind === 'text') {
      const el = entry.el;
      if (!el.isConnected || String(el.value || '').trim()) return false;
      const text = values.join('\n');
      setValue(el, el.maxLength > 0 ? text.slice(0, el.maxLength) : text);
      return true;
    }
    if (entry.kind === 'tick') {
      const el = entry.el;
      if (!el.isConnected || el.checked || !affirmative(values[0])) return false;
      el.click();
      mark(labelElement(el) || el);
      return true;
    }
    if (entry.kind === 'many') {
      if (entry.members.some((m) => m.checked)) return false;
      let wanted = values;
      if (wanted.length === 1 && !pick(entry.options, wanted[0])) wanted = wanted[0].split(/\s*[,;]\s*/);
      let ticked = 0;
      for (const value of wanted) {
        const option = pick(entry.options, value);
        if (option && !option.el.checked) {
          option.el.click();
          mark(labelElement(option.el) || option.el);
          ticked += 1;
        }
      }
      return ticked > 0;
    }
    // One option.
    const option = pick(entry.options, values[0]);
    if (!option) return false;
    if (entry.via === 'select') {
      if (entry.el.value && entry.el.selectedIndex > 0) return false;
      selectOption(entry.el, option);
      return true;
    }
    if (entry.via === 'radio') {
      if (entry.members.some((r) => r.checked)) return false;
      option.el.click();
      mark(labelElement(option.el) || option.el);
      return true;
    }
    if (entry.via === 'buttons') {
      if (clickedGroups.has(entry.group.parent) || entry.group.buttons.some(selected)) return false;
      option.el.click();
      clickedGroups.add(entry.group.parent);
      mark(option.el);
      return true;
    }
    if (entry.via === 'combo') {
      if (!entry.el.isConnected || comboValue(entry.el)) return false;
      return comboChoose(entry.el, option.label);
    }
    return false;
  }

  /** Puts ChatGPT's answers in; a field the person has already filled is left alone. */
  async function answer(list) {
    const before = document.activeElement;
    let typed = 0;
    for (const item of list || []) {
      const entry = registry.get(String(item?.id ?? ''));
      if (!entry) continue;
      const values = (Array.isArray(item.answer) ? item.answer : [item.answer]).map((v) => String(v ?? '').trim()).filter(Boolean);
      if (!values.length) continue;
      try {
        if (await put(entry, values)) typed += 1;
      } catch {
        // Left for the person.
      }
    }
    restoreFocus(before);
    if (typed) count(typed);
    return typed;
  }

  // ---- Filling from the Profile ----

  function fill(data) {
    const a = data.applicant || {};
    view.company = data.company || view.company;
    if (passwordShown()) return { filled: 0, files: 0, unfilledRequired: 0, signIn: true };
    let filled = 0;
    let files = 0;

    // Text fields and text areas.
    for (const el of document.querySelectorAll('input:not([type]), input[type=text], input[type=email], input[type=tel], input[type=url], textarea')) {
      if (!visible(el) || el.readOnly || isCombo(el) || isSearch(el) || inChrome(el) || String(el.value || '').trim()) continue;
      const value = textFor(describe(el), el, a, data);
      if (value) {
        setValue(el, value);
        filled += 1;
      }
    }

    // Drop-downs.
    for (const el of document.querySelectorAll('select')) {
      if (!visible(el) || inChrome(el) || (el.value && el.selectedIndex > 0)) continue;
      const option = choose(describe(el), optionsOf(el), a);
      if (option) {
        selectOption(el, option);
        filled += 1;
      }
    }

    // Radio groups.
    for (const radios of radioGroups()) {
      if (radios.some((r) => r.checked)) continue;
      const option = choose(questionAround(radios[0].parentElement, radios), choicesOf(radios), a);
      if (option) {
        option.el.click();
        mark(labelElement(option.el) || option.el);
        filled += 1;
      }
    }

    // Choice buttons: "Yes / No" (and the like) drawn as buttons, not radios.
    for (const group of buttonGroups()) {
      if (clickedGroups.has(group.parent) || group.buttons.some(selected)) continue;
      const option = choose(
        group.question,
        group.buttons.map((button) => ({ el: button, text: norm(button.innerText) })),
        a,
      );
      if (option) {
        option.el.click();
        clickedGroups.add(group.parent);
        mark(option.el);
        filled += 1;
      }
    }

    // "Select all that apply" groups: the Profile's answer (race), else "I don't wish to answer".
    for (const group of checkboxGroups()) {
      if (group.members.length < 2 || doneGroups.has(group.key) || group.members.some((c) => c.checked)) continue;
      const chosen = chooseInGroup(group, a);
      if (chosen) {
        chosen.el.click();
        doneGroups.add(group.key);
        mark(labelElement(chosen.el) || chosen.el);
        filled += 1;
      }
    }

    // Resume and cover letter uploads.
    const fileInputs = Array.from(document.querySelectorAll('input[type=file]')).filter((el) => !el.disabled);
    let resumePlaced = false;
    for (const el of fileInputs) {
      if (attached.has(el) || (el.files && el.files.length)) {
        resumePlaced ||= !/cover/.test(describe(el));
        continue;
      }
      const d = describe(el);
      let file = null;
      if (/cover/.test(d)) file = data.coverLetter;
      else if (/resume|\bcv\b|curriculum/.test(d) || !resumePlaced) file = data.resume;
      if (file) {
        attach(el, file);
        attached.add(el);
        files += 1;
        if (file === data.resume) resumePlaced = true;
      }
    }

    const unfilledRequired = Array.from(
      document.querySelectorAll('input[required], textarea[required], select[required], [aria-required="true"]'),
    ).filter(
      (el) =>
        visible(el) &&
        !(el.type === 'file' ? el.files?.length : String(el.value || '').trim()) &&
        !(isCombo(el) && comboValue(el)), // a drop-down shows its choice outside its (empty) text box
    ).length;

    view.form = view.form || fields().length > 0;
    view.filled += filled;
    view.files += files;
    view.unfilledRequired = unfilledRequired;
    render();
    return { filled, files, unfilledRequired, signIn: false };
  }

  // ---- What is on the page ----

  function state() {
    const list = fields();
    const text = norm(`${document.title} ${(document.body?.innerText || '').slice(0, 5000)}`);
    return {
      fields: list.length,
      // An application form, not a sign-in box or a newsletter field.
      application: list.some((el) => el.type === 'file' || el.tagName === 'TEXTAREA') || list.length >= 4,
      password: passwordShown(),
      signIn: /\b(sign ?in|log ?in|sign ?up|create (an |your )?account|register)\b/.test(text),
      sent: submitted(),
    };
  }

  /** The "application sent" page: thank-you wording, and no application form left on it. */
  function submitted() {
    const text = norm((document.body?.innerText || '').slice(0, 20000));
    const said =
      /thank(s| you) for (applying|your application|submitting)|application (has been |was )?(successfully )?(submitted|received|sent)|we('ve| have) received your application|your application (has been|was) (submitted|received|sent)|successfully applied|application complete/.test(
        text,
      );
    const byUrl = /\/(thanks|thank-you|thankyou|confirmation|submitted|success)(\/|\?|$)/i.test(location.pathname + location.search);
    const formLeft = Array.from(document.querySelectorAll('input[type=file], input[type=email]')).some(visible);
    return (said || byUrl) && !formLeft;
  }

  // ---- The banner ----

  const view = { company: '', filled: 0, files: 0, unfilledRequired: 0, form: false, note: '', choices: [] };
  let picked = null;

  function count(n) {
    view.filled += n;
    render();
  }

  function render() {
    if (!view.form && !view.note) return; // nothing to say (a sign-in page, a page still loading)
    let host = document.getElementById('romva-apply-banner');
    if (!host) {
      host = document.createElement('div');
      host.id = 'romva-apply-banner';
      host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:360px';
      host.attachShadow({ mode: 'open' });
      document.documentElement.appendChild(host);
    }
    const summary = view.form
      ? `filled ${view.filled} field(s)${view.files ? ` and attached ${view.files} file(s)` : ''}${view.company ? ` for <em>${esc(view.company)}</em>` : ''}.`
      : '';
    const left =
      view.form && view.unfilledRequired
        ? `<div style="color:#fbbf24;margin-top:4px">${view.unfilledRequired} required field(s) still empty.</div>`
        : '';
    const note = view.note ? `<div style="margin-top:6px;color:#f8fafc">${esc(view.note)}</div>` : '';
    const choices = view.choices.length
      ? `<div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">${view.choices
          .map(
            (c) =>
              `<button data-pick="${esc(c.value)}" style="font:inherit;text-align:left;cursor:pointer;background:#1e293b;color:#e5e7eb;border:1px solid #334155;border-radius:6px;padding:6px 8px">${esc(c.label)}</button>`,
          )
          .join('')}</div>`
      : '';
    const help = view.form
      ? '<div style="margin-top:4px;color:#94a3b8">Check everything, answer the rest, then click Submit yourself. This tab closes after the application is sent.</div>'
      : '';
    host.shadowRoot.innerHTML = `
      <div style="font:13px/1.45 system-ui,Segoe UI,sans-serif;background:#0f172a;color:#e5e7eb;border:1px solid #10b981;border-radius:10px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.35)">
        <strong style="color:#34d399">Romva</strong> ${summary}${left}${note}${choices}${help}
      </div>`;
    for (const button of host.shadowRoot.querySelectorAll('[data-pick]')) {
      button.addEventListener('click', () => {
        picked = button.dataset.pick;
        view.choices = [];
        view.note = 'Got it. Filling this in…';
        render();
      });
    }
  }

  function notice(text, choices = []) {
    view.note = String(text || '');
    view.choices = Array.isArray(choices) ? choices : [];
    render();
  }

  function takePick() {
    const value = picked;
    picked = null;
    return value;
  }

  window.__romvaApply = { state, fill, submitted, questions, answer, notice, takePick };
})();
