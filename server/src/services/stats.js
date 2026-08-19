import { config } from '../config.js';
import { db, now } from '../db.js';
import { dayString, addDays, toEpoch } from '../lib/util.js';

const dayRange = (dateStr) => [toEpoch(dateStr, '00:00'), toEpoch(addDays(dateStr, 1), '00:00')];

/** Last n days as [{date, ...}], oldest first — the shape both dashboards chart. */
function series(dates, fn) {
  return dates.map((date) => ({ date, ...fn(...dayRange(date)) }));
}
export function lastDays(n, ts = now()) {
  const today = dayString(ts);
  return Array.from({ length: n }, (_, i) => addDays(today, i - (n - 1)));
}

/* ---------- customer ---------- */
/** Only ever called with the signed-in user's own id. */
export function customerImpact(userId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(qty),0) AS meals,
              COALESCE(SUM(was_total_cfa - total_cfa),0) AS saved,
              COUNT(*) AS orders
         FROM orders WHERE user_id = ? AND status = 'picked_up'`,
    )
    .get(userId);
  const counts = db
    .prepare(`SELECT status, COUNT(*) AS n FROM orders WHERE user_id = ? GROUP BY status`)
    .all(userId);
  return {
    meals_saved: row.meals,
    co2e_kg: Math.round(row.meals * config.co2PerMealKg * 10) / 10,
    money_saved_cfa: row.saved,
    orders_total: counts.reduce((a, c) => a + c.n, 0),
    orders_by_status: Object.fromEntries(counts.map((c) => [c.status, c.n])),
  };
}

/* ---------- merchant ---------- */
/** Scoped to one shop. A merchant never sees platform-wide figures. */
export function merchantStats(merchantId, days = 7) {
  const today = dayString();
  const [from, to] = dayRange(today);

  const todayRow = db
    .prepare(
      `SELECT COALESCE(SUM(qty),0) AS baskets,
              COALESCE(SUM(total_cfa),0) AS gross,
              COALESCE(SUM(commission_cfa),0) AS commission
         FROM orders
        WHERE merchant_id = ? AND status NOT IN ('cancelled','pending_payment') AND created_at >= ? AND created_at < ?`,
    )
    .get(merchantId, from, to);

  const collected = db
    .prepare(
      `SELECT COALESCE(SUM(total_cfa),0) AS gross, COALESCE(SUM(commission_cfa),0) AS commission
         FROM orders
        WHERE merchant_id = ? AND status = 'picked_up' AND picked_up_at >= ? AND picked_up_at < ?`,
    )
    .get(merchantId, from, to);

  const live = db
    .prepare(
      `SELECT COUNT(*) AS offers, COALESCE(SUM(qty_total),0) AS published, COALESCE(SUM(qty_left),0) AS left_now
         FROM offers WHERE merchant_id = ? AND status = 'live'`,
    )
    .get(merchantId);

  const pending = db
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE merchant_id = ? AND status = 'active'`)
    .get(merchantId).n;

  const allTime = db
    .prepare(
      `SELECT COALESCE(SUM(qty),0) AS baskets,
              COALESCE(SUM(total_cfa - commission_cfa),0) AS payout,
              COALESCE(SUM(was_total_cfa - total_cfa),0) AS customer_saving
         FROM orders WHERE merchant_id = ? AND status = 'picked_up'`,
    )
    .get(merchantId);

  const picked = db.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE merchant_id = ? AND status = 'picked_up'`).get(merchantId).n;
  const closed = db.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE merchant_id = ? AND status IN ('picked_up','expired')`).get(merchantId).n;

  return {
    today: {
      baskets_reserved: todayRow.baskets,
      gross_cfa: todayRow.gross,
      commission_cfa: todayRow.commission,
      payout_cfa: todayRow.gross - todayRow.commission,
      collected_cfa: collected.gross - collected.commission,
      offers_live: live.offers,
      qty_published: live.published,
      qty_left: live.left_now,
      orders_awaiting_pickup: pending,
    },
    all_time: {
      baskets_sold: allTime.baskets,
      payout_cfa: allTime.payout,
      customer_saving_cfa: allTime.customer_saving,
      pickup_rate_pct: closed ? Math.round((picked / closed) * 100) : null,
    },
    series: series(lastDays(days), (a, b) => {
      const r = db
        .prepare(
          `SELECT COALESCE(SUM(qty),0) AS baskets, COALESCE(SUM(total_cfa),0) AS gross
             FROM orders WHERE merchant_id = ? AND status NOT IN ('cancelled','pending_payment') AND created_at >= ? AND created_at < ?`,
        )
        .get(merchantId, a, b);
      return { baskets: r.baskets, gross_cfa: r.gross };
    }),
  };
}

