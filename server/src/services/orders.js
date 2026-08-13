import { config } from '../config.js';
import { db, now } from '../db.js';
import { uid, pickupCode } from '../lib/util.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { notify } from '../lib/notify.js';
import { getOfferRow, refreshOfferStates } from './offers.js';

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
 */
export function reserveOffer({ req, user, offerId, qty, paymentMethod }) {
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
      // Cash is settled at the counter; wallets are captured up front. A real
      // Wave/Orange Money integration replaces this line and nothing else.
      payment_status: paymentMethod === 'cash' ? 'pending' : 'paid',
      status: 'active',
      pickup_start: offer.pickup_start,
      pickup_end: offer.pickup_end,
      created_at: now(),
    };
    db.prepare(
      `INSERT INTO orders (id, code, user_id, offer_id, merchant_id, qty, unit_price_cfa, total_cfa,
                           was_total_cfa, commission_cfa, payment_method, payment_status, status,
                           pickup_start, pickup_end, created_at)
       VALUES (@id, @code, @user_id, @offer_id, @merchant_id, @qty, @unit_price_cfa, @total_cfa,
               @was_total_cfa, @commission_cfa, @payment_method, @payment_status, @status,
               @pickup_start, @pickup_end, @created_at)`,
    ).run(order);

    if (offer.qty_left - qty <= 0) {
      db.prepare(`UPDATE offers SET status = 'sold_out', updated_at = ? WHERE id = ?`).run(now(), offer.id);
    }

    notify(user.id, 'order_ok', {
      order_id: order.id, code: order.code, qty,
      offer_name: offer.name, merchant_name: offer.merchant_name,
      pickup_from: offer.pickup_from, pickup_to: offer.pickup_to,
    });
    audit(req, 'order.create', 'order', order.id, {
      offer_id: offer.id, merchant_id: offer.merchant_id, qty, total_cfa: total,
    });
    return order.id;
  });

  return getOrderRow(run());
}

export function cancelOrder({ req, user, orderId, reason }) {
  const run = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw notFound('Order not found');
    // Admins can cancel on a customer's behalf (support calls); nobody else can.
    if (order.user_id !== user.id && user.role !== 'admin') throw notFound('Order not found');
    if (order.status !== 'active') throw conflict('not_cancellable', 'This order is already closed');

    const deadline = order.pickup_start - config.cancelWindowMinutes * 60_000;
    if (now() > deadline && user.role !== 'admin') {
      throw conflict('cancel_window_closed',
        `Orders can be cancelled up to ${config.cancelWindowMinutes / 60}h before pickup`);
    }

    db.prepare(`UPDATE orders SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?,
                       payment_status = CASE WHEN payment_status = 'paid' THEN 'refunded' ELSE payment_status END
                 WHERE id = ?`)
      .run(now(), reason ?? null, order.id);
    db.prepare(`UPDATE offers SET qty_left = qty_left + ?, updated_at = ? WHERE id = ?`)
      .run(order.qty, now(), order.offer_id);
    refreshOfferStates();

    audit(req, 'order.cancel', 'order', order.id, { by: user.role, reason: reason ?? null });
    return order.id;
  });
  return getOrderRow(run());
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
