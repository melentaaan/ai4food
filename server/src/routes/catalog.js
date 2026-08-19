import { Router } from 'express';
import { z } from 'zod';
import { db, now } from '../db.js';
import { uid, distanceKm } from '../lib/util.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { validate } from '../middleware/common.js';
import { requireAuth } from '../middleware/auth.js';
import { listOffers, getOfferRow, rankFor, userContext } from '../services/offers.js';
import { scoreOffer } from '../lib/rank.js';
import { publicOffer, publicMerchant } from '../presenters.js';
import { config } from '../config.js';
import { availablePaymentMethods } from '../lib/payments/providers.js';

export const router = Router();

const CATEGORIES = ['Restaurants', 'Hôtels', 'Supermarchés', 'Boulangeries', 'Marchés'];

/* ---------- offers ---------- */
const listQuery = z.object({
  category: z.string().optional(),
  q: z.string().trim().max(80).optional(),
  merchant_id: z.string().optional(),
  sort: z.enum(['recommended', 'price', 'distance', 'pickup']).default('recommended'),
  include_sold_out: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get('/offers', validate(listQuery, 'query'), (req, res) => {
  const p = req.validatedQuery;
  const { items, total } = listOffers({
    user: req.user, category: p.category, q: p.q, merchantId: p.merchant_id,
    sort: p.sort, includeSoldOut: p.include_sold_out, limit: p.limit, offset: p.offset,
  });
  res.json({
    total,
    limit: p.limit,
    offset: p.offset,
    // The ranking travels with each card so the app can show "why" without a
    // second round trip, and so every client orders the feed identically.
    items: items.map(({ offer, rank }) =>
      publicOffer(offer, {
        rank: { match: rank.match, reasons: rank.reasons, distance_km: rank.distanceKm },
        favourite: req.user ? isFavourite(req.user.id, offer.id) : false,
      })),
  });
});

function isFavourite(userId, offerId) {
  return !!db.prepare('SELECT 1 FROM favourites WHERE user_id = ? AND offer_id = ?').get(userId, offerId);
}

router.get('/offers/:id', (req, res) => {
  const offer = getOfferRow(req.params.id);
  if (!offer) throw notFound('That offer no longer exists');
  const rank = rankFor(offer, req.user);
  res.json({
    offer: publicOffer(offer, {
      favourite: req.user ? isFavourite(req.user.id, offer.id) : false,
    }),
    // Full breakdown behind the app's "why this offer?" sheet.
    why: { match: rank.match, factors: rank.factors, reasons: rank.reasons, distance_km: rank.distanceKm },
  });
});

router.put('/offers/:id/favourite', requireAuth, (req, res) => {
  const offer = getOfferRow(req.params.id);
  if (!offer) throw notFound('That offer no longer exists');
  db.prepare('INSERT OR IGNORE INTO favourites (user_id, offer_id, created_at) VALUES (?, ?, ?)')
    .run(req.user.id, offer.id, now());
  res.json({ favourite: true });
});

router.delete('/offers/:id/favourite', requireAuth, (req, res) => {
  db.prepare('DELETE FROM favourites WHERE user_id = ? AND offer_id = ?').run(req.user.id, req.params.id);
  res.json({ favourite: false });
});

router.get('/favourites', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT o.*, m.name AS merchant_name, m.zone, m.address, m.lat, m.lng, m.rating, m.reviews_count
         FROM favourites f
         JOIN offers o ON o.id = f.offer_id
         JOIN merchants m ON m.id = o.merchant_id
        WHERE f.user_id = ?
        ORDER BY f.created_at DESC`,
    )
    .all(req.user.id);
  const ctx = userContext(req.user);
  res.json({
    items: rows.map((offer) => {
      const rank = scoreOffer(offer, ctx);
      return publicOffer(offer, {
        favourite: true,
        rank: { match: rank.match, reasons: rank.reasons, distance_km: rank.distanceKm },
      });
    }),
  });
});

/* ---------- merchants (the map) ---------- */
const merchantQuery = z.object({
  category: z.string().optional(),
  zone: z.string().optional(),
  q: z.string().trim().max(80).optional(),
  partners_only: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

router.get('/merchants', validate(merchantQuery, 'query'), (req, res) => {
  const p = req.validatedQuery;
  const where = [`status <> 'suspended'`];
  const params = [];
  if (p.partners_only) where.push(`status = 'active'`);
  if (p.category && p.category !== 'Tout') { where.push('category = ?'); params.push(p.category); }
  if (p.zone) { where.push('zone = ?'); params.push(p.zone); }
  if (p.q) { where.push('(name LIKE ? OR zone LIKE ? OR category LIKE ?)'); params.push(`%${p.q}%`, `%${p.q}%`, `%${p.q}%`); }

  const rows = db.prepare(
    `SELECT m.*, (SELECT COUNT(*) FROM merchant_follows f WHERE f.merchant_id = m.id) AS followers
       FROM merchants m WHERE ${where.join(' AND ')} LIMIT ?`).all(...params, p.limit);
  const counts = db
    .prepare(`SELECT merchant_id, COUNT(*) AS n FROM offers WHERE status = 'live' AND pickup_end > ? GROUP BY merchant_id`)
    .all(now())
    .reduce((a, r) => ({ ...a, [r.merchant_id]: r.n }), {});
  const invited = req.user
    ? new Set(db.prepare('SELECT merchant_id FROM merchant_invites WHERE user_id = ?').all(req.user.id).map((r) => r.merchant_id))
    : new Set();
  const followed = req.user
    ? new Set(db.prepare('SELECT merchant_id FROM merchant_follows WHERE user_id = ?').all(req.user.id).map((r) => r.merchant_id))
    : new Set();
  const pos = req.user?.lat != null ? { lat: req.user.lat, lng: req.user.lng } : null;

  res.json({
    total: rows.length,
    items: rows.map((m) => publicMerchant(m, {
      live_offers: counts[m.id] ?? 0,
      invited: invited.has(m.id),
      following: followed.has(m.id),
      distance_km: distanceKm(pos, { lat: m.lat, lng: m.lng }),
    })),
  });
});

router.get('/merchants/:id', (req, res) => {
  const m = db.prepare(`SELECT * FROM merchants WHERE id = ? AND status <> 'suspended'`).get(req.params.id);
  if (!m) throw notFound('Shop not found');
  m.followers = db.prepare('SELECT COUNT(*) AS n FROM merchant_follows WHERE merchant_id = ?').get(m.id).n;
  const following = req.user
    ? !!db.prepare('SELECT 1 FROM merchant_follows WHERE user_id = ? AND merchant_id = ?').get(req.user.id, m.id)
    : false;
  const { items } = listOffers({ user: req.user, merchantId: m.id, includeSoldOut: true });
  res.json({
    merchant: publicMerchant(m, { live_offers: items.length, following }),
    offers: items.map(({ offer, rank }) =>
      publicOffer(offer, { rank: { match: rank.match, reasons: rank.reasons, distance_km: rank.distanceKm } })),
  });
});

/**
 * Following a shop is the durable relationship: bags come and go every evening,
 * the shop is what someone comes back for, and it is what new-bag alerts key on.
 */
router.put('/merchants/:id/follow', requireAuth, (req, res) => {
  const m = db.prepare(`SELECT * FROM merchants WHERE id = ? AND status <> 'suspended'`).get(req.params.id);
  if (!m) throw notFound('Shop not found');
  db.prepare('INSERT OR IGNORE INTO merchant_follows (user_id, merchant_id, created_at) VALUES (?,?,?)')
    .run(req.user.id, m.id, now());
  const followers = db.prepare('SELECT COUNT(*) AS n FROM merchant_follows WHERE merchant_id = ?').get(m.id).n;
  res.json({ following: true, followers });
});

router.delete('/merchants/:id/follow', requireAuth, (req, res) => {
  db.prepare('DELETE FROM merchant_follows WHERE user_id = ? AND merchant_id = ?')
    .run(req.user.id, req.params.id);
  const followers = db.prepare('SELECT COUNT(*) AS n FROM merchant_follows WHERE merchant_id = ?').get(req.params.id).n;
  res.json({ following: false, followers });
});

/** The shops this person follows, with whatever they have live right now. */
router.get('/follows', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT m.*, f.created_at AS followed_at,
            (SELECT COUNT(*) FROM merchant_follows x WHERE x.merchant_id = m.id) AS followers,
            (SELECT COUNT(*) FROM offers o WHERE o.merchant_id = m.id AND o.status = 'live' AND o.pickup_end > ?) AS live_offers
       FROM merchant_follows f JOIN merchants m ON m.id = f.merchant_id
      WHERE f.user_id = ? ORDER BY live_offers DESC, f.created_at DESC`).all(now(), req.user.id);
  const pos = req.user.lat != null ? { lat: req.user.lat, lng: req.user.lng } : null;
  res.json({
    items: rows.map((m) => publicMerchant(m, {
      following: true,
      live_offers: m.live_offers,
      distance_km: distanceKm(pos, { lat: m.lat, lng: m.lng }),
    })),
  });
});