/**
 * Tomorrow's surplus estimate. Deliberately simple and honest: the mean of the
 * same weekday over the last six weeks, nudged by the recent trend, with a
 * confidence that falls when the shop has little history. Swap the internals
 * for a real model without touching the API shape.
 */
export function merchantForecast(merchantId) {
  const today = dayString();
  const tomorrow = addDays(today, 1);
  const weekday = new Date(`${tomorrow}T00:00:00Z`).getUTCDay();

  const sameWeekday = [];
  for (let w = 1; w <= 6; w++) {
    const d = addDays(tomorrow, -7 * w);
    const [a, b] = dayRange(d);
    const r = db
      .prepare(
        `SELECT COALESCE(SUM(qty_total),0) AS published, COALESCE(SUM(qty_total - qty_left),0) AS sold
           FROM offers WHERE merchant_id = ? AND created_at >= ? AND created_at < ?`,
      )
      .get(merchantId, a, b);
    if (r.published > 0) sameWeekday.push(r);
  }

  const recent = db
    .prepare(
      `SELECT COALESCE(AVG(qty_total),0) AS avg_published
         FROM (SELECT qty_total FROM offers WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 10)`,
    )
    .get(merchantId).avg_published;

  const avgSold = sameWeekday.length
    ? sameWeekday.reduce((a, r) => a + r.sold, 0) / sameWeekday.length
    : recent;

  const suggested = db
    .prepare(
      `SELECT COALESCE(AVG(price_cfa),0) AS price, COALESCE(AVG(was_cfa),0) AS was
         FROM (SELECT price_cfa, was_cfa FROM offers WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 10)`,
    )
    .get(merchantId);

  const window = db
    .prepare(
      `SELECT pickup_from, pickup_to, COUNT(*) AS n
         FROM offers WHERE merchant_id = ?
        GROUP BY pickup_from, pickup_to ORDER BY n DESC LIMIT 1`,
    )
    .get(merchantId);

  const qty = Math.max(1, Math.round(avgSold || 5));
  const price = Math.round((suggested.price || 1000) / 100) * 100;
  const was = Math.round((suggested.was || price * 3) / 100) * 100;
  const confidence = Math.min(92, 40 + sameWeekday.length * 8);

  return {
    date: tomorrow,
    weekday,
    predicted_surplus: qty,
    window: { from: window?.pickup_from ?? '19:30', to: window?.pickup_to ?? '20:30' },
    suggested_price_cfa: price,
    suggested_was_cfa: Math.max(was, price + 500),
    estimated_revenue_cfa: qty * price,
    avoided_loss_cfa: qty * Math.max(was - price, 0),
    commission_bps: db.prepare('SELECT commission_bps FROM merchants WHERE id = ?').get(merchantId)?.commission_bps ?? config.defaultCommissionBps,
    confidence_pct: confidence,
    basis: { same_weekday_samples: sameWeekday.length, recent_avg_published: Math.round(recent) },
  };
}

