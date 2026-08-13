import { db, now } from '../db.js';
import { scoreOffer, offerState } from '../lib/rank.js';

export const OFFER_SELECT = `
  SELECT o.*,
         m.name AS merchant_name, m.zone, m.address, m.lat, m.lng,
         m.rating, m.reviews_count, m.status AS merchant_status, m.commission_bps
    FROM offers o
    JOIN merchants m ON m.id = o.merchant_id`;

export const getOfferRow = (id) => db.prepare(`${OFFER_SELECT} WHERE o.id = ?`).get(id);

/**
 * Offers age out on their own: once a pickup window has closed the offer is no
 * longer live, and an offer with nothing left is sold out. Cheap enough to run
 * before any listing rather than relying on the background job alone.
 */
export function refreshOfferStates(ts = now()) {
  db.prepare(`UPDATE offers SET status = 'expired', updated_at = ? WHERE status = 'live' AND pickup_end <= ?`).run(ts, ts);
  db.prepare(`UPDATE offers SET status = 'sold_out', updated_at = ? WHERE status = 'live' AND qty_left <= 0`).run(ts);
  db.prepare(`UPDATE offers SET status = 'live', updated_at = ? WHERE status = 'sold_out' AND qty_left > 0 AND pickup_end > ?`).run(ts, ts);
}

/** What this person has bought before, used by the ranker. Anonymous = empty. */
export function userContext(user) {
  const ctx = {
    pos: user && user.lat != null ? { lat: user.lat, lng: user.lng } : null,
    favourites: new Set(),
    byMerchant: new Map(),
    byCategory: new Map(),
  };
  if (!user) return ctx;

  for (const r of db.prepare('SELECT offer_id FROM favourites WHERE user_id = ?').all(user.id)) {
    ctx.favourites.add(r.offer_id);
  }
  const rows = db
    .prepare(
      `SELECT o.merchant_id, f.category, SUM(o.qty) AS n
         FROM orders o
         JOIN offers f ON f.id = o.offer_id
        WHERE o.user_id = ? AND o.status <> 'cancelled'
        GROUP BY o.merchant_id, f.category`,
    )
    .all(user.id);
  for (const r of rows) {
    ctx.byMerchant.set(r.merchant_id, (ctx.byMerchant.get(r.merchant_id) ?? 0) + r.n);
    ctx.byCategory.set(r.category, (ctx.byCategory.get(r.category) ?? 0) + r.n);
  }
  return ctx;
}

const SORTS = {
  price: (a, b) => a.offer.price_cfa - b.offer.price_cfa,
  distance: (a, b) => (a.rank.distanceKm ?? 1e9) - (b.rank.distanceKm ?? 1e9),
  pickup: (a, b) => a.offer.pickup_start - b.offer.pickup_start,
  recommended: (a, b) => b.rank.score - a.rank.score,
};

/**
 * The catalogue as a customer sees it: live offers from active shops, ranked.
 * `include_sold_out` keeps sold-out cards visible (the app greys them out).
 */
export function listOffers({ user, category, q, merchantId, sort = 'recommended', includeSoldOut = false, limit = 100, offset = 0 } = {}) {
  refreshOfferStates();

  const where = [`m.status = 'active'`, `o.pickup_end > ?`];
  const params = [now()];
  where.push(includeSoldOut ? `o.status IN ('live','sold_out')` : `o.status = 'live'`);
  if (category && category !== 'Tout') { where.push('o.category = ?'); params.push(category); }
  if (merchantId) { where.push('o.merchant_id = ?'); params.push(merchantId); }
  if (q) {
    where.push('(o.name LIKE ? OR o.description LIKE ? OR m.name LIKE ? OR m.zone LIKE ? OR o.category LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }

  const rows = db.prepare(`${OFFER_SELECT} WHERE ${where.join(' AND ')}`).all(...params);
  const ctx = userContext(user);
  const scored = rows.map((offer) => ({ offer, rank: scoreOffer(offer, ctx) }));
  scored.sort(SORTS[sort] ?? SORTS.recommended);

  return {
    total: scored.length,
    items: scored.slice(offset, offset + limit),
    context: ctx,
  };
}

export const rankFor = (offer, user) => scoreOffer(offer, userContext(user));
export { offerState };
