import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { uid } from '../lib/util.js';
import { unauthorized, forbidden, conflict } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { notify } from '../lib/notify.js';
import {
  normalisePhone, issueOtp, burnOtp, consumeOtp, signAccessToken, issueRefreshToken,
  rotateRefreshToken, revokeRefreshToken, verifyPassword, hashPassword,
  issueReset, consumeReset, burnReset, revokeAllRefreshTokens,
} from '../lib/auth.js';
import { validate, otpLimiter, loginLimiter, writeLimiter } from '../middleware/common.js';
import { sendSms } from '../lib/sms/index.js';
import { ApiError } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { selfUser } from '../presenters.js';

export const router = Router();

const session = (user, req) => ({
  access_token: signAccessToken(user),
  refresh_token: issueRefreshToken(user.id, req.get('user-agent')),
  expires_in: config.accessTtlSeconds,
  user: selfUser(user, merchantContext(user)),
});

/** A merchant account carries the shop it belongs to; other roles carry nothing extra. */
export function merchantContext(user) {
  if (user.role !== 'merchant') return {};
  const row = db
    .prepare(
      `SELECT m.id, m.name, m.status, m.zone, m.commission_bps, mu.role AS staff_role
         FROM merchant_users mu JOIN merchants m ON m.id = mu.merchant_id
        WHERE mu.user_id = ? ORDER BY mu.created_at LIMIT 1`,
    )
    .get(user.id);
  return row ? { merchant: row } : {};
}

/* ---------- customers: phone + one-time code ---------- */
router.post('/otp/request',
  otpLimiter,
  validate(z.object({
    phone: z.string().min(6),
    locale: z.enum(['fr', 'en', 'wo']).optional(),
  })),
  async (req, res) => {
    const phone = normalisePhone(req.body.phone);
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (user && user.status === 'suspended') throw forbidden('This account is suspended');

    const { id, code } = issueOtp(phone);
    const locale = req.body.locale || user?.locale || 'fr';

    try {
      await sendSms({ to: phone, kind: 'otp', locale, args: [code] });
    } catch (err) {
      // The code exists but nobody can read it, so retire it rather than leave
      // a live code nobody asked for, and say plainly that the message is the
      // part that failed — "wrong number" and "our gateway is down" are very
      // different problems for the person holding the phone.
      burnOtp(id);
      console.error('[auth] could not deliver a sign-in code', { phone, error: err?.message || err });
      throw new ApiError(502, 'sms_failed',
        'We could not send the code to that number. Check it, or try again in a moment.');
    }

    // Deliberately silent about whether that number has an account. Telling a
    // stranger which phone numbers are registered is a question they should
    // not get to ask, and the app does not need the answer until the code is
    // verified — at which point it is the account holder asking.
    res.json({
      sent: true,
      expires_in: config.otpTtlSeconds,
      ...(config.otpEcho ? { dev_code: code } : {}),
    });
  });

router.post('/otp/verify',
  otpLimiter,
  validate(z.object({
    phone: z.string().min(6),
    code: z.string().min(4).max(8),
    name: z.string().trim().min(1).max(60).optional(),
    zone: z.string().trim().max(60).optional(),
    locale: z.enum(['fr', 'en', 'wo']).optional(),
  })),
  (req, res) => {
    const phone = normalisePhone(req.body.phone);
    consumeOtp(phone, req.body.code);

    let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    const isNew = !user;
    if (!user) {
      const id = uid();
      db.prepare(
        `INSERT INTO users (id, phone, name, role, zone, locale, created_at)
         VALUES (?, ?, ?, 'customer', ?, ?, ?)`,
      ).run(id, phone, req.body.name || 'Client AI4Food', req.body.zone || 'Plateau', req.body.locale || 'fr', now());
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      notify(user.id, 'welcome', {});
      audit({ ...req, user }, 'user.signup', 'user', user.id, { channel: 'otp' });
    } else if (user.status !== 'active') {
      throw forbidden('This account is suspended');
    }
    // Safe here in a way it was not at the request step: whoever is holding
    // this code is the person whose phone it is.
    res.json({ ...session(user, req), is_new_account: isNew });
  });

/* ---------- a customer's own data, and the way out ---------- */

/**
 * Everything we hold about the person asking, and nothing about anybody else.
 * Their orders name the shop they bought from — that is their receipt — but no
 * other customer appears anywhere in it.
 */
