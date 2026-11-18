import { CREDENTIALS_FILE, loadCredentials, loadSession, saveSession } from './config.js';
import { log } from './log.js';

/** After credentials.txt is refused (a wrong password), wait this long before trying it again. */
const LOGIN_RETRY_MS = 5 * 60_000;

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

  /**
   * The refresh token is single-use (renewed each time), so two calls that hit
   * a 401 together (the job and its keep-alive timer) must share one refresh:
   * a second refresh with the same token is refused and signs the agent out.
   */
  function useSignIn(data) {
    session = { accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user };
    saveSession(session);
  }

  /**
   * Signs in again with credentials.txt, when there is one. False when there
   * is none; throws when romva.space refuses it (then waits LOGIN_RETRY_MS
   * before trying again, so a wrong password is not sent every minute).
   */
  let loginRefusedAt = 0;
  async function signInFromFile() {
    const credentials = loadCredentials();
    if (!credentials) return false;
    if (Date.now() - loginRefusedAt < LOGIN_RETRY_MS) {
      throw new ApiError(401, `The email or password in ${CREDENTIALS_FILE} was refused; trying it again in a few minutes.`);
    }
    try {
      useSignIn(await call('/api/auth/login', { method: 'POST', body: credentials }));
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        loginRefusedAt = Date.now();
        throw new ApiError(401, `romva.space refused the email or password in ${CREDENTIALS_FILE}: ${error.message}`);
      }
      throw error;
    }
    loginRefusedAt = 0;
    log.info('Signed in to romva.space again with credentials.txt', { email: credentials.email });
    return true;
  }

  const SIGNED_OUT = `Signed out of romva.space. Put the email and password in ${CREDENTIALS_FILE}, or run setup again: npm run setup`;

  let refreshing = null;
  function refresh() {
    refreshing ??= (async () => {
      // `npm run setup` run again while the agent is running: its new sign-in
      // is taken up from session.json, no restart needed.
      const saved = loadSession();
      if (saved?.refreshToken && saved.refreshToken !== session?.refreshToken) {
        session = saved;
        return;
      }
      if (!session?.refreshToken) {
        if (await signInFromFile()) return;
        throw new ApiError(401, SIGNED_OUT);
      }
      let data;
      try {
        data = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: session.refreshToken } });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          // Refused: never send this token again. romva.space takes a spent
          // token sent again for a stolen one and signs the account out
          // everywhere — the website and the extension too — every time.
          session = { ...session, accessToken: null, refreshToken: null };
          saveSession(session);
          log.warn('romva.space ended the sign-in', { reason: error.message });
          if (await signInFromFile()) return;
          throw new ApiError(401, `${error.message} ${SIGNED_OUT}`);
        }
        throw error;
      }
      session = { ...session, accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user };
      saveSession(session);
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /** A call as the signed-in person; an expired access token is renewed once and the call retried. */
  async function authed(path, options = {}) {
    if (refreshing) await refreshing;
    if (!session?.accessToken) await refresh();
    const token = session.accessToken;
    try {
      return await call(path, { ...options, token });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      // Renewed by another call while this one was out: just retry with the new token.
      if (session?.accessToken === token) await refresh();
      return call(path, { ...options, token: session.accessToken });
    }
  }

  return {
    async login(email, password) {
      const data = await call('/api/auth/login', { method: 'POST', body: { email, password } });
      useSignIn(data);
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
