import { config } from '../config.js';
import { db, now } from '../db.js';
import { uid } from '../lib/util.js';
import { conflict, notFound } from '../lib/errors.js';
import { notify } from '../lib/notify.js';
import { paymentProvider, availablePaymentMethods } from '../lib/payments/providers.js';
import { refreshOfferStates } from './offers.js';

export { availablePaymentMethods };

const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const paymentRow = (id) => db.prepare('SELECT * FROM payments WHERE id = ?').get(id);

export const latestPayment = (orderId) =>
  db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(orderId);

/**
 * Where the wallet sends the customer back to.
 *
 * The client asks for this, and the provider will send a person wherever it
 * says — which makes an unchecked value an open redirect with a payment
 * confirmation attached to it, the most convincing kind. So a requested URL is
 * honoured only when it is on the origin we published as ours; anything else
 * quietly becomes that origin instead of being obeyed or refused.
 */
export function safeReturnUrl(requested) {
  const fallback = config.publicAppUrl;
  if (!requested) return fallback;
  try {
    const want = new URL(requested);
    const ours = new URL(fallback);
    const allowed = new Set([ours.origin, ...config.corsOrigins.filter((o) => o !== '*')]);
    if (allowed.has(want.origin)) return want.toString();
    console.warn('[payments] refused a return url off our origin', want.origin);
  } catch {
    console.warn('[payments] refused a return url that is not a url');
  }
  return fallback;
}

/** A wallet order is only a sale once the wallet says so. */
export const isSettled = (order) => order.payment_method === 'cash' || order.payment_status === 'paid';

/**
 * Opens a checkout for an order that is holding stock but has not been paid
 * for. The order already exists — reserving is what protects the last bag from
 * two customers, and it has to happen before we go anywhere near the network.
 */