router.get('/me/export', requireAuth, (req, res) => {
  const u = req.user;
  const orders = db
    .prepare(
      `SELECT ord.id, ord.code, ord.qty, ord.total_cfa, ord.was_total_cfa, ord.commission_cfa,
              ord.payment_method, ord.payment_status, ord.status, ord.created_at,
              ord.picked_up_at, ord.cancelled_at, ord.cancel_reason,
              o.name AS offer_name, o.category, m.name AS merchant_name, m.zone
         FROM orders ord
         JOIN offers o    ON o.id = ord.offer_id
         JOIN merchants m ON m.id = ord.merchant_id
        WHERE ord.user_id = ? ORDER BY ord.created_at DESC`,
    )
    .all(u.id);

  res.setHeader('Content-Disposition', `attachment; filename="ai4food-${u.id}.json"`);
  res.json({
    exported_at: now(),
    account: {
      id: u.id, name: u.name, phone: u.phone, email: u.email ?? null,
      role: u.role, zone: u.zone, lat: u.lat, lng: u.lng, locale: u.locale,
      created_at: u.created_at,
    },
    orders,
    favourites: db.prepare(
      `SELECT f.created_at, o.name AS offer_name, m.name AS merchant_name
         FROM favourites f JOIN offers o ON o.id = f.offer_id
         JOIN merchants m ON m.id = o.merchant_id WHERE f.user_id = ?`).all(u.id),
    following: db.prepare(
      `SELECT f.created_at, m.name AS merchant_name, m.zone
         FROM merchant_follows f JOIN merchants m ON m.id = f.merchant_id
        WHERE f.user_id = ?`).all(u.id),
    notifications: db.prepare(
      'SELECT kind, payload, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC')
      .all(u.id),
    sign_in_messages: db.prepare(
      `SELECT kind, provider, status, created_at FROM sms_messages WHERE phone = ? ORDER BY created_at DESC`)
      .all(u.phone),
  });
});

/**
 * Closing an account. What can go, goes; what a shop's books depend on stays,
 * with the person taken out of it.
 *
 * An order is half a shop's record: their takings, their commission, the
 * payout we owe them. Deleting the row would quietly rewrite somebody else's
 * accounts, so instead the account is emptied of the person — name, phone,
 * location, notifications, favourites, sessions — and the orders keep their
 * amounts attached to a subject who is no longer anyone.
 */
