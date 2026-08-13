import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const env = process.env;

const bool = (v, dflt) => (v === undefined ? dflt : /^(1|true|yes|on)$/i.test(v));
const int = (v, dflt) => (v === undefined || v === '' ? dflt : Number.parseInt(v, 10));

export const config = {
  env: env.NODE_ENV || 'development',
  port: int(env.PORT, 4000),
  host: env.HOST || '0.0.0.0',
  dbFile: env.DB_FILE || path.join(root, 'data', 'ai4food.db'),
  root,

  // Dakar is UTC+0 year round, but keep it explicit so nobody has to guess.
  timezoneOffsetMinutes: int(env.TZ_OFFSET_MINUTES, 0),

  jwtSecret: env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  accessTtlSeconds: int(env.ACCESS_TTL_SECONDS, 15 * 60),
  refreshTtlSeconds: int(env.REFRESH_TTL_SECONDS, 30 * 24 * 3600),

  otpTtlSeconds: int(env.OTP_TTL_SECONDS, 5 * 60),
  otpMaxAttempts: int(env.OTP_MAX_ATTEMPTS, 5),
  // In development the code is returned by the API so the app is testable
  // without an SMS gateway. Never enable this in production.
  otpEcho: bool(env.OTP_ECHO, (env.NODE_ENV || 'development') !== 'production'),

  corsOrigins: (env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),

  defaultCommissionBps: int(env.COMMISSION_BPS, 1500),
  // A customer may cancel free of charge until this long before pickup opens.
  cancelWindowMinutes: int(env.CANCEL_WINDOW_MINUTES, 120),
  // Grace period after the window closes before an unclaimed order expires.
  pickupGraceMinutes: int(env.PICKUP_GRACE_MINUTES, 60),
  co2PerMealKg: Number(env.CO2_PER_MEAL_KG || 1.2),

  rateLimit: {
    otpPerHour: int(env.RL_OTP_PER_HOUR, 5),
    loginPerHour: int(env.RL_LOGIN_PER_HOUR, 20),
    writePerMinute: int(env.RL_WRITE_PER_MINUTE, 60),
  },
};

if (config.env === 'production') {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET must be set in production');
  if (config.otpEcho) throw new Error('OTP_ECHO must be off in production');
}
