import { Router } from 'express';
import { z } from 'zod';
import { db, now } from '../db.js';
import { notFound } from '../lib/errors.js';
import { validate, writeLimiter } from '../middleware/common.js';
import { requireAuth } from '../middleware/auth.js';
import { reserveOffer, cancelOrder, getOrderRow, ORDER_SELECT, sendPickupReminders } from '../services/orders.js';
import { customerImpact } from '../services/stats.js';
import { customerOrder, notification } from '../presenters.js';

export const router = Router();

// requireAuth is attached per route rather than to the whole router: mounted at
// /api it would otherwise answer 401 for any unknown path under that prefix.

router.post('/orders',
  requireAuth, writeLimiter,
  validate(z.object({
    offer_id: z.string().min(1),
    qty: z.number().int().min(1).max(10).default(1),
    payment_method: z.enum(['wave', 'om', 'cash']),
  })),
  (req, res) => {
    const order = reserveOffer({
      req, user: req.user,
      offerId: req.body.offer_id, qty: req.body.qty, paymentMethod: req.body.payment_method,
    });
    res.status(201).json({ order: customerOrder(order) });
  });

/** Always filtered to the caller: there is no "all orders" for a customer. */
router.get('/orders',
  requireAuth,
  validate(z.object({
    status: z.enum(['active', 'picked_up', 'expired', 'cancelled']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }), 'query'),
  (req, res) => {
    const p = req.validatedQuery;
    const where = ['ord.user_id = ?'];
    const params = [req.user.id];
    if (p.status) { where.push('ord.status = ?'); params.push(p.status); }
    const rows = db
      .prepare(`${ORDER_SELECT} WHERE ${where.join(' AND ')} ORDER BY ord.created_at DESC LIMIT ?`)
      .all(...params, p.limit);
    res.json({ items: rows.map(customerOrder) });
  });

router.get('/orders/:id', requireAuth, (req, res) => {
  const order = getOrderRow(req.params.id);
  // A stranger's order id is indistinguishable from a wrong one, on purpose.
  if (!order || order.user_id !== req.user.id) throw notFound('Order not found');
  res.json({ order: customerOrder(order) });
});

router.post('/orders/:id/cancel',
  requireAuth, writeLimiter,
  validate(z.object({ reason: z.string().trim().max(200).optional() })),
  (req, res) => {
    const order = cancelOrder({ req, user: req.user, orderId: req.params.id, reason: req.body.reason });
    res.json({ order: customerOrder(order) });
  });

/* ---------- the customer's own numbers ---------- */
router.get('/me/impact', requireAuth, (req, res) => {
  res.json({ impact: customerImpact(req.user.id) });
});

/* ---------- notifications ---------- */
router.get('/notifications', requireAuth, (req, res) => {
  sendPickupReminders();
  const rows = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(req.user.id);
  res.json({
    unread: rows.filter((n) => !n.read_at).length,
    items: rows.map(notification),
  });
});

router.post('/notifications/read',
  requireAuth,
  validate(z.object({ ids: z.array(z.string()).optional() })),
  (req, res) => {
    if (req.body.ids?.length) {
      const stmt = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?');
      db.transaction(() => { for (const id of req.body.ids) stmt.run(now(), id, req.user.id); })();
    } else {
      db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
        .run(now(), req.user.id);
    }
    res.json({ ok: true });
  });
