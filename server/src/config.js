import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const env = process.env;

const bool = (v, dflt) => (v === undefined ? dflt : /^(1|true|yes|on)$/i.test(v));
const int = (v, dflt) => (v === undefined || v === '' ? dflt : Number.parseInt(v, 10));
const str = (v, dflt = '') => (v === undefined || v === '' ? dflt : String(v).trim());

const isProd = (env.NODE_ENV || 'development') === 'production';

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
  otpEcho: bool(env.OTP_ECHO, !isProd),

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

  // How long a customer has to finish paying before the bag goes back on sale.
  // Short on purpose: the bag is held out of the catalogue for the whole of it.
  paymentWindowMinutes: int(env.PAYMENT_WINDOW_MINUTES, 15),
  // Where the wallet sends the customer back to. The app reads the order id
  // off the query string and picks the confirmation screen back up.
  publicAppUrl: str(env.PUBLIC_APP_URL, 'http://localhost:8080/ai4food-app.html'),
  httpTimeoutMs: int(env.HTTP_TIMEOUT_MS, 12_000),

  sms: {
    // console = print to the log (development only). The server refuses to boot
    // on it in production, because an unsent code means nobody can sign in.
    provider: str(env.SMS_PROVIDER, isProd ? '' : 'console'),
    senderName: str(env.SMS_SENDER_NAME, 'AI4Food'),
    orange: {
      tokenUrl: str(env.ORANGE_TOKEN_URL, 'https://api.orange.com/oauth/v3/token'),
      baseUrl: str(env.ORANGE_SMS_BASE_URL, 'https://api.orange.com/smsmessaging/v1'),
      clientId: str(env.ORANGE_CLIENT_ID),
      clientSecret: str(env.ORANGE_CLIENT_SECRET),
      // The MSISDN Orange issued you, in +221… form.
      senderAddress: str(env.ORANGE_SENDER_ADDRESS),
    },
    twilio: {
      baseUrl: str(env.TWILIO_BASE_URL, 'https://api.twilio.com'),
      accountSid: str(env.TWILIO_ACCOUNT_SID),
      authToken: str(env.TWILIO_AUTH_TOKEN),
      from: str(env.TWILIO_FROM),
    },
    // Escape hatch for a local aggregator: any endpoint that takes a POST.
    // {{to}} and {{text}} are substituted in the url, headers and body.
    http: {
      url: str(env.SMS_HTTP_URL),
      method: str(env.SMS_HTTP_METHOD, 'POST'),
      contentType: str(env.SMS_HTTP_CONTENT_TYPE, 'application/json'),
      headers: str(env.SMS_HTTP_HEADERS),  // k: v, one per line or ;-separated
      body: str(env.SMS_HTTP_BODY, '{"to":"{{to}}","message":"{{text}}"}'),
    },
  },

  payments: {
    // A wallet that settles itself, so the whole non-cash flow can be walked
    // through locally. Refuses to load in production.
    sandboxEnabled: bool(env.PAYMENTS_SANDBOX, false),
    // Cash is always on: it needs no provider and it is how most of Dakar pays.
    // A wallet only appears in the app once its credentials are configured, so
    // nothing on screen can offer a payment route that does not exist.
    wave: {
      baseUrl: str(env.WAVE_BASE_URL, 'https://api.wave.com'),
      apiKey: str(env.WAVE_API_KEY),
      webhookSecret: str(env.WAVE_WEBHOOK_SECRET),
    },
    om: {
      tokenUrl: str(env.OM_TOKEN_URL, 'https://api.orange.com/oauth/v3/token'),
      baseUrl: str(env.OM_BASE_URL, 'https://api.orange.com/orange-money-webpay/sen/v1'),
      clientId: str(env.OM_CLIENT_ID),
      clientSecret: str(env.OM_CLIENT_SECRET),
      merchantKey: str(env.OM_MERCHANT_KEY),
      currency: str(env.OM_CURRENCY, 'OUV'),   // OUV in sandbox, XOF in production
    },
  },
};

/** Base URL the providers call us back on, e.g. https://api.ai4food.sn */
config.publicApiUrl = str(env.PUBLIC_API_URL, `http://localhost:${config.port}`);

if (config.env === 'production') {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET must be set in production');
  if (config.otpEcho) throw new Error('OTP_ECHO must be off in production');
  if (!config.sms.provider || config.sms.provider === 'console') {
    throw new Error('SMS_PROVIDER must be a real gateway in production: without it no customer can sign in');
  }
  if (!env.PUBLIC_API_URL) throw new Error('PUBLIC_API_URL must be set in production: wallets call back to it');
}
