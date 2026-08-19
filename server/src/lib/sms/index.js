import { config } from '../../config.js';
import { db, now } from '../../db.js';
import { uid } from '../util.js';
import { UpstreamError } from '../http.js';
import { smsProvider } from './providers.js';

/**
 * The one line a customer ever gets from us. Kept short — a long SMS costs two
 * segments — and in the language they chose, because a code you cannot read is
 * a door you cannot open.
 */
const TEXTS = {
  otp: {
    fr: (code) => `AI4Food : votre code est ${code}. Il expire dans ${Math.round(config.otpTtlSeconds / 60)} min. Ne le partagez pas.`,
    en: (code) => `AI4Food: your code is ${code}. It expires in ${Math.round(config.otpTtlSeconds / 60)} min. Do not share it.`,
    wo: (code) => `AI4Food: sa kod mooy ${code}. Dina jeex ci ${Math.round(config.otpTtlSeconds / 60)} simili. Bul ko wax kenn.`,
  },
  reset: {
    fr: (code) => `AI4Food : code de réinitialisation ${code}. Valable 15 min. Si ce n'est pas vous, ignorez ce message.`,
    en: (code) => `AI4Food: reset code ${code}. Valid for 15 min. If this was not you, ignore this message.`,
    wo: (code) => `AI4Food: kodu soppi ${code}. Ci 15 simili. Boo ko defulwoon, bàyyi ko.`,
  },
};

export function smsText(kind, locale, ...args) {
  const set = TEXTS[kind];
  if (!set) throw new Error(`no SMS text for "${kind}"`);
  return (set[locale] || set.fr)(...args);
}

const record = (row) => {
  db.prepare(
    `INSERT INTO sms_messages (id, phone, kind, provider, status, provider_ref, error, created_at, settled_at)
     VALUES (@id, @phone, @kind, @provider, @status, @provider_ref, @error, @created_at, @settled_at)`,
  ).run(row);
  return row.id;
};

/**
 * Sends and writes down what happened either way. Delivery is the part of
 * sign-in we do not own, so when it fails the failure has to be visible: the
 * caller turns it into an error the customer can act on, and the row here is
 * what an operator reads at 9pm when someone says no code arrived.
 */
export async function sendSms({ to, kind, locale = 'fr', args = [] }) {
  const text = smsText(kind, locale, ...args);
  const base = {
    id: uid(), phone: to, kind, provider: config.sms.provider,
    provider_ref: null, error: null, created_at: now(), settled_at: null,
  };

  let provider;
  try {
    provider = smsProvider();
  } catch (err) {
    record({ ...base, status: 'failed', error: err.message, settled_at: now() });
    throw err;
  }

  try {
    const { ref } = await provider.send({ to, text });
    record({ ...base, status: 'sent', provider_ref: ref, settled_at: now() });
    return { sent: true, provider: provider.id, ref };
  } catch (err) {
    const message = err instanceof UpstreamError ? err.message : String(err?.message || err);
    record({ ...base, status: 'failed', error: message.slice(0, 500), settled_at: now() });
    console.error('[sms] delivery failed', { to, kind, provider: provider.id, error: message });
    throw err instanceof UpstreamError ? err : new UpstreamError('sms', message);
  }
}

export { smsProvider, smsProviderIds } from './providers.js';