router.delete('/me',
  requireAuth, writeLimiter,
  validate(z.object({ confirm: z.literal('DELETE') })),
  (req, res) => {
    const u = req.user;
    if (u.role !== 'customer') {
      throw forbidden('Staff accounts are closed by AI4Food, not from the app');
    }
    const live = db
      .prepare(`SELECT COUNT(*) AS n FROM orders
                 WHERE user_id = ? AND status IN ('active','pending_payment')`)
      .get(u.id).n;
    if (live) {
      throw conflict('orders_open',
        'You still have a bag to collect or pay for. Cancel or collect it first.');
    }

    db.transaction(() => {
      db.prepare('DELETE FROM favourites WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM merchant_follows WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM merchant_invites WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM notifications WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(u.phone);
      // The bearer links they sent stop working; the bags themselves stand.
      db.prepare(`UPDATE order_transfers SET revoked_at = COALESCE(revoked_at, ?)
                   WHERE created_by = ?`).run(now(), u.id);
      // A deleted phone number must not block the next person issued it, and
      // must not be recognisable. It is replaced, not blanked.
      db.prepare(
        `UPDATE users SET name = 'Compte supprimé', phone = ?, email = NULL,
                password_hash = NULL, lat = NULL, lng = NULL, zone = 'Supprimé',
                status = 'deleted', deleted_at = ?
          WHERE id = ?`,
      ).run(`deleted:${u.id}`, now(), u.id);
      audit({ ...req, user: u }, 'user.delete', 'user', u.id, { orders_kept: true });
    })();

    res.json({
      deleted: true,
      kept: 'Order amounts stay in the shops\' books, with your name and number removed from them.',
    });
  });

/* ---------- staff: forgotten passwords ---------- */

/**
 * A shop that cannot log in cannot take orders, and until now the only way
 * back was an engineer with database access. The code goes to the number on
 * the account, which is the one thing a shop cannot mislay.
 *
 * The answer never changes shape: whether or not that account exists, whether
 * or not it is staff, the caller is told a code has been sent if there is one
 * to send. Nothing here can be used to map out who works where.
 */
router.post('/password/reset/request',
  loginLimiter,
  validate(z.object({
    identifier: z.string().min(3),
    locale: z.enum(['fr', 'en', 'wo']).optional(),
  })),
  async (req, res) => {
    const raw = req.body.identifier.trim();
    let phone = null;
    try { phone = normalisePhone(raw); } catch { /* an email, or nonsense */ }
    const user = db.prepare('SELECT * FROM users WHERE email = ? OR phone = ?')
      .get(raw.toLowerCase(), phone ?? raw);

    const eligible = user && user.password_hash && user.status === 'active' && user.phone;
    if (eligible) {
      const { id, code } = issueReset(user.id);
      try {
        await sendSms({ to: user.phone, kind: 'reset', locale: req.body.locale || user.locale || 'fr', args: [code] });
        audit({ ...req, user }, 'user.reset_requested', 'user', user.id, {});
      } catch (err) {
        burnReset(id);
        console.error('[auth] could not deliver a reset code', { error: err?.message || err });
        throw new ApiError(502, 'sms_failed',
          'We could not send the code. Try again in a moment.');
      }
    }
    res.json({ sent: true, expires_in: 900 });
  });

router.post('/password/reset/confirm',
  loginLimiter,
  validate(z.object({
    identifier: z.string().min(3),
    code: z.string().trim().min(4).max(8),
    password: z.string().min(10).max(200),
  })),
  (req, res) => {
    const raw = req.body.identifier.trim();
    let phone = null;
    try { phone = normalisePhone(raw); } catch { /* not a phone */ }
    const user = db.prepare('SELECT * FROM users WHERE email = ? OR phone = ?')
      .get(raw.toLowerCase(), phone ?? raw);
    // A wrong identifier and a wrong code are the same failure to the caller.
    if (!user || !user.password_hash || user.status !== 'active') throw unauthorized('Wrong code');
    consumeReset(user.id, req.body.code);

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(hashPassword(req.body.password), user.id);
    // Whoever was signed in on the old password is signed out by the new one.
    revokeAllRefreshTokens(user.id);
    audit({ ...req, user }, 'user.password_reset', 'user', user.id, {});
    notify(user.id, 'password_changed', {});
    res.json({ reset: true });
  });

/* ---------- staff: password ---------- */
router.post('/login',
  loginLimiter,
  validate(z.object({ identifier: z.string().min(3), password: z.string().min(8) })),
  (req, res) => {
    const { identifier, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ? OR phone = ?')
      .get(identifier.toLowerCase(), identifier);
    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      throw unauthorized('Wrong credentials');
    }
    if (user.status !== 'active') throw forbidden('This account is suspended');
    if (user.role === 'customer') throw forbidden('Customers sign in with a phone code');
    audit({ ...req, user }, 'user.login', 'user', user.id, { channel: 'password' });
    res.json(session(user, req));
  });

router.post('/refresh',
  validate(z.object({ refresh_token: z.string().min(10) })),
  (req, res) => {
    const { user, refreshToken } = rotateRefreshToken(req.body.refresh_token, req.get('user-agent'));
    res.json({
      access_token: signAccessToken(user),
      refresh_token: refreshToken,
      expires_in: config.accessTtlSeconds,
      user: selfUser(user, merchantContext(user)),
    });
  });

router.post('/logout',
  validate(z.object({ refresh_token: z.string().optional() })),
  (req, res) => {
    if (req.body.refresh_token) revokeRefreshToken(req.body.refresh_token);
    res.json({ ok: true });
  });

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: selfUser(req.user, merchantContext(req.user)) });
});

router.patch('/me',
  requireAuth,
  validate(z.object({
    name: z.string().trim().min(1).max(60).optional(),
    zone: z.string().trim().max(60).optional(),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    locale: z.enum(['fr', 'en', 'wo']).optional(),
  })),
  (req, res) => {
    const fields = [];
    const values = [];
    for (const key of ['name', 'zone', 'lat', 'lng', 'locale']) {
      if (req.body[key] !== undefined) { fields.push(`${key} = ?`); values.push(req.body[key]); }
    }
    if (fields.length) {
      db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values, req.user.id);
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: selfUser(user, merchantContext(user)) });
  });
