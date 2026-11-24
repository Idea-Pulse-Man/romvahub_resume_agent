import { TOKEN_HELP } from './config.js';

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

/** `worker`: this computer's name, sent with every step so romva.space knows the hold is still ours. */
export function createApi(baseUrl, worker, initialToken) {
  const base = baseUrl.replace(/\/+$/, '');
  // The romva hub desktop app runs the agent with a short-lived sign-in and
  // sends a fresh one on stdin as it renews (agent.js, ROMVA_TOKEN_STDIN).
  let token = initialToken;

  async function call(path, { method = 'GET', body } = {}) {
    if (!token) throw new ApiError(401, `No Romva token. ${TOKEN_HELP}`);
    let response;
    let text;
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
    } catch (error) {
      const reason = error?.cause?.message || error?.message || String(error);
      throw new ApiError(0, `Could not reach romva.space: ${reason}`);
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

  /** A token never expires, so there is no sign-in to renew: every call is just the call. */
  const authed = call;

  return {
    /** A renewed sign-in from the desktop app. */
    setToken: (next) => {
      token = next;
    },
    /** { token: { label, profile: { id, name } } }: the Profile this token acts as. */
    me: () => authed('/api/auth/me'),
    /** The next application; `letterOnly` jobs (a stored Resume missing its cover letter) included. */
    claim: () => authed('/api/auto-make/claim', { method: 'POST', body: { worker, letterOnlyJobs: true } }),
    /** romva.space's look at a Resume answer: { ok, problems, retryMessage? }. Stores and counts nothing. */
    checkResume: (bidId, answer) =>
      authed(`/api/auto-make/jobs/${bidId}/check-resume`, { method: 'POST', body: { answer, worker } }),
    submitResume: (bidId, answer) =>
      authed(`/api/auto-make/jobs/${bidId}/resume`, { method: 'POST', body: { answer, worker } }),
    submitCoverLetter: (bidId, answer) =>
      authed(`/api/auto-make/jobs/${bidId}/cover-letter`, { method: 'POST', body: { answer, worker } }),
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
