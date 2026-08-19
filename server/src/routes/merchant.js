import { Router } from 'express';
import { z } from 'zod';
import { db, now } from '../db.js';
import { uid, resolveWindow, toEpoch } from '../lib/util.js';
import { badRequest, conflict, notFound, forbidden } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { notify, followersOfMerchant } from '../lib/notify.js';
import { validate, writeLimiter } from '../middleware/common.js';
import { requireAuth, requireMerchant } from '../middleware/auth.js';
import { getOfferRow, refreshOfferStates, OFFER_SELECT } from '../services/offers.js';
import { validatePickup, ORDER_SELECT } from '../services/orders.js';
import { merchantStats, merchantForecast } from '../services/stats.js';
import { merchantOffer, merchantOrder, publicMerchant } from '../presenters.js';
import { bearerOfOrder } from '../services/transfers.js';

export const router = Router();

// Every route below is scoped to req.merchant — the shop the caller works for.
router.use(requireAuth, requireMerchant);

router.get('/profile', (req, res) => {
  res.json({
    merchant: publicMerchant(req.merchant, {
      status: req.merchant.status,
      commission_bps: req.merchant.commission_bps,
      phone: req.merchant.phone,
    }),
    staff_role: req.merchantRole ?? 'admin',
  });
});

/* ---------- offers ---------- */
const offerBody = z.object({
  // A bag is a surprise: the name is a type ('Panier surprise'), not a dish.
  name: z.string().trim().min(2).max(80).default('Panier surprise'),
  description: z.string().trim().max(400).default(''),
  image_key: z.string().trim().max(40).default('pain'),
  price_cfa: z.number().int().min(100).max(200000),
  was_cfa: z.number().int().min(100).max(500000),
  qty: z.number().int().min(1).max(200),
  pickup_from: z.string().regex(/^\d{2}:\d{2}$/),
  pickup_to: z.string().regex(/^\d{2}:\d{2}$/),
  pickup_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(['draft', 'live']).default('live'),
});

function assertSaneWindow(body) {
  if (body.was_cfa <= body.price_cfa) {
    throw badRequest('The shop value has to be higher than the sale price');
  }
  if (body.pickup_to <= body.pickup_from) {
    throw badRequest('The pickup window has to end after it starts');
  }
}

router.get('/offers',
  validate(z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), 'query'),
  (req, res) => {
    refreshOfferStates();
    const p = req.validatedQuery;
    const where = ['o.merchant_id = ?'];
    const params = [req.merchant.id];
    if (p.status) { where.push('o.status = ?'); params.push(p.status); }
    const rows = db
      .prepare(`${OFFER_SELECT} WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC LIMIT ?`)
      .all(...params, p.limit);
    const sold = db
      .prepare(
        `SELECT offer_id, SUM(qty) AS qty, SUM(total_cfa) AS revenue
           FROM orders WHERE merchant_id = ? AND status NOT IN ('cancelled','pending_payment')
          GROUP BY offer_id`,
      )
      .all(req.merchant.id)
      .reduce((a, r) => ({ ...a, [r.offer_id]: r }), {});
    res.json({ items: rows.map((o) => merchantOffer(o, sold[o.id] ?? { qty: 0, revenue: 0 })) });
  });

