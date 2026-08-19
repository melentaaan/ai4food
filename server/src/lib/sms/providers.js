import { config } from '../../config.js';
import { request, basicAuth, tokenCache } from '../http.js';
import { UpstreamError } from '../http.js';

/**
 * Every provider is the same shape: given a phone in +221… form and a line of
 * text, deliver it and return whatever reference the gateway uses, so a failed
 * delivery can be traced back from our logs to theirs.
 *
 * Endpoints are configurable because gateway URLs move and sandboxes differ;
 * check them against the provider's current documentation before go-live.
 */

/* ---------- development: no gateway, no cost, no illusion ---------- */
const consoleProvider = {
  id: 'console',
  configured: () => true,
  async send({ to, text }) {
    console.log(`[sms:console] ${to}  ${text}`);
    return { ref: `console-${Date.now()}` };
  },
};

/* ---------- Orange Senegal ---------- */
const orangeToken = tokenCache(async () => {
  const c = config.sms.orange;
  return request('orange-sms', c.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(c.clientId, c.clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
});

const orangeProvider = {
  id: 'orange',
  configured: () => {
    const c = config.sms.orange;
    return Boolean(c.clientId && c.clientSecret && c.senderAddress);
  },
  async send({ to, text }) {
    const c = config.sms.orange;
    const token = await orangeToken();
    const sender = `tel:${c.senderAddress}`;
    const url = `${c.baseUrl}/outbound/${encodeURIComponent(sender)}/requests`;
    const out = await request('orange-sms', url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        outboundSMSMessageRequest: {
          address: `tel:${to}`,
          senderAddress: sender,
          senderName: config.sms.senderName,
          outboundSMSTextMessage: { message: text },
        },
      }),
    });
    return { ref: out?.outboundSMSMessageRequest?.resourceURL || null };
  },
};

/* ---------- Twilio ---------- */
const twilioProvider = {
  id: 'twilio',
  configured: () => {
    const c = config.sms.twilio;
    return Boolean(c.accountSid && c.authToken && c.from);
  },
  async send({ to, text }) {
    const c = config.sms.twilio;
    const url = `${c.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Messages.json`;
    const out = await request('twilio', url, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(c.accountSid, c.authToken),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ To: to, From: c.from, Body: text }).toString(),
    });
    return { ref: out?.sid || null };
  },
};

/* ---------- any other gateway, described in env ---------- */
// A JSON body needs JSON escaping, a URL or a form body needs percent
// encoding. The template itself says which it is.
const jsonEscape = (v) => JSON.stringify(String(v)).slice(1, -1);
const fill = (template, vars) => {
  const json = String(template).trim().startsWith('{');
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, k) =>
    (json ? jsonEscape(vars[k] ?? '') : encodeURIComponent(vars[k] ?? '')));
};

function parseHeaders(raw) {
  const out = {};
  for (const line of String(raw || '').split(/[\n;]/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const httpProvider = {
  id: 'http',
  configured: () => Boolean(config.sms.http.url),
  async send({ to, text }) {
    const c = config.sms.http;
    const vars = { to, text };
    const isJson = /json/i.test(c.contentType);
    const body = c.method.toUpperCase() === 'GET' ? null : fill(c.body, vars);
    const out = await request('sms-http', fill(c.url, vars), {
      method: c.method,
      headers: { 'Content-Type': c.contentType, Accept: 'application/json', ...parseHeaders(c.headers) },
      body,
      expect: isJson ? 'json' : 'text',
    });
    return { ref: (out && (out.id || out.message_id || out.messageId)) || null };
  },
};

const ALL = [consoleProvider, orangeProvider, twilioProvider, httpProvider];

export function smsProvider(id = config.sms.provider) {
  const p = ALL.find((x) => x.id === id);
  if (!p) {
    throw new UpstreamError('sms', `unknown provider "${id}" — one of ${ALL.map((x) => x.id).join(', ')}`);
  }
  if (!p.configured()) throw new UpstreamError('sms', `provider "${id}" is missing its credentials`);
  return p;
}

export const smsProviderIds = ALL.map((p) => p.id);