export async function startPayment({ order, appUrl }) {
  const provider = paymentProvider(order.payment_method);
  if (!provider.online) return null;
  if (!provider.configured()) throw conflict('payment_unavailable', 'That payment method is not available right now');

  const attempt = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?').get(order.id).n;
  const reference = `${order.id}:${attempt + 1}`;
  const id = uid();
  db.prepare(
    `INSERT INTO payments (id, order_id, provider, amount_cfa, status, reference, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(id, order.id, provider.id, order.total_cfa, reference, now(), order.payment_due_at);

  const back = safeReturnUrl(appUrl);
  const sep = back.includes('?') ? '&' : '?';
  try {
    const out = await provider.createCheckout({
      amountCfa: order.total_cfa,
      reference,
      successUrl: `${back}${sep}order=${encodeURIComponent(order.id)}&payment=done`,
      errorUrl: `${back}${sep}order=${encodeURIComponent(order.id)}&payment=failed`,
      notifyUrl: `${config.publicApiUrl}/api/payments/${provider.id}/webhook`,
    });
    db.prepare(
      `UPDATE payments SET provider_ref = ?, checkout_url = ?, secret = ?, expires_at = COALESCE(?, expires_at)
        WHERE id = ?`,
    ).run(out.ref, out.checkoutUrl, out.secret ?? null, out.expiresAt ?? null, id);
    return paymentRow(id);
  } catch (err) {
    db.prepare(`UPDATE payments SET status = 'failed', last_event = ?, settled_at = ? WHERE id = ?`)
      .run(JSON.stringify({ error: String(err?.message || err) }).slice(0, 2000), now(), id);
    throw err;
  }
}

/* ---------- settling ---------- */

/** Puts the bag back on the shelf. Used by every unhappy ending. */
function releaseStock(order) {
  db.prepare('UPDATE offers SET qty_left = qty_left + ?, updated_at = ? WHERE id = ?')
    .run(order.qty, now(), order.offer_id);
  refreshOfferStates();
}

const markPayment = (payment, status, raw) =>
  db.prepare(`UPDATE payments SET status = ?, last_event = ?, settled_at = ? WHERE id = ?`)
    .run(status, raw ? JSON.stringify(raw).slice(0, 4000) : null, now(), payment.id);

/**
 * The wallet paid. The order becomes a real booking, and only now does the
 * customer get told it is theirs — a confirmation before the money moved would
 * be a promise we had not yet kept.
 */
export function settlePaid(payment, raw) {
  const run = db.transaction(() => {
    const order = orderRow(payment.order_id);
    if (!order) throw notFound('Order not found');
    if (payment.status === 'succeeded' && order.payment_status === 'paid') return order.id; // replayed callback
    markPayment(payment, 'succeeded', raw);
    if (order.status === 'pending_payment') {
      db.prepare(`UPDATE orders SET status = 'active', payment_status = 'paid', payment_due_at = NULL WHERE id = ?`)
        .run(order.id);
      const offer = db.prepare('SELECT name, pickup_from, pickup_to FROM offers WHERE id = ?').get(order.offer_id);
      const merchant = db.prepare('SELECT name FROM merchants WHERE id = ?').get(order.merchant_id);
      notify(order.user_id, 'order_ok', {
        order_id: order.id, code: order.code, qty: order.qty,
        offer_name: offer?.name, merchant_name: merchant?.name,
        pickup_from: offer?.pickup_from, pickup_to: offer?.pickup_to,
      });
    } else if (order.payment_status !== 'paid') {
      db.prepare(`UPDATE orders SET payment_status = 'paid' WHERE id = ?`).run(order.id);
    }
    return order.id;
  });
  return orderRow(run());
}

/**
 * The wallet refused, or the customer walked away. The hold ends: the bag goes
 * back on sale immediately rather than sitting out the evening unsold.
 */
export function settleUnpaid(payment, status, raw) {
  const run = db.transaction(() => {
    const order = orderRow(payment.order_id);
    if (!order) throw notFound('Order not found');
    markPayment(payment, status === 'expired' ? 'expired' : 'failed', raw);
    if (order.status !== 'pending_payment') return order.id; // already resolved elsewhere
    db.prepare(
      `UPDATE orders SET status = 'cancelled', payment_status = 'failed', cancelled_at = ?,
              cancel_reason = ?, payment_due_at = NULL
        WHERE id = ?`,
    ).run(now(), status === 'expired' ? 'payment_expired' : 'payment_failed', order.id);
    releaseStock(order);
    notify(order.user_id, status === 'expired' ? 'payment_expired' : 'payment_failed', {
      order_id: order.id, offer_id: order.offer_id,
    });
    return order.id;
  });
  return orderRow(run());
}

/**
 * Money can land on an order that is no longer waiting for it: the customer
 * cancels in the app while the wallet page is still open, then pays anyway.
 * That is a payment we hold for a bag nobody is getting, so it goes straight
 * back rather than sitting there as a discrepancy for somebody to find later.
 */
export async function reconcileIfCancelled(order) {
  if (!order || order.status !== 'cancelled' || order.payment_status !== 'paid') return { refunded: false };
  try {
    const out = await refundOrder(order);
    if (out.refunded) console.log('[payments] refunded a payment for an order already cancelled', order.id);
    return out;
  } catch (err) {
    console.error('[payments] could not refund a cancelled order', order.id, err?.message || err);
    return { refunded: false, error: String(err?.message || err) };
  }
}

/** Settles the payment and, if the bag is already gone, hands the money back. */
export async function settlePaidAndReconcile(payment, raw) {
  const order = settlePaid(payment, raw);
  await reconcileIfCancelled(order);
  return orderRow(order.id);
}

/** Asks the provider what happened and applies it. Safe to call repeatedly. */
export async function refreshPayment(payment) {
  if (payment.status !== 'pending') return { payment, order: orderRow(payment.order_id) };
  const provider = paymentProvider(payment.provider);
  if (!provider.fetchStatus || !payment.provider_ref) {
    return { payment, order: orderRow(payment.order_id) };
  }
  const { status, raw } = await provider.fetchStatus({
    providerRef: payment.provider_ref, reference: payment.reference, amountCfa: payment.amount_cfa,
  });
  // Settle first, then re-read: the payment row is only current afterwards.
  if (status === 'succeeded') {
    const order = await settlePaidAndReconcile(payment, raw);
    return { payment: paymentRow(payment.id), order };
  }
  if (status === 'failed' || status === 'expired') {
    const order = settleUnpaid(payment, status, raw);
    return { payment: paymentRow(payment.id), order };
  }
  return { payment, order: orderRow(payment.order_id) };
}

/** Finds the payment a callback is talking about, by their id or our reference. */
export function findPayment({ provider, ref, reference }) {
  if (ref) {
    const row = db.prepare('SELECT * FROM payments WHERE provider = ? AND provider_ref = ?').get(provider, ref);
    if (row) return row;
  }
  if (reference) {
    const row = db.prepare('SELECT * FROM payments WHERE provider = ? AND reference = ?').get(provider, reference);
    if (row) return row;
  }
  return null;
}

/**
 * Holds that ran out of time. Each one gets a last look at the provider before
 * it is dropped, because a customer who paid on the final second should not
 * lose the bag to our own clock.
 */
export async function sweepExpiredHolds(ts = now()) {
  const due = db
    .prepare(`SELECT * FROM orders WHERE status = 'pending_payment' AND payment_due_at IS NOT NULL AND payment_due_at < ?`)
    .all(ts);
  let released = 0;
  for (const order of due) {
    const payment = latestPayment(order.id);
    if (!payment) {
      settleUnpaid({ id: uid(), order_id: order.id, status: 'pending' }, 'expired', null);
      released += 1;
      continue;
    }
    try {
      const { order: after } = await refreshPayment(payment);
      if (after?.status === 'pending_payment') {
        settleUnpaid(paymentRow(payment.id) || payment, 'expired', null);
        released += 1;
      }
    } catch (err) {
      // The provider is unreachable. Let the hold stand and try again next
      // tick rather than cancelling an order that may well have been paid.
      console.error('[payments] could not check a hold before expiring it', order.id, err?.message || err);
    }
  }
  return released;
}

/** Money back, when a paid order is cancelled. Cash never got taken. */
export async function refundOrder(order) {
  if (order.payment_method === 'cash' || order.payment_status !== 'paid') return { refunded: false };
  const payment = db
    .prepare(`SELECT * FROM payments WHERE order_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1`)
    .get(order.id);
  const provider = paymentProvider(order.payment_method);
  if (!payment || !provider.refund) return { refunded: false, manual: true };
  await provider.refund({ providerRef: payment.provider_ref, amountCfa: payment.amount_cfa });
  db.transaction(() => {
    db.prepare(`UPDATE payments SET status = 'refunded', settled_at = ? WHERE id = ?`).run(now(), payment.id);
    db.prepare(`UPDATE orders SET payment_status = 'refunded' WHERE id = ?`).run(order.id);
  })();
  return { refunded: true };
}
