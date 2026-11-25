import { TOKEN_HELP } from './config.js';
import { log } from './log.js';

/**
 * No connection was made, so the request never left this computer: it is
 * safe to send again. (Seen 2026-11-24 on the new VPS: romva.space
 * unreachable for a few minutes at a time, each time just as a finished
 * Resume was being handed in — and ChatGPT's work was thrown away.)
 */
const NOT_SENT = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
/** Waits before sending an answer again: about 3 minutes in all, then it is handed back as before. */
const RESEND_WAITS_MS = [10_000, 20_000, 40_000, 60_000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * romva.space's API, with the Romva token from setup (config.json "token").
 *
 * The token is made by the Super Admin on romva.space → Tokens, for one
 * Profile: the agent makes that Profile's Resumes and cover letters only. No
 * email, password or sign-in; it works until its end date or until revoked.
 */

/**
 * `status` 0: romva.space could not be reached at all (network down, timed
 * out). `hosting`: the answer came from Vercel, not from romva.space — the
 * site itself is off (e.g. 402 DEPLOYMENT_DISABLED: the Vercel account's plan
 * or payment).
 */
export class ApiError extends Error {
  constructor(status, message, { hosting = false } = {}) {
    super(message);
    this.status = status;
    this.hosting = hosting;
  }
}

/**
 * Not the application's fault: romva.space unreachable, switched off on
 * Vercel, or in trouble (a 502 from romva.space itself is a bad answer, so it
 * is not one).
 */
export function isTemporary(error) {
  return error instanceof ApiError && (error.status === 0 || error.hosting || (error.status >= 500 && error.status !== 502));
}

/** How long a refused sign-in waits for the desktop app's next one: it renews every 5 minutes. */
const TOKEN_WAIT_MS = 6 * 60_000;

/**
 * `worker`: this computer's name, sent with every step so romva.space knows the hold is still ours.
 * `renewable`: the token comes from the romva hub desktop app, which sends a new one as it renews.
 */
export function createApi(baseUrl, worker, initialToken, { renewable = false } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  // The romva hub desktop app runs the agent with a short-lived sign-in and
  // sends a fresh one on stdin as it renews (agent.js, ROMVA_TOKEN_STDIN).
  let token = initialToken;
  let renewal = null; // the wait for the next token, shared by every call refused meanwhile
  let tokenArrived = null;

  function nextToken() {
    renewal ??= new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        renewal = null;
        tokenArrived = null;
        resolve();
      };
      const timer = setTimeout(finish, TOKEN_WAIT_MS);
      tokenArrived = finish;
    });
    return renewal;
  }

  /** `resend`: an answer from the AI site (its work is lost if not handed in) — sent again while romva.space cannot be reached. */
  async function call(path, { method = 'GET', body, resend = false } = {}) {
    if (!token) throw new ApiError(401, `No Romva token. ${TOKEN_HELP}`);
    let response;
    let text;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await fetch(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(180_000),
        });
        text = await response.text();
        break;
      } catch (error) {
        const reason = error?.cause?.message || error?.message || String(error);
        if (resend && NOT_SENT.has(error?.cause?.code) && attempt < RESEND_WAITS_MS.length) {
          const waitMs = RESEND_WAITS_MS[attempt];
          log.warn(`Could not reach romva.space; sending the answer again in ${waitMs / 1000} s`, { error: reason });
          await sleep(waitMs);
          continue;
        }
        throw new ApiError(0, `Could not reach romva.space: ${reason}`);
      }
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const vercelError = response.headers.get('x-vercel-error');
      if (vercelError) {
        throw new ApiError(
          response.status,
          `romva.space is switched off on Vercel (${response.status} ${vercelError}). ` +
            (response.status === 402
              ? "Check the Vercel account's billing and usage limits."
              : 'Check the deployment on Vercel.'),
          { hosting: true },
        );
      }
      const message = data?.error?.message || data?.message || `${response.status} ${response.statusText}`;
      throw new ApiError(response.status, response.status === 401 ? `The Romva token was refused: ${message} ${TOKEN_HELP}` : message);
    }
    return data;
  }

  /**
   * A Romva token never expires: every call is just the call. The desktop
   * app's sign-in does, and one that ran out before the next arrived refused a
   * finished Resume, which was thrown away and counted as failed (2026-11-25,
   * Brigit): so a refused call waits for the next sign-in and is sent once more.
   */
  async function authed(path, options) {
    try {
      return await call(path, options);
    } catch (error) {
      if (!renewable || !(error instanceof ApiError) || error.status !== 401) throw error;
      const refused = token;
      if (!renewal) log.warn('romva.space refused the sign-in; waiting for the desktop app to renew it', { error: error.message });
      await nextToken();
      if (token === refused) throw error;
      return call(path, options);
    }
  }

  return {
    /** A renewed sign-in from the desktop app. */
    setToken: (next) => {
      token = next;
      tokenArrived?.();
    },
    /** { token: { label, profile: { id, name } } }: the Profile this token acts as. At start: a refusal is not waited out. */
    me: () => call('/api/auth/me'),
    /** The next application; `letterOnly` jobs (a stored Resume missing its cover letter) included. */
    claim: () => authed('/api/auto-make/claim', { method: 'POST', body: { worker, letterOnlyJobs: true } }),
    /** romva.space's look at a Resume answer: { ok, problems, retryMessage? }. Stores and counts nothing. */
    checkResume: (bidId, answer) =>
      authed(`/api/auto-make/jobs/${bidId}/check-resume`, { method: 'POST', body: { answer, worker }, resend: true }),
    submitResume: (bidId, answer) =>
      authed(`/api/auto-make/jobs/${bidId}/resume`, { method: 'POST', body: { answer, worker }, resend: true }),
    submitCoverLetter: (bidId, answer) =>
      authed(`/api/auto-make/jobs/${bidId}/cover-letter`, { method: 'POST', body: { answer, worker }, resend: true }),
    /** Still here (and, with `bidId`, still on it — 409 when the hold is gone). */
    heartbeat: (bidId, waitingReason) =>
      authed('/api/auto-make/heartbeat', {
        method: 'POST',
        body: {
          worker,
          ...(bidId ? { bidId } : {}),
          ...(waitingReason !== undefined ? { waitingReason: waitingReason?.slice(0, 2000) ?? null } : {}),
        },
      }),
    /** On start: whatever this computer's previous run held is free again at once. */
    releaseHeld: () => authed('/api/auto-make/release-held', { method: 'POST', body: { worker } }),
    release: (bidId, failed, error) =>
      authed(`/api/auto-make/jobs/${bidId}/release`, {
        method: 'POST',
        body: { failed, worker, ...(error ? { error: String(error).slice(0, 4000) } : {}) },
      }),
  };
}
