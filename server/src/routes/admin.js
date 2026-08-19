import { Router } from 'express';
import { z } from 'zod';
import { db, now } from '../db.js';
import { uid } from '../lib/util.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { hashPassword, normalisePhone, revokeAllRefreshTokens } from '../lib/auth.js';
import { config } from '../config.js';
import { validate, writeLimiter } from '../middleware/common.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ORDER_SELECT, cancelOrderAndRefund, expireStaleOrders, getOrderRow } from '../services/orders.js';
import {
  advancePayout, defaultPeriod, failedRefunds, getPayout, listPayouts,
  openPayoutRun, payoutEvents, unpaidEarnings,
} from '../services/payouts.js';
import { refundOrder } from '../services/payments.js';
import { OFFER_SELECT, refreshOfferStates } from '../services/offers.js';
import { adminOverview, adminPayouts } from '../services/stats.js';
import { adminOrder, adminMerchant, adminUser, merchantOffer } from '../presenters.js';

export const router = Router();

// Nothing below is reachable without an admin token.
router.use(requireAuth, requireRole('admin'));

/* ---------- the daily picture ---------- */
router.get('/overview',
  validate(z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }), 'query'),
  (req, res) => {
    refreshOfferStates();
    res.json({ overview: adminOverview(req.validatedQuery.days) });
  });

