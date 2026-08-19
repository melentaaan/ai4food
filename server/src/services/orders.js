import { config } from '../config.js';
import { db, now } from '../db.js';
import { uid, pickupCode } from '../lib/util.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { notify } from '../lib/notify.js';
import { getOfferRow, refreshOfferStates } from './offers.js';
import { paymentProvider } from '../lib/payments/providers.js';
import { refundOrder, settleUnpaid, startPayment } from './payments.js';

export const ORDER_SELECT = `
  SELECT ord.*,
         o.name AS offer_name, o.image_key, o.category, o.pickup_from, o.pickup_to,
         m.name AS merchant_name, m.zone, m.address, m.lat, m.lng,
         u.name AS customer_name, u.phone AS customer_phone
    FROM orders ord
    JOIN offers o    ON o.id = ord.offer_id
    JOIN merchants m ON m.id = ord.merchant_id
    JOIN users u     ON u.id = ord.user_id`;

export const getOrderRow = (id) => db.prepare(`${ORDER_SELECT} WHERE ord.id = ?`).get(id);

function uniqueCode() {
  for (let i = 0; i < 20; i++) {
    const code = pickupCode();
    if (!db.prepare('SELECT 1 FROM orders WHERE code = ?').get(code)) return code;
  }
  throw new Error('could not allocate a pickup code');
}

/**
 * Reserving is the one place where two customers can collide, so the stock
 * decrement is a conditional UPDATE inside a transaction: whoever loses the
 * race gets a 409 instead of a basket that is not there.
 *
 * Paying with a wallet does not happen here. The bag is held — taken out of the
 * catalogue so nobody else can book it — and the order waits in
 * `pending_payment` until the wallet says the money moved. It is not a booking
 * and not collectable until then.
 */
export function reserveOffer({ req, user, offerId, qty, paymentMethod }) {
  const provider = paymentProvider(paymentMethod);
  if (!provider.configured()) {
    throw conflict('payment_unavailable', 'That payment method is not available right now');
  }
  refreshOfferStates();

  const run = db.transaction(() => {
    const offer = getOfferRow(offerId);
    if (!offer) throw notFound('That offer no longer exists');
    if (offer.merchant_status !== 'active') throw conflict('offer_unavailable', 'This shop is not taking orders');
    if (offer.status !== 'live') throw conflict('offer_unavailable', 'This offer is closed');
    if (offer.pickup_end <= now()) throw conflict('offer_unavailable', 'The pickup window has closed');

    const changed = db
      .prepare(`UPDATE offers SET qty_left = qty_left - ?, updated_at = ?
                 WHERE id = ? AND status = 'live' AND qty_left >= ?`)
      .run(qty, now(), offerId, qty).changes;
    if (changed === 0) {
      throw conflict('out_of_stock', 'Someone just took the last one', { qty_left: offer.qty_left });
    }

    const total = offer.price_cfa * qty;
    const commission = Math.round((total * offer.commission_bps) / 10_000);
    const order = {
      id: uid(),
      code: uniqueCode(),
      user_id: user.id,
      offer_id: offer.id,
      merchant_id: offer.merchant_id,
      qty,
      unit_price_cfa: offer.price_cfa,
      total_cfa: total,
      was_total_cfa: offer.was_cfa * qty,
      commission_cfa: commission,
      payment_method: paymentMethod,
      // Cash is settled at the counter, so the order stands from the start. A
      // wallet order owes money, and says so until the provider confirms.
      payment_status: 'pending',
      status: provider.online ? 'pending_payment' : 'active',
      payment_due_at: provider.online ? now() + config.paymentWindowMinutes * 60_000 : null,
      pickup_start: offer.pickup_start,
      pickup_end: offer.pickup_end,
      created_at: now(),
    };
    db.prepare(
      `INSERT INTO orders (id, code, user_id, offer_id, merchant_id, qty, unit_price_cfa, total_cfa,
                           was_total_cfa, commission_cfa, payment_method, payment_status, status,
                           payment_due_at, pickup_start, pickup_end, created_at)
       VALUES (@id, @code, @user_id, @offer_id, @merchant_id, @qty, @unit_price_cfa, @total_cfa,
               @was_total_cfa, @commission_cfa, @payment_method, @payment_status, @status,
               @payment_due_at, @pickup_start, @pickup_end, @created_at)`,
    ).run(order);

    if (offer.qty_left - qty <= 0) {
      db.prepare(`UPDATE offers SET status = 'sold_out', updated_at = ? WHERE id = ?`).run(now(), offer.id);
    }

    // A wallet order is confirmed when the money lands, not when it is asked
    // for; settlePaid sends this same notification then.
    if (!provider.online) {
      notify(user.id, 'order_ok', {
        order_id: order.id, code: order.code, qty,
        offer_name: offer.name, merchant_name: offer.merchant_name,
        pickup_from: offer.pickup_from, pickup_to: offer.pickup_to,
      });
    }
    audit(req, 'order.create', 'order', order.id, {
      offer_id: offer.id, merchant_id: offer.merchant_id, qty, total_cfa: total,
    });
    return order.id;
  });

  return getOrderRow(run());
}

