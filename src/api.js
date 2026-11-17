import { loadSession, saveSession } from './config.js';

/**
 * romva.space's API, signed in as the person who ran setup.
 *
 * The password is used once, by setup, and never stored: what is kept is the
 * session's refresh token, which is swapped for a fresh access token whenever
 * the old one expires (and itself renewed each time).
 */

/** `status` 0: romva.space could not be reached at all (network down, timed out). */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Not the application's fault: romva.space unreachable or in trouble (a 502 is a bad answer, so it is not one). */
export function isTemporary(error) {
  return error instanceof ApiError && (error.status === 0 || (error.status >= 500 && error.status !== 502));
}

/** `worker`: this computer's name, sent with every step so romva.space knows the hold is still ours. */
export function createApi(baseUrl, worker) {
  const base = baseUrl.replace(/\/+$/, '');
  let session = loadSession();

  async function call(path, { method = 'GET', body, token } = {}) {
    let response;
    let text;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
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
      const message = data?.error?.message || data?.message || `${response.status} ${response.statusText}`;
      throw new ApiError(response.status, message);
    }
    return data;
  }

  async function refresh() {
    if (!session?.refreshToken) throw new ApiError(401, 'Not signed in. Run setup again.');
    const data = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: session.refreshToken } });
    session = { ...session, accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user };
    saveSession(session);
  }

  /** A call as the signed-in person; an expired access token is renewed once and the call retried. */
  async function authed(path, options = {}) {
    if (!session?.accessToken) await refresh();
    try {
      return await call(path, { ...options, token: session.accessToken });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      await refresh();
      return call(path, { ...options, token: session.accessToken });
    }
  }

  return {
    async login(email, password) {
      const data = await call('/api/auth/login', { method: 'POST', body: { email, password } });
      session = { accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user };
      saveSession(session);
      return data.user;
    },
    me: () => authed('/api/auth/me'),
    /** The next application; `letterOnly` jobs (a stored Resume missing its cover letter) included. */
    claim: () => authed('/api/auto-make/claim', { method: 'POST', body: { worker, letterOnlyJobs: true } }),
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