/* ---------- admin ---------- */
/** Platform-wide. Only ever reachable behind requireRole('admin'). */
export function adminOverview(days = 7) {
  const today = dayString();
  const [from, to] = dayRange(today);

  const t = db
    .prepare(
      `SELECT COALESCE(SUM(qty),0) AS baskets,
              COALESCE(SUM(total_cfa),0) AS gross,
              COALESCE(SUM(commission_cfa),0) AS commission,
              COUNT(*) AS orders
         FROM orders WHERE status NOT IN ('cancelled','pending_payment') AND created_at >= ? AND created_at < ?`,
    )
    .get(from, to);

  const picked = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'picked_up'`).get().n;
  const closed = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status IN ('picked_up','expired')`).get().n;
  const meals = db.prepare(`SELECT COALESCE(SUM(qty),0) AS n FROM orders WHERE status = 'picked_up'`).get().n;

  const merchants = db
    .prepare(`SELECT status, COUNT(*) AS n FROM merchants GROUP BY status`)
    .all()
    .reduce((a, r) => ({ ...a, [r.status]: r.n }), {});
  const users = db
    .prepare(`SELECT role, COUNT(*) AS n FROM users WHERE status = 'active' GROUP BY role`)
    .all()
    .reduce((a, r) => ({ ...a, [r.role]: r.n }), {});

  const activeToday = db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?`).get(from).n;

  return {
    today: {
      baskets_sold: t.baskets,
      orders: t.orders,
      gross_cfa: t.gross,
      commission_cfa: t.commission,
      active_users: activeToday,
    },
    all_time: {
      meals_saved: meals,
      co2e_kg: Math.round(meals * config.co2PerMealKg * 10) / 10,
      pickup_rate_pct: closed ? Math.round((picked / closed) * 100) : null,
      waste_avoided_cfa: db.prepare(
        `SELECT COALESCE(SUM(was_total_cfa),0) AS v FROM orders WHERE status = 'picked_up'`).get().v,
    },
    network: {
      merchants_active: merchants.active ?? 0,
      merchants_pending: merchants.pending ?? 0,
      merchants_prospect: merchants.prospect ?? 0,
      merchants_suspended: merchants.suspended ?? 0,
      invites: db.prepare('SELECT COUNT(*) AS n FROM merchant_invites').get().n,
      offers_live: db.prepare(`SELECT COUNT(*) AS n FROM offers WHERE status = 'live'`).get().n,
      offers_today: db.prepare(`SELECT COUNT(*) AS n FROM offers WHERE created_at >= ? AND created_at < ?`).get(from, to).n,
    },
    users: {
      customers: users.customer ?? 0,
      merchants: users.merchant ?? 0,
      admins: users.admin ?? 0,
    },
    series: series(lastDays(days), (a, b) => {
      const r = db
        .prepare(
          `SELECT COALESCE(SUM(qty),0) AS baskets,
                  COALESCE(SUM(total_cfa),0) AS gross,
                  COALESCE(SUM(commission_cfa),0) AS commission
             FROM orders WHERE status NOT IN ('cancelled','pending_payment') AND created_at >= ? AND created_at < ?`,
        )
        .get(a, b);
      return { baskets: r.baskets, gross_cfa: r.gross, commission_cfa: r.commission };
    }),
  };
}

/** Who owes whom, per shop, for the period — the basis of a payout run. */
export function adminPayouts(days = 30) {
  const from = toEpoch(addDays(dayString(), -days), '00:00');
  return db
    .prepare(
      `SELECT m.id AS merchant_id, m.name AS merchant_name, m.zone,
              COUNT(o.id) AS orders,
              COALESCE(SUM(o.total_cfa),0) AS gross_cfa,
              COALESCE(SUM(o.commission_cfa),0) AS commission_cfa,
              COALESCE(SUM(o.total_cfa - o.commission_cfa),0) AS payout_cfa
         FROM merchants m
         JOIN orders o ON o.merchant_id = m.id AND o.status = 'picked_up' AND o.picked_up_at >= ?
        GROUP BY m.id
        ORDER BY payout_cfa DESC`,
    )
    .all(from);
}
