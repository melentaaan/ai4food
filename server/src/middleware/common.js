import crypto from 'node:crypto';
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

/* ---------- request identity ---------- */
/**
 * One id per request, echoed back and carried into every log line it causes.
 * When somebody says "my payment failed at 19:40", this is what turns that
 * sentence into a row.
 */
export function requestId(req, res, next) {
  const given = req.get('x-request-id');
  req.id = (given && /^[\w.-]{1,64}$/.test(given)) ? given : crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}

/* ---------- structured request logs ---------- */
const QUIET = new Set(['/health', '/ready']);

/**
 * One JSON line per request. No bodies, no tokens, no phone numbers — a log we
 * cannot show a colleague is a log nobody reads.
 */
export function accessLog(req, res, next) {
  if (QUIET.has(req.path)) return next();
  const started = Date.now();
  res.on('finish', () => {
    const line = {
      t: new Date().toISOString(),
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      msg: 'request',
      id: req.id,
      method: req.method,
      // The path template, not the path: an order id in a log is a customer in a log.
      path: req.route?.path ? req.baseUrl + req.route.path : scrub(req.path),
      status: res.statusCode,
      ms: Date.now() - started,
      role: req.user?.role || 'anon',
    };
    console.log(JSON.stringify(line));
  });
  next();
}

/** Replaces anything that looks like an id or a phone number with a marker. */
const scrub = (p) => p
  .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
  .replace(/\/\+?\d{6,}/g, '/:phone')
  .replace(/\/AI4-[A-Z0-9]{4}/gi, '/:code');

/* ---------- security headers + CORS ---------- */
export function security(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  res.set('Cache-Control', 'no-store');
  res.set('Cross-Origin-Resource-Policy', 'same-site');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // The API answers JSON and nothing else, so nothing it returns should ever
  // be allowed to run as a page.
  res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if (config.env === 'production') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  const origin = req.get('origin');
  const allowed = config.corsOrigins;
  if (origin && (allowed.includes('*') || allowed.includes(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
  } else if (allowed.includes('*') && !origin) {
    res.set('Access-Control-Allow-Origin', '*');
  }
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
  res.set('Access-Control-Expose-Headers', 'X-Request-Id');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.set('Access-Control-Max-Age', '600');
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
  if (status >= 500) {
    console.error(JSON.stringify({
      t: new Date().toISOString(), level: 'error', msg: 'unhandled',
      id: req.id, method: req.method, path: scrub(req.path),
      error: err?.message, stack: err?.stack?.split('\n').slice(0, 4).join(' | '),
    }));
  }
  res.status(status).json({
    error: {
      code: err.code || 'internal_error',
      // A 500 says nothing about our internals; the request id is how it gets
      // traced without printing a stack trace to a customer.
      message: status >= 500 ? 'Something went wrong on our side' : err.message,
      request_id: req.id,
      ...(err.details ? { details: err.details } : {}),
    },
  });
}
