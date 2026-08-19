import crypto from 'node:crypto';
import { config } from '../../config.js';
import { request, basicAuth, tokenCache, UpstreamError } from '../http.js';

/**
 * A wallet, from the server's point of view, is four things: open a checkout,
 * ask what happened to it, recognise its callback, and undo it. Everything the
 * order flow needs is behind those, so adding a provider never touches the
 * order code.
 *
 * `configured()` is what decides whether a payment method is offered at all —
 * an uncredentialed wallet does not appear in the app, so nothing on screen can
 * promise a payment route that does not exist.
 *
 * Endpoints and payload shapes follow each provider's published API and are
 * overridable by environment, because sandboxes and production differ and URLs
 * move. Run one real transaction in each provider's sandbox before go-live.
 */

const isProd = () => config.env === 'production';

/* ---------- cash at the counter ---------- */
const cash = {
  id: 'cash',
  label: 'Espèces à la collecte',
  online: false,
  configured: () => true,
};

/* ---------- Wave (Senegal) ---------- */
const wave = {
  id: 'wave',
  label: 'Wave',
  online: true,
  configured: () => Boolean(config.payments.wave.apiKey),

  async createCheckout({ amountCfa, reference, successUrl, errorUrl }) {
    const c = config.payments.wave;
    const out = await request('wave', `${c.baseUrl}/v1/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Same order retried must not open a second charge.
        'Idempotency-Key': reference,
      },
      body: JSON.stringify({
        amount: String(amountCfa),
        currency: 'XOF',
        client_reference: reference,
        success_url: successUrl,
        error_url: errorUrl,
      }),
    });
    if (!out?.id || !out?.wave_launch_url) {
      throw new UpstreamError('wave', 'checkout session came back without an id or a launch url', { body: out });
    }
    return {
      ref: out.id,
      checkoutUrl: out.wave_launch_url,
      expiresAt: out.when_expires ? Date.parse(out.when_expires) || null : null,
    };
  },

  async fetchStatus({ providerRef }) {
    const c = config.payments.wave;
    const out = await request('wave', `${c.baseUrl}/v1/checkout/sessions/${encodeURIComponent(providerRef)}`, {
      headers: { Authorization: `Bearer ${c.apiKey}`, Accept: 'application/json' },
    });
    return { status: waveStatus(out), raw: out };
  },

  /**
   * Wave signs with `Wave-Signature: t=<unix>,v1=<hmac>` over `${t}${body}`.
   * Unsigned callbacks are refused rather than trusted: the webhook is the
   * only thing standing between "someone posted us JSON" and a paid order.
   */
  verifyWebhook({ headers, rawBody }) {
    const secret = config.payments.wave.webhookSecret;
    if (!secret) return { ok: false, reason: 'no webhook secret configured' };
    const header = headers['wave-signature'] || headers['Wave-Signature'];
    if (!header) return { ok: false, reason: 'missing signature' };
    const parts = Object.fromEntries(
      String(header).split(',').map((kv) => kv.split('=').map((s) => s.trim())),
    );
    if (!parts.t || !parts.v1) return { ok: false, reason: 'malformed signature' };
    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}${rawBody}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(parts.v1));
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return ok ? { ok: true } : { ok: false, reason: 'signature does not match' };
  },

  parseWebhook({ body }) {
    const data = body?.data || {};
    return { ref: data.id || null, reference: data.client_reference || null, status: waveStatus(data) };
  },

  async refund({ providerRef }) {
    const c = config.payments.wave;
    await request('wave', `${c.baseUrl}/v1/checkout/sessions/${encodeURIComponent(providerRef)}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.apiKey}`, Accept: 'application/json' },
      expect: 'text',
    });
    return { ok: true };
  },
};

function waveStatus(s = {}) {
  if (s.payment_status === 'succeeded') return 'succeeded';
  if (s.payment_status === 'cancelled') return 'failed';
  if (s.checkout_status === 'expired') return 'expired';
  return 'pending';
}

/* ---------- Orange Money (Senegal web payment) ---------- */
const omToken = tokenCache(async () => {
  const c = config.payments.om;
  return request('orange-money', c.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(c.clientId, c.clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
});

const om = {
  id: 'om',
  label: 'Orange Money',
  online: true,
  configured: () => {
    const c = config.payments.om;
    return Boolean(c.clientId && c.clientSecret && c.merchantKey);
  },

  async createCheckout({ amountCfa, reference, successUrl, errorUrl, notifyUrl }) {
    const c = config.payments.om;
    const token = await omToken();
    const out = await request('orange-money', `${c.baseUrl}/webpayment`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        merchant_key: c.merchantKey,
        currency: c.currency,
        order_id: reference,
        amount: amountCfa,
        return_url: successUrl,
        cancel_url: errorUrl,
        notif_url: notifyUrl,
        lang: 'fr',
        reference: 'AI4Food',
      }),
    });
    if (!out?.payment_url || !out?.pay_token) {
      throw new UpstreamError('orange-money', 'web payment came back without a url or a pay token', { body: out });
    }
    // Orange authenticates its callback with the notif_token it hands back
    // here, so it is kept as the payment's secret and compared on the way in.
    return { ref: out.pay_token, checkoutUrl: out.payment_url, secret: out.notif_token || null };
  },

  async fetchStatus({ providerRef, reference, amountCfa }) {
    const c = config.payments.om;
    const token = await omToken();
    const out = await request('orange-money', `${c.baseUrl}/transactionstatus`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ order_id: reference, amount: amountCfa, pay_token: providerRef }),
    });
    return { status: omStatus(out), raw: out };
  },

  // No signature: Orange proves itself with the notif_token from the checkout,
  // which the caller matches against the stored secret before settling.
  verifyWebhook: () => ({ ok: true, viaSecret: true }),

  parseWebhook({ body }) {
    return {
      ref: body?.txnid || null,
      reference: body?.order_id || null,
      secret: body?.notif_token || null,
      status: omStatus(body),
    };
  },
};

function omStatus(s = {}) {
  const v = String(s.status || '').toUpperCase();
  if (v === 'SUCCESS' || v === 'SUCCESSFUL') return 'succeeded';
  if (v === 'FAILED' || v === 'CANCELLED' || v === 'CANCELED') return 'failed';
  if (v === 'EXPIRED') return 'expired';
  return 'pending';
}

/* ---------- a wallet that is not one, for demos ---------- */
const sandbox = {
  id: 'sandbox',
  label: 'Paiement de démonstration',
  online: true,
  // Never outside development: it settles without anyone paying.
  configured: () => !isProd() && config.payments.sandboxEnabled,
  async createCheckout({ reference, successUrl }) {
    return { ref: `sbx-${reference}`, checkoutUrl: `${successUrl}${successUrl.includes('?') ? '&' : '?'}sandbox=1` };
  },
  async fetchStatus() {
    return { status: 'succeeded', raw: { sandbox: true } };
  },
  verifyWebhook: () => ({ ok: true }),
  parseWebhook: ({ body }) => ({ ref: body?.ref || null, reference: body?.reference || null, status: 'succeeded' }),
  async refund() { return { ok: true }; },
};

const ALL = [cash, wave, om, sandbox];

export const paymentProviders = () => ALL;

/** Methods the app may offer: cash plus every wallet that has credentials. */
export const availablePaymentMethods = () =>
  ALL.filter((p) => p.configured()).map((p) => ({ id: p.id, label: p.label, online: p.online }));

export const paymentMethodIds = () => availablePaymentMethods().map((p) => p.id);

export function paymentProvider(id) {
  const p = ALL.find((x) => x.id === id);
  if (!p) throw new UpstreamError('payments', `unknown payment method "${id}"`);
  return p;
}
