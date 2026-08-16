import crypto from 'node:crypto';
import { db, now } from '../db.js';
import { uid } from '../lib/util.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { notify } from '../lib/notify.js';
import { ORDER_SELECT, getOrderRow } from './orders.js';

/**
 * Handing a reservation to someone else.
 *
 * The bag is already paid for; what the friend needs is the code at the
 * counter. So the transfer is a bearer token in a link — no account required
 * to collect, because the person receiving it on WhatsApp may not have one.
 * Signing in only adds convenience: the bag then shows up in their own list.
 */

const token = () => crypto.randomBytes(16).toString('base64url');

const SELECT = `
  SELECT tr.*, u.name AS claimed_by_name
    FROM order_transfers tr
    LEFT JOIN users u ON u.id = tr.claimed_by`;

export const transferOfOrder = (orderId) =>
  db.prepare(`${SELECT} WHERE tr.order_id = ? AND tr.revoked_at IS NULL`).get(orderId);

export const transferByToken = (tok) =>
  db.prepare(`${SELECT} WHERE tr.token = ? AND tr.revoked_at IS NULL`).get(tok);

/** Live transfers for a set of orders, keyed by order id — one query for a list. */
export function transfersForOrders(orderIds) {
  if (!orderIds.length) return {};
  const marks = orderIds.map(() => '?').join(',');
  return db
    .prepare(`${SELECT} WHERE tr.revoked_at IS NULL AND tr.order_id IN (${marks})`)
    .all(...orderIds)
    .reduce((a, t) => ({ ...a, [t.order_id]: t }), {});
}

function assertHandable(order) {
  if (order.status === 'picked_up') throw conflict('already_picked_up', 'That bag has already been collected');
  if (order.status !== 'active') throw conflict('not_active', `That order is ${order.status}`);
  if (order.pickup_end <= now()) throw conflict('window_closed', 'The pickup window has closed');
}

/**
 * Idempotent while the link is still good: asking twice gives the same link,
 * so a customer who taps share again does not invalidate what they already
 * sent. A revoked or claimed transfer is replaced by a fresh one.
 */
export function createTransfer({ req, user, orderId, toName, note }) {
  const order = getOrderRow(orderId);
  if (!order || order.user_id !== user.id) throw notFound('Order not found');
  assertHandable(order);

  const live = transferOfOrder(order.id);
  if (live && !live.claimed_at) {
    if (toName !== undefined || note !== undefined) {
      db.prepare('UPDATE order_transfers SET to_name = ?, note = ? WHERE id = ?')
        .run(toName ?? live.to_name ?? null, note ?? live.note ?? null, live.id);
      return transferOfOrder(order.id);
    }
    return live;
  }

  const row = {
    id: uid(),
    order_id: order.id,
    token: token(),
    created_by: user.id,
    to_name: toName ?? null,
    note: note ?? null,
    created_at: now(),
  };
  db.transaction(() => {
    db.prepare('DELETE FROM order_transfers WHERE order_id = ?').run(order.id);
    db.prepare(
      `INSERT INTO order_transfers (id, order_id, token, created_by, to_name, note, created_at)
       VALUES (@id, @order_id, @token, @created_by, @to_name, @note, @created_at)`,
    ).run(row);
  })();
  audit(req, 'order.transfer', 'order', order.id, { to_name: row.to_name ?? null });
  return transferOfOrder(order.id);
}

export function revokeTransfer({ req, user, orderId }) {
  const order = getOrderRow(orderId);
  if (!order || order.user_id !== user.id) throw notFound('Order not found');
  const live = transferOfOrder(order.id);
  if (!live) return null;
  db.prepare('UPDATE order_transfers SET revoked_at = ? WHERE id = ?').run(now(), live.id);
  if (live.claimed_by) {
    notify(live.claimed_by, 'transfer_revoked', { merchant_name: order.merchant_name });
  }
  audit(req, 'order.transfer.revoke', 'order', order.id, {});
  return true;
}

/** The bearer view: whoever holds the link, signed in or not. */
export function orderForToken(tok) {
  const tr = transferByToken(tok);
  if (!tr) throw notFound('This link is no longer valid');
  const order = db.prepare(`${ORDER_SELECT} WHERE ord.id = ?`).get(tr.order_id);
  if (!order) throw notFound('This link is no longer valid');
  return { transfer: tr, order };
}

export function claimTransfer({ req, user, tok }) {
  const { transfer, order } = orderForToken(tok);
  if (order.user_id === user.id) throw badRequest('That is your own reservation');
  assertHandable(order);
  if (transfer.claimed_by && transfer.claimed_by !== user.id) {
    throw conflict('already_claimed', 'Someone else already accepted this one');
  }
  if (!transfer.claimed_by) {
    db.prepare('UPDATE order_transfers SET claimed_by = ?, claimed_at = ? WHERE id = ?')
      .run(user.id, now(), transfer.id);
    notify(order.user_id, 'transfer_claimed', {
      merchant_name: order.merchant_name,
      name: user.name || '',
    });
    audit(req, 'order.transfer.claim', 'order', order.id, {});
  }
  return orderForToken(tok);
}

/** Orders someone else handed to this person, for their own list. */
export function claimedOrders(userId, limit = 50) {
  return db
    .prepare(
      `${ORDER_SELECT}
        JOIN order_transfers tr ON tr.order_id = ord.id
       WHERE tr.claimed_by = ? AND tr.revoked_at IS NULL
       ORDER BY ord.pickup_start ASC LIMIT ?`,
    )
    .all(userId, limit)
    .map((order) => ({ order, transfer: transferOfOrder(order.id) }));
}

/** Whoever is actually going to walk in — the counter should not be surprised. */
export function bearerOfOrder(orderId) {
  const tr = transferOfOrder(orderId);
  if (!tr) return null;
  return { transferred: true, claimed: !!tr.claimed_at, name: tr.claimed_by_name || tr.to_name || null };
}
