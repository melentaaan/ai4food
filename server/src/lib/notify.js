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

/** Everyone who favourited an offer from this merchant, minus the actor. */
export function followersOfMerchant(merchantId, exceptUserId) {
  return db
    .prepare(
      `SELECT DISTINCT f.user_id AS id
         FROM favourites f
         JOIN offers o ON o.id = f.offer_id
        WHERE o.merchant_id = ? AND f.user_id <> ?`,
    )
    .all(merchantId, exceptUserId ?? '')
    .map((r) => r.id);
}
