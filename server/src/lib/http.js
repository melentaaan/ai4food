import { config } from '../config.js';

export class UpstreamError extends Error {
  constructor(service, message, { status = null, body = null, cause = null } = {}) {
    super(`${service}: ${message}`);
    this.service = service;
    this.status = status;
    this.body = body;
    this.cause = cause;
  }
}

/**
 * One fetch wrapper for every outside service we talk to (SMS gateways,
 * wallets). It exists so a provider that is slow, down or shouting HTML at us
 * fails the same recognisable way everywhere, instead of each integration
 * inventing its own idea of a bad day.
 */
export async function request(service, url, {
  method = 'GET', headers = {}, body = null, timeoutMs = config.httpTimeoutMs, expect = 'json',
} = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: ctrl.signal });
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `no answer in ${timeoutMs}ms` : (err?.message || 'request failed');
    throw new UpstreamError(service, reason, { cause: err });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  let parsed = null;
  if (expect === 'json' && text) {
    try { parsed = JSON.parse(text); } catch { /* left null: reported below */ }
  }

  if (!res.ok) {
    const detail = parsed?.message || parsed?.error_description || parsed?.error || text.slice(0, 300);
    throw new UpstreamError(service, `HTTP ${res.status}${detail ? ` — ${detail}` : ''}`, {
      status: res.status, body: parsed ?? text,
    });
  }
  if (expect === 'json' && parsed === null && text) {
    throw new UpstreamError(service, 'answered with something that is not JSON', { status: res.status, body: text.slice(0, 300) });
  }
  return expect === 'json' ? (parsed ?? {}) : text;
}

export const basicAuth = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

/** Caches a bearer token until shortly before it expires. Orange issues both. */
export function tokenCache(fetchToken) {
  let token = null;
  let expiresAt = 0;
  return async () => {
    if (token && Date.now() < expiresAt) return token;
    const { access_token: value, expires_in: ttl } = await fetchToken();
    token = value;
    expiresAt = Date.now() + Math.max(30, Number(ttl || 3600) - 60) * 1000;
    return token;
  };
}
