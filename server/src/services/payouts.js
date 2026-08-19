import { db, now } from '../db.js';
import { uid } from '../lib/util.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { dayString, addDays, toEpoch } from '../lib/util.js';

/**
 * A payout is money that has to leave our account and arrive in a shop's. The
 * old report answered "what do we owe?" and stopped there, which is fine right
 * up until somebody reads it as "what have we sent?".
 *
 * So: what is owed is computed, what is paid is recorded, and the two are never
 * the same thing. A payout only reaches `paid` through an event with a
 * reference and a person's name on it — there is no field to simply set.
 */

const PROGRESSION = {
  owed: ['scheduled', 'processing', 'paid', 'failed'],
  scheduled: ['processing', 'paid', 'failed', 'owed'],
  processing: ['paid', 'failed'],
  failed: ['scheduled', 'processing', 'paid'],
  paid: [],
};

const event = (payoutId, status, note, actorId) =>
  db.prepare(
    `INSERT INTO payout_events (id, payout_id, status, note, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(uid(), payoutId, status, note ?? null, actorId ?? null, now());

/** Collected orders in a window that no payout has claimed yet. */
export function unpaidEarnings(from, to) {
  return db
    .prepare(
      `SELECT m.id AS merchant_id, m.name AS merchant_name, m.zone,
              COUNT(o.id) AS orders,
              COALESCE(SUM(o.total_cfa),0)                    AS gross_cfa,
              COALESCE(SUM(o.commission_cfa),0)               AS commission_cfa,
              COALESCE(SUM(o.total_cfa - o.commission_cfa),0) AS amount_cfa
         FROM merchants m
         JOIN orders o ON o.merchant_id = m.id
                      AND o.status = 'picked_up'
                      AND o.picked_up_at >= ? AND o.picked_up_at < ?
        GROUP BY m.id
       HAVING amount_cfa > 0
        ORDER BY amount_cfa DESC`,
    )
    .all(from, to);
}

/**
 * Draws up the payouts for a period. Idempotent per shop and period, so running
 * it twice on a Monday does not promise a baker their money twice.
 */
export function openPayoutRun({ req, from, to, actorId }) {
  if (!(to > from)) throw badRequest('The period has to end after it starts');
  const rows = unpaidEarnings(from, to);
  const made = [];
  db.transaction(() => {
    for (const r of rows) {
      const existing = db
        .prepare(`SELECT id FROM payouts WHERE merchant_id = ? AND period_from = ? AND period_to = ?`)
        .get(r.merchant_id, from, to);
      if (existing) continue;
      const id = uid();
      db.prepare(
        `INSERT INTO payouts (id, merchant_id, period_from, period_to, gross_cfa, commission_cfa,
                              amount_cfa, orders, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,'owed',?,?)`,
      ).run(id, r.merchant_id, from, to, r.gross_cfa, r.commission_cfa, r.amount_cfa, r.orders, now(), now());
      event(id, 'owed', 'drawn up from collected orders', actorId);
      made.push(id);
    }
  })();
  return made.map((id) => getPayout(id));
}

export const getPayout = (id) =>
  db.prepare(
    `SELECT p.*, m.name AS merchant_name, m.zone
       FROM payouts p JOIN merchants m ON m.id = p.merchant_id
      WHERE p.id = ?`,
  ).get(id);

/**
 * Moves a payout along. `paid` is the one that needs proof: without a
 * reference there is nothing to reconcile against a bank statement later, and
 * a payout nobody can trace is indistinguishable from one that never happened.
 */
export function advancePayout({ id, status, reference, method, note, actorId }) {
  const p = db.prepare('SELECT * FROM payouts WHERE id = ?').get(id);
  if (!p) throw notFound('Payout not found');
  const allowed = PROGRESSION[p.status] || [];
  if (!allowed.includes(status)) {
    throw conflict('bad_payout_transition', `A payout that is ${p.status} cannot become ${status}`);
  }
  if (status === 'paid' && !String(reference || '').trim()) {
    throw badRequest('A payout marked paid needs the transfer reference it was paid with');
  }
  db.transaction(() => {
    db.prepare(
      `UPDATE payouts SET status = ?, reference = COALESCE(?, reference), method = COALESCE(?, method),
              note = COALESCE(?, note), updated_at = ?,
              paid_at = CASE WHEN ? = 'paid' THEN ? ELSE paid_at END,
              confirmed_by = CASE WHEN ? = 'paid' THEN ? ELSE confirmed_by END
        WHERE id = ?`,
    ).run(status, reference ?? null, method ?? null, note ?? null, now(),
      status, now(), status, actorId ?? null, id);
    event(id, status, note ?? reference ?? null, actorId);
  })();
  return getPayout(id);
}

export const payoutEvents = (id) =>
  db.prepare(
    `SELECT e.*, u.name AS actor_name FROM payout_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.payout_id = ? ORDER BY e.created_at`,
  ).all(id);

export function listPayouts({ status, merchantId, limit = 100 }) {
  const where = [];
  const params = [];
  if (status) { where.push('p.status = ?'); params.push(status); }
  if (merchantId) { where.push('p.merchant_id = ?'); params.push(merchantId); }
  const rows = db
    .prepare(
      `SELECT p.*, m.name AS merchant_name, m.zone
         FROM payouts p JOIN merchants m ON m.id = p.merchant_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY p.created_at DESC LIMIT ?`,
    )
    .all(...params, limit);
  const totals = rows.reduce((a, r) => {
    a.total_cfa += r.amount_cfa;
    a[r.status] = (a[r.status] || 0) + r.amount_cfa;
    return a;
  }, { total_cfa: 0 });
  return { items: rows, totals };
}

/** A month back, as the default period the console draws up. */
export function defaultPeriod(days = 30) {
  const today = dayString();
  return [toEpoch(addDays(today, -days), '00:00'), toEpoch(addDays(today, 1), '00:00')];
}

/**
 * Refunds that did not go through. Cancelling stands either way, so these are
 * orders where the customer is owed money we still have — the one discrepancy
 * in the system that nobody would otherwise trip over.
 */
export function failedRefunds(limit = 100) {
  return db
    .prepare(
      `SELECT ord.id, ord.code, ord.total_cfa, ord.payment_method, ord.payment_status,
              ord.cancelled_at, ord.cancel_reason,
              m.name AS merchant_name, u.name AS customer_name,
              (SELECT p.provider_ref FROM payments p
                WHERE p.order_id = ord.id AND p.status = 'succeeded'
                ORDER BY p.created_at DESC LIMIT 1) AS payment_ref
         FROM orders ord
         JOIN merchants m ON m.id = ord.merchant_id
         JOIN users u     ON u.id = ord.user_id
        WHERE ord.status = 'cancelled'
          AND ord.payment_status = 'paid'
          AND ord.payment_method <> 'cash'
        ORDER BY ord.cancelled_at DESC LIMIT ?`,
    )
    .all(limit);
}