/** "Invite this shop" — the customer-driven side of the growth pipeline. */
router.post('/merchants/:id/invite', requireAuth, (req, res) => {
  const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(req.params.id);
  if (!m) throw notFound('Shop not found');
  db.prepare('INSERT OR IGNORE INTO merchant_invites (id, merchant_id, user_id, created_at) VALUES (?, ?, ?, ?)')
    .run(uid(), m.id, req.user.id, now());
  audit(req, 'merchant.invite', 'merchant', m.id, {});
  const total = db.prepare('SELECT COUNT(*) AS n FROM merchant_invites WHERE merchant_id = ?').get(m.id).n;
  res.json({ invited: true, invites: total });
});

/* ---------- reference data for the client ---------- */
router.get('/meta', (_req, res) => {
  const zones = db.prepare('SELECT zone, COUNT(*) AS n FROM merchants GROUP BY zone ORDER BY n DESC').all();
  res.json({
    categories: CATEGORIES,
    zones: zones.map((z) => z.zone),
    // Only what there is a working provider for. A wallet without credentials
    // is not listed, so the app cannot offer a way to pay that does not exist.
    payment_methods: availablePaymentMethods(),
    locales: ['fr', 'en', 'wo'],
    cancel_window_minutes: config.cancelWindowMinutes,
    payment_window_minutes: config.paymentWindowMinutes,
  });
});
