import { Router } from 'express';
import { z } from 'zod';
import { db, now } from '../db.js';
import { notFound } from '../lib/errors.js';
import { validate, writeLimiter } from '../middleware/common.js';
import { requireAuth } from '../middleware/auth.js';
import { reserveAndPay, cancelOrderAndRefund, getOrderRow, ORDER_SELECT, sendPickupReminders } from '../services/orders.js';
import { latestPayment, refreshPayment } from '../services/payments.js';
import { paymentMethodIds } from '../lib/payments/providers.js';
import { customerImpact } from '../services/stats.js';
import {
  claimTransfer, claimedOrders, createTransfer, orderForToken, revokeTransfer,
  transferOfOrder, transfersForOrders,
} from '../services/transfers.js';
import { bearerOrder, customerOrder, notification, paymentInfo, transferInfo } from '../presenters.js';

export const router = Router();

// requireAuth is attached per route rather than to the whole router: mounted at
// /api it would otherwise answer 401 for any unknown path under that prefix.

// The accepted methods are whatever has a working provider behind it, so an
// unconfigured wallet is refused here as well as hidden in the app.
const paymentMethod = z.string().refine((v) => paymentMethodIds().includes(v), {
  message: 'That payment method is not available',
});

router.post('/orders',
  requireAuth, writeLimiter,
  validate(z.object({
    offer_id: z.string().min(1),
    qty: z.number().int().min(1).max(10).default(1),
    payment_method: paymentMethod,
    // Where to send the customer back to after the wallet. Only ever used to
    // build the return link, never trusted as an origin.
    return_url: z.string().url().max(500).optional(),
  })),
  async (req, res) => {
    const { order, payment } = await reserveAndPay({
      req, user: req.user,
      offerId: req.body.offer_id, qty: req.body.qty, paymentMethod: req.body.payment_method,
      appUrl: req.body.return_url,
    });
    res.status(201).json({ order: customerOrder(order), payment: paymentInfo(payment) });
  });

/**
 * "Did my payment go through?" — asked by the app when the customer comes back
 * from the wallet, because the callback and the customer race each other and
 * whichever arrives first should be enough.
 */
router.post('/orders/:id/payment/refresh', requireAuth, writeLimiter, async (req, res) => {
  const order = getOrderRow(req.params.id);
  if (!order || order.user_id !== req.user.id) throw notFound('Order not found');
  const payment = latestPayment(order.id);
  if (!payment) return res.json({ order: customerOrder(order), payment: null });
  const out = await refreshPayment(payment);
  res.json({
    order: customerOrder(getOrderRow(order.id)),
    payment: paymentInfo(out.payment),
  });
});

/** Always filtered to the caller: there is no "all orders" for a customer. */
router.get('/orders',
  requireAuth,
  validate(z.object({
    status: z.enum(['pending_payment', 'active', 'picked_up', 'expired', 'cancelled']).optional(),
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
    const transfers = transfersForOrders(rows.map((o) => o.id));
    res.json({
      items: rows.map((o) => customerOrder(o, {
        transfer: transfers[o.id] ? transferInfo(transfers[o.id]) : null,
        // Only while it is still owed: a settled order has nowhere to go back to.
        payment: o.status === 'pending_payment' ? paymentInfo(latestPayment(o.id)) : null,
      })),
      // Bags someone else booked and handed to this person. Deliberately the
      // bearer view, not the customer one: accepting a link does not open up
      // what the sender paid.
      for_me: claimedOrders(req.user.id)
        .filter(({ order }) => order.status === 'active')
        .map(({ order, transfer }) => bearerOrder(order, transfer, { token: transfer.token })),
    });
  });

router.get('/orders/:id', requireAuth, (req, res) => {
  const order = getOrderRow(req.params.id);
  // A stranger's order id is indistinguishable from a wrong one, on purpose.
  if (!order || order.user_id !== req.user.id) throw notFound('Order not found');
  const tr = transferOfOrder(order.id);
  res.json({
    order: customerOrder(order, {
      transfer: tr ? transferInfo(tr) : null,
      payment: order.status === 'pending_payment' ? paymentInfo(latestPayment(order.id)) : null,
    }),
  });
});

/* ---------- handing a reservation to someone else ---------- */

/**
 * Someone books a bag and then cannot make the window. Rather than lose it,
 * they send a link and a friend collects. The link is the whole mechanism:
 * whoever holds it can show the code, because that is what a paid bag is.
 */
router.post('/orders/:id/transfer',
  requireAuth, writeLimiter,
  validate(z.object({
    to_name: z.string().trim().max(60).optional(),
    note: z.string().trim().max(200).optional(),
  })),
  (req, res) => {
    const tr = createTransfer({
      req, user: req.user, orderId: req.params.id,
      toName: req.body.to_name, note: req.body.note,
    });
    res.status(201).json({ transfer: transferInfo(tr) });
  });

router.delete('/orders/:id/transfer', requireAuth, (req, res) => {
  revokeTransfer({ req, user: req.user, orderId: req.params.id });
  res.json({ transfer: null });
});

/** Open to anyone holding the link — the friend may well have no account. */
router.get('/pickup/:token', (req, res) => {
  const { transfer, order } = orderForToken(req.params.token);
  res.json({
    pickup: bearerOrder(order, transfer, {
      mine: req.user ? order.user_id === req.user.id : false,
      claimed_by_me: req.user ? transfer.claimed_by === req.user.id : false,
    }),
  });
});

/** Optional: signing in and accepting puts the bag in the friend's own list. */
router.post('/pickup/:token/claim', requireAuth, writeLimiter, (req, res) => {
  const { transfer, order } = claimTransfer({ req, user: req.user, tok: req.params.token });
  res.json({ pickup: bearerOrder(order, transfer, { mine: false, claimed_by_me: true }) });
});

router.post('/orders/:id/cancel',
  requireAuth, writeLimiter,
  validate(z.object({ reason: z.string().trim().max(200).optional() })),
  async (req, res) => {
    const { order, refund } = await cancelOrderAndRefund({
      req, user: req.user, orderId: req.params.id, reason: req.body.reason,
    });
    res.json({ order: customerOrder(order), refund });
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
