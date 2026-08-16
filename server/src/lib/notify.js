import { db, now } from '../db.js';
import { uid } from './util.js';

/**
 * Notifications carry a kind plus structured data, never a rendered sentence:
 * the app speaks French, English and Wolof and picks the wording client-side.
 */
export function notify(userId, kind, payload = {}) {
  const id = uid();
  db.prepare(
    `INSERT INTO notifications (id, user_id, kind, payload, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, userId, kind, JSON.stringify(payload), now());
  return id;
}

/**
 * Who to tell when a shop publishes: everyone following it, plus anyone who
 * favourited one of its bags (a favourite is a weaker signal, but a real one).
 */
export function followersOfMerchant(merchantId, exceptUserId) {
  return db
    .prepare(
      `SELECT DISTINCT user_id AS id FROM (
         SELECT f.user_id FROM merchant_follows f WHERE f.merchant_id = ?
         UNION
         SELECT fa.user_id FROM favourites fa
           JOIN offers o ON o.id = fa.offer_id
          WHERE o.merchant_id = ?
       ) WHERE user_id <> ?`,
    )
    .all(merchantId, merchantId, exceptUserId ?? '')
    .map((r) => r.id);
}