/**
 * Reserve, then open the checkout. Two steps rather than one because the stock
 * decrement must not wait on somebody else's network: the bag is claimed first,
 * and only then do we go and ask the wallet for a payment page. If that call
 * fails the hold is undone immediately — an unpayable order must not sit on a
 * bag for the length of the payment window.
 */
export async function reserveAndPay({ req, user, offerId, qty, paymentMethod, appUrl }) {
  const order = reserveOffer({ req, user, offerId, qty, paymentMethod });
  const provider = paymentProvider(paymentMethod);
  if (!provider.online) return { order, payment: null };

  try {
    const payment = await startPayment({ order, appUrl });
    return { order: getOrderRow(order.id), payment };
  } catch (err) {
    settleUnpaid({ id: uid(), order_id: order.id, status: 'pending' }, 'failed', {
      error: String(err?.message || err),
    });
    audit(req, 'order.payment_start_failed', 'order', order.id, { provider: paymentMethod });
    throw conflict('payment_unavailable',
      'The payment service did not answer. Nothing was charged and the bag is back on sale.');
  }
}

export function cancelOrder({ req, user, orderId, reason }) {
  const run = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw notFound('Order not found');
    // Admins can cancel on a customer's behalf (support calls); nobody else can.
    if (order.user_id !== user.id && user.role !== 'admin') throw notFound('Order not found');
    const cancellable = order.status === 'active' || order.status === 'pending_payment';
    if (!cancellable) throw conflict('not_cancellable', 'This order is already closed');

    // The cancellation window protects the shop from a late change of mind. An
    // order that was never paid for is not that: dropping out of a checkout is
    // allowed at any point, and the bag goes straight back on sale.
    const deadline = order.pickup_start - config.cancelWindowMinutes * 60_000;
    if (order.status === 'active' && now() > deadline && user.role !== 'admin') {
      throw conflict('cancel_window_closed',
        `Orders can be cancelled up to ${config.cancelWindowMinutes / 60}h before pickup`);
    }

    db.prepare(`UPDATE orders SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?,
                       payment_due_at = NULL
                 WHERE id = ?`)
      .run(now(), reason ?? null, order.id);
    // A checkout for a bag nobody is collecting is over, whatever the wallet
    // still thinks. Marking it keeps the hold sweep off it.
    if (order.status === 'pending_payment') {
      db.prepare(`UPDATE payments SET status = 'failed', settled_at = ?
                   WHERE order_id = ? AND status = 'pending'`).run(now(), order.id);
    }
    db.prepare(`UPDATE offers SET qty_left = qty_left + ?, updated_at = ? WHERE id = ?`)
      .run(order.qty, now(), order.offer_id);
    refreshOfferStates();

    audit(req, 'order.cancel', 'order', order.id, { by: user.role, reason: reason ?? null });
    return order.id;
  });
  return getOrderRow(run());
}

/**
 * Cancelling and getting the money back are two different promises, and only
 * the first is ours to keep instantly. The cancellation stands either way; a
 * refund the wallet refused leaves the order visibly cancelled-but-paid, which
 * is what someone should have to go and look at.
 */
