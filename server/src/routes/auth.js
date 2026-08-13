import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { uid } from '../lib/util.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { notify } from '../lib/notify.js';
import {
  normalisePhone, issueOtp, consumeOtp, signAccessToken, issueRefreshToken,
  rotateRefreshToken, revokeRefreshToken, verifyPassword,
} from '../lib/auth.js';
import { validate, otpLimiter, loginLimiter } from '../middleware/common.js';
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
  validate(z.object({ phone: z.string().min(6) })),
  (req, res) => {
    const phone = normalisePhone(req.body.phone);
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (user && user.status === 'suspended') throw forbidden('This account is suspended');

    const code = issueOtp(phone);
    // Wire an SMS gateway here. Until then development echoes the code back.
    if (config.env !== 'production') console.log(`[otp] ${phone} -> ${code}`);
    res.json({
      sent: true,
      expires_in: config.otpTtlSeconds,
      is_new_account: !user,
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
    res.json(session(user, req));
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