router.post('/offers', writeLimiter, validate(offerBody), (req, res) => {
  if (req.merchant.status !== 'active') {
    throw forbidden('Your shop has to be approved by AI4Food before publishing');
  }
  assertSaneWindow(req.body);
  const b = req.body;
  const win = b.pickup_date
    ? { date: b.pickup_date, start: toEpoch(b.pickup_date, b.pickup_from), end: toEpoch(b.pickup_date, b.pickup_to) }
    : resolveWindow(b.pickup_from, b.pickup_to);
  if (win.end <= now()) throw badRequest('That pickup window is already over');

  const id = uid();
  db.prepare(
    `INSERT INTO offers (id, merchant_id, name, description, image_key, category, price_cfa, was_cfa,
                         qty_total, qty_left, pickup_date, pickup_from, pickup_to, pickup_start, pickup_end,
                         status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, req.merchant.id, b.name, b.description, b.image_key, req.merchant.category,
    b.price_cfa, b.was_cfa, b.qty, b.qty, win.date, b.pickup_from, b.pickup_to, win.start, win.end,
    b.status, req.user.id, now(), now(),
  );

  if (b.status === 'live') {
    for (const userId of followersOfMerchant(req.merchant.id, req.user.id)) {
      notify(userId, 'new_offer', {
        offer_id: id, merchant_name: req.merchant.name, offer_name: b.name,
        price_cfa: b.price_cfa, was_cfa: b.was_cfa,
      });
    }
  }
  audit(req, 'offer.create', 'offer', id, { merchant_id: req.merchant.id, qty: b.qty, price_cfa: b.price_cfa });
  res.status(201).json({ offer: merchantOffer(getOfferRow(id)) });
});

router.patch('/offers/:id',
  writeLimiter,
  validate(offerBody.partial().extend({ qty: z.number().int().min(0).max(200).optional() })),
  (req, res) => {
    const offer = db.prepare('SELECT * FROM offers WHERE id = ? AND merchant_id = ?')
      .get(req.params.id, req.merchant.id);
    if (!offer) throw notFound('Offer not found');
    if (offer.status === 'cancelled') throw conflict('offer_closed', 'That offer is cancelled');

    const sold = offer.qty_total - offer.qty_left;
    const b = req.body;
    const next = {
      name: b.name ?? offer.name,
      description: b.description ?? offer.description,
      image_key: b.image_key ?? offer.image_key,
      price_cfa: b.price_cfa ?? offer.price_cfa,
      was_cfa: b.was_cfa ?? offer.was_cfa,
      pickup_from: b.pickup_from ?? offer.pickup_from,
      pickup_to: b.pickup_to ?? offer.pickup_to,
      status: b.status ?? (offer.status === 'expired' ? 'expired' : offer.status),
    };
    if (next.was_cfa <= next.price_cfa) throw badRequest('The shop value has to be higher than the sale price');
    if (next.pickup_to <= next.pickup_from) throw badRequest('The pickup window has to end after it starts');

    let qtyTotal = offer.qty_total;
    let qtyLeft = offer.qty_left;
    if (b.qty !== undefined) {
      if (b.qty < sold) throw conflict('below_sold', `${sold} already reserved, you cannot go under that`);
      qtyTotal = b.qty;
      qtyLeft = b.qty - sold;
    }
    const date = b.pickup_date ?? offer.pickup_date;
    db.prepare(
      `UPDATE offers SET name=?, description=?, image_key=?, price_cfa=?, was_cfa=?, qty_total=?, qty_left=?,
              pickup_date=?, pickup_from=?, pickup_to=?, pickup_start=?, pickup_end=?, status=?, updated_at=?
        WHERE id = ?`,
    ).run(
      next.name, next.description, next.image_key, next.price_cfa, next.was_cfa, qtyTotal, qtyLeft,
      date, next.pickup_from, next.pickup_to,
      toEpoch(date, next.pickup_from), toEpoch(date, next.pickup_to), next.status, now(), offer.id,
    );
    refreshOfferStates();
    audit(req, 'offer.update', 'offer', offer.id, { merchant_id: req.merchant.id, changes: Object.keys(b) });
    res.json({ offer: merchantOffer(getOfferRow(offer.id)) });
  });

/**
 * Pulling an offer never deletes it: reservations already made stay valid and
 * the customer keeps their code. Only the remaining stock comes off the shelf.
 */
router.post('/offers/:id/cancel', writeLimiter, (req, res) => {
  const offer = db.prepare('SELECT * FROM offers WHERE id = ? AND merchant_id = ?')
    .get(req.params.id, req.merchant.id);
  if (!offer) throw notFound('Offer not found');
  db.prepare(`UPDATE offers SET status = 'cancelled', qty_left = 0, updated_at = ? WHERE id = ?`).run(now(), offer.id);
  audit(req, 'offer.cancel', 'offer', offer.id, { merchant_id: req.merchant.id });
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE offer_id = ? AND status = 'active'`).get(offer.id).n;
  res.json({ offer: merchantOffer(getOfferRow(offer.id)), orders_still_to_honour: pending });
});