export async function cancelOrderAndRefund({ req, user, orderId, reason }) {
  const order = cancelOrder({ req, user, orderId, reason });
  let refund = { refunded: false };
  try {
    refund = await refundOrder(order);
    if (refund.refunded) audit(req, 'order.refund', 'order', order.id, { amount_cfa: order.total_cfa });
  } catch (err) {
    console.error('[payments] refund failed for', order.id, err?.message || err);
    audit(req, 'order.refund_failed', 'order', order.id, { error: String(err?.message || err).slice(0, 200) });
  }
  return { order: getOrderRow(order.id), refund };
}

/**
 * The counter flow: a member of staff types the code the customer shows.
 * Scoped to their own shop, so a code from another shop simply does not exist.
 */
export function validatePickup({ req, merchant, staffUser, code }) {
  const clean = String(code || '').trim().toUpperCase();
  const normalised = clean.startsWith('AI4-') ? clean : `AI4-${clean.replace(/^AI4/, '')}`;
  if (!/^AI4-[A-Z0-9]{4}$/.test(normalised)) throw badRequest('Codes look like AI4-7C2K');

  const run = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE code = ? AND merchant_id = ?')
      .get(normalised, merchant.id);
    if (!order) throw notFound('No order with that code at this shop');
    if (order.status === 'picked_up') throw conflict('already_picked_up', 'That code was already used');
    if (order.status === 'pending_payment') {
      throw conflict('not_paid', 'This order has not been paid for yet');
    }
    if (order.status !== 'active') throw conflict('not_active', `That order is ${order.status}`);

    db.prepare(`UPDATE orders SET status = 'picked_up', picked_up_at = ?, picked_up_by = ?,
                       payment_status = CASE WHEN payment_method = 'cash' THEN 'paid' ELSE payment_status END
                 WHERE id = ?`)
      .run(now(), staffUser.id, order.id);

    notify(order.user_id, 'picked_up', { order_id: order.id, merchant_name: merchant.name, qty: order.qty });
    audit(req, 'order.pickup', 'order', order.id, { merchant_id: merchant.id, code: normalised });
    return order.id;
  });
  return getOrderRow(run());
}

/** Unclaimed orders go stale once the window has closed plus a grace period. */
export function expireStaleOrders(ts = now()) {
  const cutoff = ts - config.pickupGraceMinutes * 60_000;
  const stale = db.prepare(`SELECT id, user_id FROM orders WHERE status = 'active' AND pickup_end < ?`).all(cutoff);
  if (stale.length) {
    const mark = db.prepare(`UPDATE orders SET status = 'expired' WHERE id = ?`);
    db.transaction(() => { for (const o of stale) mark.run(o.id); })();
  }
  refreshOfferStates(ts);
  return stale.length;
}

/** Reminders for windows opening within the hour, sent once per order. */
export function sendPickupReminders(ts = now()) {
  const soon = db
    .prepare(
      `SELECT ord.id, ord.user_id, ord.code, ord.pickup_start, m.name AS merchant_name, o.pickup_from
         FROM orders ord
         JOIN merchants m ON m.id = ord.merchant_id
         JOIN offers o ON o.id = ord.offer_id
        WHERE ord.status = 'active'
          AND ord.pickup_start BETWEEN ? AND ?
          AND NOT EXISTS (
            SELECT 1 FROM notifications n
             WHERE n.user_id = ord.user_id AND n.kind = 'pickup_soon'
               AND json_extract(n.payload, '$.order_id') = ord.id)`,
    )
    .all(ts, ts + 60 * 60_000);
  for (const o of soon) {
    notify(o.user_id, 'pickup_soon', {
      order_id: o.id, code: o.code, merchant_name: o.merchant_name, pickup_from: o.pickup_from,
    });
  }
  return soon.length;
}

export function assertOwnsOrder(order, user) {
  if (!order) throw notFound('Order not found');
  if (user.role === 'admin') return;
  if (order.user_id !== user.id) throw forbidden('Not your order');
}
