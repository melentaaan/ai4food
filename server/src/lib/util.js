import crypto from 'node:crypto';
import { config } from '../config.js';

export const uid = () => crypto.randomUUID();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1, read aloud over the counter
export function pickupCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `AI4-${s}`;
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ---------- time, in Dakar local terms ---------- */
const OFFSET_MS = config.timezoneOffsetMinutes * 60_000;

/** YYYY-MM-DD for a given instant, in the configured zone. */
export function dayString(ts = Date.now()) {
  return new Date(ts + OFFSET_MS).toISOString().slice(0, 10);
}

/** Epoch ms for a local YYYY-MM-DD + HH:MM. */
export function toEpoch(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - OFFSET_MS;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Pickup windows are given as HH:MM. A window whose end has already passed
 * belongs to tomorrow — the same rule the app uses so a late-evening browse
 * still shows tomorrow's bakery run instead of an empty screen.
 */
export function resolveWindow(from, to, ts = Date.now()) {
  const today = dayString(ts);
  let date = today;
  if (toEpoch(today, to) <= ts) date = addDays(today, 1);
  return { date, start: toEpoch(date, from), end: toEpoch(date, to) };
}

/* ---------- geo ---------- */
export function distanceKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371;
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLng = (b.lng - a.lng) * r;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))) * 100) / 100;
}

/* ---------- misc ---------- */
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** +221771234567 -> ••• 41 08 : enough for a merchant to confirm, not enough to re-identify. */
export function maskPhone(phone) {
  if (!phone) return null;
  const tail = phone.replace(/\D/g, '').slice(-4);
  return `••• ${tail.slice(0, 2)} ${tail.slice(2)}`;
}

export function firstName(name) {
  if (!name) return '';
  const [first = ''] = name.trim().split(/\s+/);
  return first;
}

/** "Aïssatou Ndiaye" -> "Aïssatou N." for merchant-facing screens. */
export function shortName(name) {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}