/* ---------- counter ---------- */
router.get('/orders',
  validate(z.object({
    status: z.enum(['active', 'picked_up', 'expired', 'cancelled']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }), 'query'),
  (req, res) => {
    const p = req.validatedQuery;
    // An order that has not been paid for is a hold, not a booking: it is the
    // customer's business with the wallet, and the counter never sees it.
    const where = ['ord.merchant_id = ?', `ord.status <> 'pending_payment'`];
    const params = [req.merchant.id];
    if (p.status) { where.push('ord.status = ?'); params.push(p.status); }
    const rows = db
      .prepare(`${ORDER_SELECT} WHERE ${where.join(' AND ')}
                 ORDER BY (ord.status = 'active') DESC, ord.created_at DESC LIMIT ?`)
      .all(...params, p.limit);
    // A name that does not match the booking is not a problem to solve at the
    // counter — it is a friend collecting, and the row says so.
    res.json({ items: rows.map((o) => merchantOrder(o, { bearer: bearerOfOrder(o.id) })) });
  });

router.post('/pickups/validate',
  writeLimiter,
  validate(z.object({ code: z.string().trim().min(4).max(10) })),
  (req, res) => {
    const order = validatePickup({ req, merchant: req.merchant, staffUser: req.user, code: req.body.code });
    res.json({ order: merchantOrder(order, { bearer: bearerOfOrder(order.id) }) });
  });

/* ---------- dashboard ---------- */
router.get('/stats',
  validate(z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }), 'query'),
  (req, res) => {
    res.json({ stats: merchantStats(req.merchant.id, req.validatedQuery.days) });
  });

router.get('/forecast', (req, res) => {
  res.json({ forecast: merchantForecast(req.merchant.id) });
});

/** One tap: turn tomorrow's forecast into a published offer. */
router.post('/forecast/publish',
  writeLimiter,
  validate(z.object({
    qty: z.number().int().min(1).max(200).optional(),
    price_cfa: z.number().int().min(100).max(200000).optional(),
    name: z.string().trim().min(2).max(80).optional(),
  })),
  (req, res) => {
    if (req.merchant.status !== 'active') throw forbidden('Your shop has to be approved by AI4Food before publishing');
    const f = merchantForecast(req.merchant.id);
    const qty = req.body.qty ?? f.predicted_surplus;
    const price = req.body.price_cfa ?? f.suggested_price_cfa;
    const was = Math.max(f.suggested_was_cfa, price + 500);
    const id = uid();
    db.prepare(
      `INSERT INTO offers (id, merchant_id, name, description, image_key, category, price_cfa, was_cfa,
                           qty_total, qty_left, pickup_date, pickup_from, pickup_to, pickup_start, pickup_end,
                           status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'live', ?, ?, ?)`,
    ).run(
      id, req.merchant.id, req.body.name ?? 'Panier surprise',
      'Les invendus du jour, composés par le commerce au moment du retrait.', 'pain',
      req.merchant.category, price, was, qty, qty, f.date, f.window.from, f.window.to,
      toEpoch(f.date, f.window.from), toEpoch(f.date, f.window.to), req.user.id, now(), now(),
    );
    for (const userId of followersOfMerchant(req.merchant.id, req.user.id)) {
      notify(userId, 'new_offer', {
        offer_id: id, merchant_name: req.merchant.name,
        offer_name: req.body.name ?? 'Panier surprise', price_cfa: price, was_cfa: was,
      });
    }
    audit(req, 'offer.create_from_forecast', 'offer', id, { merchant_id: req.merchant.id, qty, price_cfa: price });
    res.status(201).json({ offer: merchantOffer(getOfferRow(id)), forecast: f });
  });
