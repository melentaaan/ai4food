import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { uid, sha256 } from './util.js';
import { unauthorized, badRequest } from './errors.js';

/* ---------- passwords (staff accounts only) ---------- */
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `scrypt$${salt}$${key}`;
}
export function verifyPassword(plain, stored) {
  if (!stored) return false;
  const [scheme, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const test = crypto.scryptSync(plain, salt, 64);
  const ref = Buffer.from(key, 'hex');
  return test.length === ref.length && crypto.timingSafeEqual(test, ref);
}

/* ---------- phone ---------- */
/** Accepts 771234567, 00221771234567, +221 77 123 45 67 -> +221771234567 */
export function normalisePhone(input) {
  const raw = String(input || '').trim();
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) throw badRequest('A phone number is required');
  let d = digits;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 9 && /^(7[0678])/.test(d)) d = `221${d}`; // Senegalese mobile
  if (d.length < 8 || d.length > 15) throw badRequest('That phone number does not look right');
  return `+${d}`;
}

/* ---------- one-time codes ---------- */
export function issueOtp(phone) {
  const code = String(crypto.randomInt(100000, 1000000)); // 6 digits
  const ts = now();
  const id = uid();
  db.prepare(
    `INSERT INTO otp_codes (id, phone, code_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, phone, sha256(`${phone}:${code}`), ts + config.otpTtlSeconds * 1000, ts);
  return { id, code };
}

/** Retires a code that never reached anyone, so it cannot be guessed at later. */
export function burnOtp(id) {
  db.prepare('UPDATE otp_codes SET consumed_at = ? WHERE id = ?').run(now(), id);
}

/* ---------- staff password resets ---------- */

/**
 * Same shape as a sign-in code and for the same reason: a shop that loses its
 * password should not need an engineer with database access to get back in.
 * Only the hash is stored, it is single-use, and it dies in fifteen minutes.
 */
export function issueReset(userId) {
  const code = String(crypto.randomInt(100000, 1000000));
  const ts = now();
  const id = uid();
  // One live reset per account: asking again retires the previous code.
  db.prepare(`UPDATE password_resets SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL`)
    .run(ts, userId);
  db.prepare(
    `INSERT INTO password_resets (id, user_id, code_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, userId, sha256(`${userId}:${code}`), ts + 15 * 60_000, ts);
  return { id, code };
}

export function consumeReset(userId, code) {
  const row = db
    .prepare(`SELECT * FROM password_resets WHERE user_id = ? AND consumed_at IS NULL
               ORDER BY created_at DESC LIMIT 1`)
    .get(userId);
  if (!row) throw unauthorized('Ask for a new code');
  if (row.expires_at < now()) throw unauthorized('That code has expired');
  if (row.attempts >= config.otpMaxAttempts) throw unauthorized('Too many attempts, ask for a new code');
  if (row.code_hash !== sha256(`${userId}:${String(code).trim()}`)) {
    db.prepare('UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    throw unauthorized('Wrong code');
  }
  db.prepare('UPDATE password_resets SET consumed_at = ? WHERE id = ?').run(now(), row.id);
  return true;
}

export function burnReset(id) {
  db.prepare('UPDATE password_resets SET consumed_at = ? WHERE id = ?').run(now(), id);
}

export function consumeOtp(phone, code) {
  const row = db
    .prepare(
      `SELECT * FROM otp_codes
        WHERE phone = ? AND consumed_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(phone);
  if (!row) throw unauthorized('Ask for a new code');
  if (row.expires_at < now()) throw unauthorized('That code has expired');
  if (row.attempts >= config.otpMaxAttempts) throw unauthorized('Too many attempts, ask for a new code');

  const ok = row.code_hash === sha256(`${phone}:${String(code).trim()}`);
  if (!ok) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    throw unauthorized('Wrong code');
  }
  db.prepare('UPDATE otp_codes SET consumed_at = ? WHERE id = ?').run(now(), row.id);
  return true;
}

/* ---------- tokens ---------- */
export function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.name },
    config.jwtSecret,
    { expiresIn: config.accessTtlSeconds, issuer: 'ai4food' },
  );
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret, { issuer: 'ai4food' });
  } catch {
    throw unauthorized('Session expired, sign in again');
  }
}

export function issueRefreshToken(userId, userAgent) {
  const token = crypto.randomBytes(32).toString('hex');
  const ts = now();
  db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(uid(), userId, sha256(token), ts + config.refreshTtlSeconds * 1000, userAgent || null, ts);
  return token;
}

/** Refresh tokens rotate: using one revokes it and hands back a fresh pair. */
export function rotateRefreshToken(token, userAgent) {
  const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(sha256(token || ''));
  if (!row || row.revoked_at || row.expires_at < now()) throw unauthorized('Session expired, sign in again');
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').run(now(), row.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || user.status !== 'active') throw unauthorized('Account unavailable');
  return { user, refreshToken: issueRefreshToken(user.id, userAgent) };
}

export function revokeRefreshToken(token) {
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(now(), sha256(token || ''));
}

export function revokeAllRefreshTokens(userId) {
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(now(), userId);
}
