import { db, now } from '../db.js';
import { verifyAccessToken } from '../lib/auth.js';
import { unauthorized, forbidden } from '../lib/errors.js';

/** Attaches req.user when a valid bearer token is present. Never throws. */
export function loadUser(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return next();
  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    return next(); // an expired token is treated as anonymous; requireAuth decides
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(claims.sub);
  if (!user || user.status !== 'active') return next();
  req.user = user;
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), user.id);
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) return next(forbidden('This area is not available for your account'));
  next();
};

/**
 * Resolves the shop the caller works for and puts it on req.merchant.
 * Admins may act on any shop by passing ?merchant_id=, which keeps support
 * work possible without handing merchants each other's data.
 */
export function requireMerchant(req, _res, next) {
  if (!req.user) return next(unauthorized());

  if (req.user.role === 'admin') {
    const id = req.query.merchant_id || req.body?.merchant_id;
    if (!id) return next(forbidden('Admins must pass merchant_id to use a shop endpoint'));
    const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(id);
    if (!m) return next(forbidden('Unknown shop'));
    req.merchant = m;
    return next();
  }

  if (req.user.role !== 'merchant') return next(forbidden('This area is for partner shops'));

  const link = db
    .prepare('SELECT * FROM merchant_users WHERE user_id = ? ORDER BY created_at LIMIT 1')
    .get(req.user.id);
  if (!link) return next(forbidden('Your account is not attached to a shop yet'));

  const merchant = db.prepare('SELECT * FROM merchants WHERE id = ?').get(link.merchant_id);
  if (!merchant) return next(forbidden('Your account is not attached to a shop yet'));
  if (merchant.status === 'suspended') return next(forbidden('This shop is suspended, contact AI4Food'));

  req.merchant = merchant;
  req.merchantRole = link.role;
  next();
}
