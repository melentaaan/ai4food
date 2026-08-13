import { config } from '../config.js';
import { ApiError, badRequest, tooMany } from '../lib/errors.js';

/* ---------- validation ---------- */
/** Validates req[source] with a zod schema and replaces it with the parsed value. */
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source] ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      field: i.path.join('.') || '(root)',
      message: i.message,
    }));
    return next(badRequest('Some fields are invalid', details));
  }
  if (source === 'query') req.validatedQuery = result.data;
  else req[source] = result.data;
  next();
};

/* ---------- rate limiting (in-process; swap for Redis when you run >1 node) ---------- */
const buckets = new Map();
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of buckets) if (v.reset < t) buckets.delete(k);
}, 60_000).unref?.();

export const rateLimit = ({ key, limit, windowMs }) => (req, _res, next) => {
  const id = `${key}:${typeof req.rateKey === 'function' ? req.rateKey(req) : req.ip}`;
  const t = Date.now();
  let b = buckets.get(id);
  if (!b || b.reset < t) {
    b = { count: 0, reset: t + windowMs };
    buckets.set(id, b);
  }
  b.count += 1;
  if (b.count > limit) return next(tooMany());
  next();
};

export const otpLimiter = rateLimit({
  key: 'otp', limit: config.rateLimit.otpPerHour, windowMs: 3600_000,
});
export const loginLimiter = rateLimit({
  key: 'login', limit: config.rateLimit.loginPerHour, windowMs: 3600_000,
});
export const writeLimiter = rateLimit({
  key: 'write', limit: config.rateLimit.writePerMinute, windowMs: 60_000,
});

/* ---------- security headers + CORS ---------- */
export function security(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  res.set('Cache-Control', 'no-store');

  const origin = req.get('origin');
  const allowed = config.corsOrigins;
  if (origin && (allowed.includes('*') || allowed.includes(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
  } else if (allowed.includes('*') && !origin) {
    res.set('Access-Control-Allow-Origin', '*');
  }
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

/* ---------- errors ---------- */
export function notFoundHandler(_req, _res, next) {
  next(new ApiError(404, 'not_found', 'No such endpoint'));
}

// eslint-disable-next-line no-unused-vars -- express identifies handlers by arity
export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', req.method, req.originalUrl, err);
  res.status(status).json({
    error: {
      code: err.code || 'internal_error',
      message: status >= 500 ? 'Something went wrong on our side' : err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
}
