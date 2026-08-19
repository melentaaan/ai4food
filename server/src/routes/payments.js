import { Router } from 'express';
import crypto from 'node:crypto';
import { audit } from '../lib/audit.js';
import { unauthorized } from '../lib/errors.js';
import { paymentProvider } from '../lib/payments/providers.js';
import { findPayment, settlePaidAndReconcile, settleUnpaid } from '../services/payments.js';

export const router = Router();

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Where the wallet tells us the money moved. This is the only unauthenticated
 * write in the API, so nothing here is taken on trust: the signature is checked
 * first, then the payment is looked up by the provider's own reference, and the
 * amount and order come from our row rather than from the body.
 *
 * A callback about something we do not recognise is answered 200 anyway —
 * providers retry non-2xx for hours, and there is nothing to retry into.
 */
router.post('/:provider/webhook', async (req, res) => {
  const id = req.params.provider;
  let provider;
  try {
    provider = paymentProvider(id);
  } catch {
    return res.json({ ignored: true, reason: 'unknown provider' });
  }
  if (!provider.online || !provider.configured() || !provider.parseWebhook) {
    return res.json({ ignored: true, reason: 'provider not in use' });
  }

  const check = provider.verifyWebhook({
    headers: req.headers,
    rawBody: req.rawBody ?? JSON.stringify(req.body ?? {}),
  });
  if (!check.ok) {
    console.warn(`[payments] rejected a ${id} callback: ${check.reason}`);
    throw unauthorized('Callback signature rejected');
  }

  const parsed = provider.parseWebhook({ body: req.body });
  const payment = findPayment({ provider: id, ref: parsed.ref, reference: parsed.reference });
  if (!payment) {
    console.warn(`[payments] ${id} callback for an unknown payment`, parsed.ref || parsed.reference);
    return res.json({ ignored: true, reason: 'no such payment' });
  }

  // Providers that do not sign hand out a per-payment token instead; it stands
  // in for the signature and has to match the one we were given at checkout.
  if (check.viaSecret && !sameSecret(payment.secret, parsed.secret)) {
    console.warn(`[payments] ${id} callback with the wrong notification token`, payment.id);
    throw unauthorized('Callback token rejected');
  }

  if (parsed.status === 'succeeded') await settlePaidAndReconcile(payment, req.body);
  else if (parsed.status === 'failed' || parsed.status === 'expired') {
    settleUnpaid(payment, parsed.status, req.body);
  } else {
    return res.json({ received: true, status: 'pending' });
  }

  audit(req, `payment.${parsed.status}`, 'order', payment.order_id, { provider: id, payment_id: payment.id });
  res.json({ received: true, status: parsed.status });
});
