/**
 * The AI websites the agent can ask, each in the agent's own Chrome window,
 * signed in with the person's own account (config.json "ai"). Everything that
 * differs between them is here; chat.js drives any of them the same way.
 *
 * In-page code is source text (run with page.evaluate), so nothing is
 * rewritten by a bundler on the way in.
 */

const SEND = [
  'button[data-testid="send-button"]',
  '#composer-submit-button',
  'button[aria-label="Send message"]',
  'button[aria-label="Send Message"]',
  'button[aria-label="Send prompt"]',
].join(', ');

/** A "Log in" / "Sign in" button or link on the page. */
const SIGN_IN_BUTTON = `Array.from(document.querySelectorAll('button, a')).some((el) =>
  /^(log in|sign in)$/i.test((el.innerText || el.getAttribute('aria-label') || '').trim()))`;

export const SITES = {
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    host: 'chatgpt.com',
    home: 'https://chatgpt.com/',
    isSite: /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//,
    /** Pages a sign-in goes through: the person may be signing in there. */
    signInPages: /^https:\/\/(auth\.openai\.com|auth0\.openai\.com|accounts\.google\.com|appleid\.apple\.com|login\.live\.com|login\.microsoftonline\.com)\//,
    /** `base`: config.json chrome.url. A temporary chat, and Web search chosen by chatgpt.com's own link. */
    newChatUrl(base, { temporary, webSearch }) {
      const url = new URL(base || this.home);
      if (temporary) url.searchParams.set('temporary-chat', 'true');
      if (webSearch) url.searchParams.set('hints', 'search');
      return url.toString();
    },
    composer: '#prompt-textarea, textarea[name="prompt"], #mobile-composer-prompt, [contenteditable="true"][role="textbox"]',
    send: SEND,
    /** A tool chosen for the chat before it is sent, as a pill at the start of the message box ("Web search"). */
    toolPill: '[data-system-hint-type]',
    searchPill: '[data-system-hint-type="search"]',
    /**
     * The sign-in as chatgpt.com's own session endpoint has it, fetched fresh:
     * 'in', 'out', or 'unknown'. Right even on a tab still loading (which shows
     * "Log in" for a moment) or one open since before a sign-out.
     */
    session: `(async () => {
      try {
        const response = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (!response.ok) return 'unknown';
        const session = await response.json();
        if (!session || typeof session !== 'object') return 'unknown';
        if (session.user || session.accessToken) return 'in';
        return Object.keys(session).length === 0 ? 'out' : 'unknown';
      } catch {
        return 'unknown';
      }
    })()`,
    freshChat: `(() => !location.pathname.startsWith('/c/')
      && document.querySelectorAll('pre').length === 0
      && !/(You said:|ChatGPT said:)/.test(document.body.innerText || ''))()`,
    /**
     * The reply is what follows chatgpt.com's last "ChatGPT said:" heading
     * (for screen readers, in front of each reply): chatgpt.com marks turns no
     * other way. Never the question — a long one is folded ("Show more").
     */
    replyHeading: '^\\s*ChatGPT said:?\\s*$',
  },

  claude: {
    id: 'claude',
    name: 'Claude',
    host: 'claude.ai',
    home: 'https://claude.ai/new',
    isSite: /^https:\/\/claude\.ai\//,
    signInPages: /^https:\/\/(claude\.ai\/login|accounts\.google\.com|appleid\.apple\.com)/,
    /** An incognito chat keeps it out of the chat list. Web search is claude.ai's own setting (it stays on once turned on). */
    newChatUrl(_base, { temporary }) {
      return temporary ? 'https://claude.ai/new?incognito' : 'https://claude.ai/new';
    },
    composer: 'div[contenteditable="true"].ProseMirror, [contenteditable="true"][aria-label*="prompt" i], div[contenteditable="true"][role="textbox"]',
    send: SEND,
    session: `(async () => {
      if (location.pathname.startsWith('/login')) return 'out';
      try {
        const response = await fetch('/api/organizations', { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (response.status === 401 || response.status === 403) return 'out';
        if (!response.ok) return 'unknown';
        const organizations = await response.json();
        return Array.isArray(organizations) && organizations.length ? 'in' : 'unknown';
      } catch {
        return 'unknown';
      }
    })()`,
    freshChat: `(() => !document.querySelector('[data-is-streaming], .font-claude-response, .font-claude-message, [data-testid="user-message"]'))()`,
    /** Each reply is its own element, marked while it is written. */
    replySelector: '[data-is-streaming], .font-claude-response',
    streamingSelector: '[data-is-streaming="true"]',
    webSearchNote: 'Claude: Web search is a claude.ai setting. Turn it on once in the tools menu under the message box; claude.ai keeps it on.',
  },

  gemini: {
    id: 'gemini',
    name: 'Gemini',
    host: 'gemini.google.com',
    home: 'https://gemini.google.com/app',
    isSite: /^https:\/\/gemini\.google\.com\//,
    signInPages: /^https:\/\/accounts\.google\.com\//,
    /** Gemini looks things up on Google by itself: nothing to choose. */
    newChatUrl() {
      return 'https://gemini.google.com/app';
    },
    composer: 'rich-textarea div.ql-editor[contenteditable="true"], div.ql-editor[contenteditable="true"], [contenteditable="true"][role="textbox"]',
    send: SEND,
    /** No session endpoint: the page decides (the Google Account button, or a "Sign in" one). It is re-read after a reload. */
    session: `(() => {
      if (document.querySelector('a[aria-label*="Google Account"], [aria-label^="Google Account:"]')) return 'in';
      return ${SIGN_IN_BUTTON} ? 'out' : 'unknown';
    })()`,
    recheckByReload: true,
    freshChat: `(() => !document.querySelector('model-response, user-query'))()`,
    replySelector: 'model-response',
  },
};

/**
 * DeepSeek's free website: not one of the AI choices. It writes the first
 * draft of a Resume, as JSON, which the chosen AI then works from (config.json
 * "deepseekFirst", deepseek-draft.js).
 *
 * Its buttons carry no labels, so there is no "finished" sign: a whole JSON
 * reply unchanged for `jsonDoneMs` is taken. Enter sends.
 */
export const DEEPSEEK = {
  id: 'deepseek',
  name: 'DeepSeek',
  host: 'chat.deepseek.com',
  home: 'https://chat.deepseek.com/',
  isSite: /^https:\/\/chat\.deepseek\.com\//,
  signInPages: /^https:\/\/(chat\.deepseek\.com\/sign_(in|up)|accounts\.google\.com)/,
  newChatUrl() {
    return 'https://chat.deepseek.com/';
  },
  composer: 'textarea#chat-input, textarea[placeholder*="DeepSeek" i], textarea[name="search"], textarea',
  send: null,
  /** Switches under the message box, turned on for a Resume. */
  toggles: ['DeepThink', 'Search'],
  session: `(() => (location.pathname.startsWith('/sign_') ? 'out' : 'unknown'))()`,
  freshChat: `(() => !document.querySelector('.ds-markdown'))()`,
  replySelector: '.ds-markdown',
  jsonDoneMs: 15_000,
  /** Said instead of an answer: no use waiting on. */
  refusal: 'server is busy|servers are busy|usage (has )?(reached|hit).{0,20}limit|reached.{0,30}limit|try again later',
};

export const DEFAULT_SITE = 'chatgpt';

/** The site config.json "ai" names (ChatGPT when unset or unknown). */
export function siteFor(id) {
  return SITES[String(id ?? '').toLowerCase()] ?? SITES[DEFAULT_SITE];
}

export { SIGN_IN_BUTTON };