/* ---------- operations: every order on the platform ---------- */
router.get('/orders',
  validate(z.object({
    status: z.enum(['pending_payment', 'active', 'picked_up', 'expired', 'cancelled']).optional(),
    merchant_id: z.string().optional(),
    user_id: z.string().optional(),
    q: z.string().trim().max(40).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }), 'query'),
  (req, res) => {
    const p = req.validatedQuery;
    const where = ['1 = 1'];
    const params = [];
    if (p.status) { where.push('ord.status = ?'); params.push(p.status); }
    if (p.merchant_id) { where.push('ord.merchant_id = ?'); params.push(p.merchant_id); }
    if (p.user_id) { where.push('ord.user_id = ?'); params.push(p.user_id); }
    if (p.q) { where.push('(ord.code LIKE ? OR m.name LIKE ? OR o.name LIKE ?)'); params.push(`%${p.q}%`, `%${p.q}%`, `%${p.q}%`); }

    const total = db.prepare(
      `SELECT COUNT(*) AS n FROM orders ord
         JOIN merchants m ON m.id = ord.merchant_id
         JOIN offers o ON o.id = ord.offer_id
        WHERE ${where.join(' AND ')}`).get(...params).n;
    const rows = db
      .prepare(`${ORDER_SELECT} WHERE ${where.join(' AND ')} ORDER BY ord.created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, p.limit, p.offset);
    res.json({ total, items: rows.map(adminOrder) });
  });

/** Support action: refund and put the stock back, outside the customer window. */
router.post('/orders/:id/cancel',
  writeLimiter,
  validate(z.object({ reason: z.string().trim().max(200) })),
  async (req, res) => {
    const { order, refund } = await cancelOrderAndRefund({
      req, user: req.user, orderId: req.params.id, reason: req.body.reason,
    });
    res.json({ order: adminOrder(order), refund });
  });


/* ---------- shops asking to join ---------- */
router.get('/applications',
  validate(z.object({
    status: z.enum(['submitted', 'reviewing', 'needs_info', 'approved', 'rejected']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }), 'query'),
  (req, res) => {
    const p = req.validatedQuery;
    const where = [];
    const params = [];
    if (p.status) { where.push('a.status = ?'); params.push(p.status); }
    const rows = db
      .prepare(`SELECT a.*, u.name AS reviewer_name
                  FROM merchant_applications a
                  LEFT JOIN users u ON u.id = a.reviewed_by
                  ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY a.created_at DESC LIMIT ?`)
      .all(...params, p.limit);
    const counts = db
      .prepare('SELECT status, COUNT(*) AS n FROM merchant_applications GROUP BY status')
      .all().reduce((a, r) => ({ ...a, [r.status]: r.n }), {});
    res.json({ counts, items: rows });
  });

/**
 * Reviewing one. Approving creates the shop it becomes — as a `pending`
 * merchant, never an active one, because a shop that can publish is a decision
 * about the customers' screen and deserves its own deliberate step.
 */
router.patch('/applications/:id',
  writeLimiter,
  validate(z.object({
    status: z.enum(['reviewing', 'needs_info', 'approved', 'rejected']),
    note: z.string().trim().max(400).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })),
  (req, res) => {
    const a = db.prepare('SELECT * FROM merchant_applications WHERE id = ?').get(req.params.id);
    if (!a) throw notFound('Application not found');
    if (a.status === 'approved') throw conflict('already_approved', 'That application is already approved');

    let merchantId = a.merchant_id;
    if (req.body.status === 'approved') {
      if (req.body.lat == null || req.body.lng == null) {
        throw badRequest('Approving needs the shop pinned: send lat and lng');
      }
      const slug = `${a.business_name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${uid().slice(0, 4)}`;
      merchantId = uid();
      db.prepare(
        `INSERT INTO merchants (id, name, slug, category, zone, address, lat, lng, phone, status,
                                commission_bps, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`,
      ).run(merchantId, a.business_name, slug, a.category, a.zone, a.address ?? '',
        req.body.lat, req.body.lng, a.phone, config.defaultCommissionBps, now());
    }

    db.prepare(
      `UPDATE merchant_applications SET status = ?, review_note = COALESCE(?, review_note),
              merchant_id = COALESCE(?, merchant_id), reviewed_at = ?, reviewed_by = ?
        WHERE id = ?`,
    ).run(req.body.status, req.body.note ?? null, merchantId ?? null, now(), req.user.id, a.id);

    audit(req, `application.${req.body.status}`, 'application', a.id, { merchant_id: merchantId ?? null });
    res.json({ application: db.prepare('SELECT * FROM merchant_applications WHERE id = ?').get(a.id) });
  });

/* ---------- refunds that did not land ---------- */
router.get('/refunds/failed', (_req, res) => {
  const items = failedRefunds();
  res.json({ total: items.length, owed_cfa: items.reduce((a, r) => a + r.total_cfa, 0), items });
});

/** Try a stuck refund again, by hand, once whatever broke has been fixed. */
router.post('/refunds/:orderId/retry', writeLimiter, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);
  if (!order) throw notFound('Order not found');
  if (order.status !== 'cancelled' || order.payment_status !== 'paid') {
    throw conflict('nothing_to_refund', 'That order is not waiting on a refund');
  }
  const out = await refundOrder(order);
  audit(req, 'order.refund_retry', 'order', order.id, { refunded: out.refunded });
  res.json({ refund: out, order: adminOrder(getOrderRow(order.id)) });
});

/* ---------- growth pipeline ---------- */
router.get('/merchants',
  validate(z.object({
    status: z.enum(['prospect', 'pending', 'active', 'suspended']).optional(),
    q: z.string().trim().max(60).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  }), 'query'),
  (req, res) => {
    const p = req.validatedQuery;
    const where = ['1 = 1'];
    const params = [];
    if (p.status) { where.push('m.status = ?'); params.push(p.status); }
    if (p.q) { where.push('(m.name LIKE ? OR m.zone LIKE ?)'); params.push(`%${p.q}%`, `%${p.q}%`); }

    const rows = db.prepare(
      `SELECT m.*,
              (SELECT COUNT(*) FROM merchant_invites i WHERE i.merchant_id = m.id) AS invites,
              (SELECT COUNT(*) FROM offers o WHERE o.merchant_id = m.id AND o.status = 'live') AS live_offers,
              (SELECT COALESCE(SUM(o.total_cfa),0) FROM orders o WHERE o.merchant_id = m.id AND o.status = 'picked_up') AS gross_cfa
         FROM merchants m
        WHERE ${where.join(' AND ')}
        ORDER BY invites DESC, m.name LIMIT ? OFFSET ?`).all(...params, p.limit, p.offset);

    const total = db.prepare(`SELECT COUNT(*) AS n FROM merchants m WHERE ${where.join(' AND ')}`).get(...params).n;
    res.json({
      total,
      items: rows.map((m) => adminMerchant(m, {
        invites: m.invites, live_offers: m.live_offers, gross_cfa: m.gross_cfa,
      })),
    });
  });

router.post('/merchants',
  writeLimiter,
  validate(z.object({
    name: z.string().trim().min(2).max(80),
    category: z.enum(['Restaurants', 'Hôtels', 'Supermarchés', 'Boulangeries', 'Marchés']),
    zone: z.string().trim().min(2).max(60),
    address: z.string().trim().max(160).default(''),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    phone: z.string().trim().max(30).optional(),
    status: z.enum(['prospect', 'pending', 'active']).default('pending'),
    commission_bps: z.number().int().min(0).max(5000).optional(),
  })),
  (req, res) => {
    const b = req.body;
    const slug = b.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + uid().slice(0, 4);
    const id = uid();
    db.prepare(
      `INSERT INTO merchants (id, name, slug, category, zone, address, lat, lng, phone, status,
                              commission_bps, created_at, approved_at, approved_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, b.name, slug, b.category, b.zone, b.address, b.lat, b.lng, b.phone ?? null, b.status,
      b.commission_bps ?? 1500, now(),
      b.status === 'active' ? now() : null, b.status === 'active' ? req.user.id : null,
    );
    audit(req, 'merchant.create', 'merchant', id, { name: b.name, status: b.status });
    res.status(201).json({ merchant: adminMerchant(db.prepare('SELECT * FROM merchants WHERE id = ?').get(id)) });
  });

/** Approving a shop is what lets it publish; suspending stops it immediately. */
router.patch('/merchants/:id',
  writeLimiter,
  validate(z.object({
    status: z.enum(['prospect', 'pending', 'active', 'suspended']).optional(),
    commission_bps: z.number().int().min(0).max(5000).optional(),
    phone: z.string().trim().max(30).optional(),
    zone: z.string().trim().max(60).optional(),
    address: z.string().trim().max(160).optional(),
  })),
  (req, res) => {
    const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(req.params.id);
    if (!m) throw notFound('Shop not found');
    const b = req.body;
    if (!Object.keys(b).length) throw badRequest('Nothing to change');

    const sets = [];
    const params = [];
    for (const key of ['status', 'commission_bps', 'phone', 'zone', 'address']) {
      if (b[key] !== undefined) { sets.push(`${key} = ?`); params.push(b[key]); }
    }
    if (b.status === 'active' && m.status !== 'active') {
      sets.push('approved_at = ?', 'approved_by = ?');
      params.push(now(), req.user.id);
    }
    db.prepare(`UPDATE merchants SET ${sets.join(', ')} WHERE id = ?`).run(...params, m.id);

    // A suspended shop must not keep selling: pull its live stock.
    if (b.status === 'suspended') {
      db.prepare(`UPDATE offers SET status = 'cancelled', qty_left = 0, updated_at = ?
                   WHERE merchant_id = ? AND status IN ('live','draft')`).run(now(), m.id);
    }
    audit(req, 'merchant.update', 'merchant', m.id, b);
    res.json({ merchant: adminMerchant(db.prepare('SELECT * FROM merchants WHERE id = ?').get(m.id)) });
  });

/** Creates (or promotes) the account that will run a shop's counter. */
router.post('/merchants/:id/staff',
  writeLimiter,
  validate(z.object({
    phone: z.string().min(6),
    name: z.string().trim().min(2).max(60),
    password: z.string().min(8).max(72).optional(),
    role: z.enum(['owner', 'staff']).default('owner'),
  })),
  (req, res) => {
    const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(req.params.id);
    if (!m) throw notFound('Shop not found');
    const phone = normalisePhone(req.body.phone);

    let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user) {
      const id = uid();
      db.prepare(
        `INSERT INTO users (id, phone, name, role, password_hash, zone, created_at)
         VALUES (?, ?, ?, 'merchant', ?, ?, ?)`,
      ).run(id, phone, req.body.name, req.body.password ? hashPassword(req.body.password) : null, m.zone, now());
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    } else {
      if (user.role === 'admin') throw conflict('is_admin', 'That account is an administrator');
      db.prepare(`UPDATE users SET role = 'merchant', name = ?, password_hash = COALESCE(?, password_hash) WHERE id = ?`)
        .run(req.body.name, req.body.password ? hashPassword(req.body.password) : null, user.id);
    }
    db.prepare('INSERT OR IGNORE INTO merchant_users (merchant_id, user_id, role, created_at) VALUES (?,?,?,?)')
      .run(m.id, user.id, req.body.role, now());
    audit(req, 'merchant.staff_add', 'merchant', m.id, { user_id: user.id, role: req.body.role });
    res.status(201).json({ user: adminUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
  });

/* ---------- people ---------- */
router.get('/users',
  validate(z.object({
    role: z.enum(['customer', 'merchant', 'admin']).optional(),
    status: z.enum(['active', 'suspended']).optional(),
    q: z.string().trim().max(40).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }), 'query'),
  (req, res) => {
    const p = req.validatedQuery;
    const where = ['1 = 1'];
    const params = [];
    if (p.role) { where.push('u.role = ?'); params.push(p.role); }
    if (p.status) { where.push('u.status = ?'); params.push(p.status); }
    if (p.q) { where.push('(u.name LIKE ? OR u.phone LIKE ?)'); params.push(`%${p.q}%`, `%${p.q}%`); }

    const rows = db.prepare(
      `SELECT u.*,
              (SELECT COUNT(*) FROM orders o
                WHERE o.user_id = u.id AND o.status NOT IN ('cancelled','pending_payment')) AS orders,
              (SELECT COALESCE(SUM(o.total_cfa),0) FROM orders o WHERE o.user_id = u.id AND o.status = 'picked_up') AS spend_cfa
         FROM users u WHERE ${where.join(' AND ')}
        ORDER BY u.created_at DESC LIMIT ? OFFSET ?`).all(...params, p.limit, p.offset);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${where.join(' AND ')}`).get(...params).n;
    res.json({
      total,
      items: rows.map((u) => adminUser(u, { orders: u.orders, spend_cfa: u.spend_cfa })),
    });
  });

router.patch('/users/:id',
  writeLimiter,
  validate(z.object({
    status: z.enum(['active', 'suspended']).optional(),
    role: z.enum(['customer', 'merchant', 'admin']).optional(),
    name: z.string().trim().min(1).max(60).optional(),
  })),
  (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) throw notFound('User not found');
    if (u.id === req.user.id && (req.body.status === 'suspended' || (req.body.role && req.body.role !== 'admin'))) {
      throw conflict('self_lockout', 'You cannot demote or suspend your own account');
    }
    const sets = [];
    const params = [];
    for (const key of ['status', 'role', 'name']) {
      if (req.body[key] !== undefined) { sets.push(`${key} = ?`); params.push(req.body[key]); }
    }
    if (!sets.length) throw badRequest('Nothing to change');
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params, u.id);
    // Suspension or a role change has to end the sessions already out there.
    if (req.body.status === 'suspended' || req.body.role) revokeAllRefreshTokens(u.id);
    audit(req, 'user.update', 'user', u.id, req.body);
    res.json({ user: adminUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
  });

/* ---------- moderation ---------- */
router.get('/offers',
  validate(z.object({
    status: z.string().optional(),
    merchant_id: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }), 'query'),
  (req, res) => {
    const p = req.validatedQuery;
    const where = ['1 = 1'];
    const params = [];
    if (p.status) { where.push('o.status = ?'); params.push(p.status); }
    if (p.merchant_id) { where.push('o.merchant_id = ?'); params.push(p.merchant_id); }
    const rows = db.prepare(`${OFFER_SELECT} WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC LIMIT ?`)
      .all(...params, p.limit);
    res.json({ items: rows.map((o) => merchantOffer(o)) });
  });

router.post('/offers/:id/cancel',
  writeLimiter,
  validate(z.object({ reason: z.string().trim().max(200) })),
  (req, res) => {
    const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
    if (!offer) throw notFound('Offer not found');
    db.prepare(`UPDATE offers SET status = 'cancelled', qty_left = 0, updated_at = ? WHERE id = ?`).run(now(), offer.id);
    audit(req, 'offer.admin_cancel', 'offer', offer.id, { reason: req.body.reason });
    res.json({ ok: true });
  });

/* ---------- money ---------- */
/** What we owe, computed from collected orders. Not a record of any transfer. */
router.get('/payouts',
  validate(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), 'query'),
  (req, res) => {
    const rows = adminPayouts(req.validatedQuery.days);
    res.json({
      days: req.validatedQuery.days,
      note: 'owed, computed from collected orders — see /payouts/runs for what has actually been sent',
      totals: {
        gross_cfa: rows.reduce((a, r) => a + r.gross_cfa, 0),
        commission_cfa: rows.reduce((a, r) => a + r.commission_cfa, 0),
        payout_cfa: rows.reduce((a, r) => a + r.payout_cfa, 0),
      },
      items: rows,
    });
  });

/* ---------- payout runs: what actually left our account ---------- */
router.get('/payouts/runs',
  validate(z.object({
    status: z.enum(['owed', 'scheduled', 'processing', 'paid', 'failed']).optional(),
    merchant_id: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }), 'query'),
  (req, res) => {
    const p = req.validatedQuery;
    res.json(listPayouts({ status: p.status, merchantId: p.merchant_id, limit: p.limit }));
  });

/** Draws up payouts for a period. Running it twice does not pay anyone twice. */
router.post('/payouts/runs',
  writeLimiter,
  validate(z.object({
    days: z.coerce.number().int().min(1).max(365).default(30),
  })),
  (req, res) => {
    const [from, to] = defaultPeriod(req.body.days);
    const made = openPayoutRun({ req, from, to, actorId: req.user.id });
    audit(req, 'payout.run', 'payout', 'run', { days: req.body.days, created: made.length });
    res.status(201).json({ period: { from, to }, created: made.length, items: made });
  });

router.get('/payouts/runs/:id', (req, res) => {
  const p = getPayout(req.params.id);
  if (!p) throw notFound('Payout not found');
  res.json({ payout: p, events: payoutEvents(p.id) });
});

/**
 * Moving a payout along. Marking one paid needs the transfer reference: a
 * payout nobody can trace against a statement is not evidence of anything.
 */
router.post('/payouts/runs/:id/status',
  writeLimiter,
  validate(z.object({
    status: z.enum(['scheduled', 'processing', 'paid', 'failed', 'owed']),
    reference: z.string().trim().max(120).optional(),
    method: z.enum(['wave', 'om', 'bank', 'cash']).optional(),
    note: z.string().trim().max(300).optional(),
  })),
  (req, res) => {
    const p = advancePayout({
      id: req.params.id, status: req.body.status, reference: req.body.reference,
      method: req.body.method, note: req.body.note, actorId: req.user.id,
    });
    audit(req, `payout.${req.body.status}`, 'payout', p.id, {
      amount_cfa: p.amount_cfa, reference: req.body.reference ?? null,
    });
    res.json({ payout: p, events: payoutEvents(p.id) });
  });

/** What a period would draw up, before anyone commits to it. */
router.get('/payouts/preview',
  validate(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), 'query'),
  (req, res) => {
    const [from, to] = defaultPeriod(req.validatedQuery.days);
    const items = unpaidEarnings(from, to);
    res.json({ period: { from, to }, total_cfa: items.reduce((a, r) => a + r.amount_cfa, 0), items });
  });

/* ---------- paper trail ---------- */
router.get('/audit',
  validate(z.object({
    action: z.string().optional(),
    entity_id: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }), 'query'),
  (req, res) => {
    const p = req.validatedQuery;
    const where = ['1 = 1'];
    const params = [];
    if (p.action) { where.push('a.action LIKE ?'); params.push(`${p.action}%`); }
    if (p.entity_id) { where.push('a.entity_id = ?'); params.push(p.entity_id); }
    const rows = db.prepare(
      `SELECT a.*, u.name AS actor_name FROM audit_log a
         LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT ?`).all(...params, p.limit);
    res.json({
      items: rows.map((r) => ({
        id: r.id, action: r.action, entity: r.entity, entity_id: r.entity_id,
        actor: r.actor_user_id ? { id: r.actor_user_id, name: r.actor_name, role: r.actor_role } : null,
        meta: JSON.parse(r.meta || '{}'), created_at: r.created_at,
      })),
    });
  });

/** Manual trigger for the housekeeping the scheduler runs anyway. */
router.post('/maintenance/expire', writeLimiter, (req, res) => {
  const expired = expireStaleOrders();
  audit(req, 'maintenance.expire', null, null, { expired });
  res.json({ expired });
});
