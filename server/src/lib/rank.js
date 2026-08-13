import { clamp, distanceKm } from './util.js';

/**
 * The same six-factor scoring the app shows in its "why this offer" sheet,
 * computed server-side so every client (and the admin tooling) ranks alike.
 * Reasons come back as codes, not sentences: the app translates them.
 */
export const WEIGHTS = {
  discount: 0.22,
  taste: 0.26,
  distance: 0.18,
  timing: 0.2,
  scarcity: 0.06,
  rating: 0.08,
};

export const discountPct = (o) => Math.round((1 - o.price_cfa / o.was_cfa) * 100);

export function offerState(offer, ts = Date.now()) {
  if (offer.qty_left <= 0 || offer.status === 'sold_out') return 'sold_out';
  if (ts >= offer.pickup_end) return 'expired';
  if (ts >= offer.pickup_start) return 'open';
  if (offer.pickup_start - ts <= 120 * 60_000) return 'soon';
  return 'later';
}

/**
 * ctx = { pos:{lat,lng}|null, favourites:Set<offerId>, byMerchant:Map, byCategory:Map }
 */
export function scoreOffer(offer, ctx = {}, ts = Date.now()) {
  const favourites = ctx.favourites ?? new Set();
  const byMerchant = ctx.byMerchant ?? new Map();
  const byCategory = ctx.byCategory ?? new Map();

  const state = offerState(offer, ts);
  const km = distanceKm(ctx.pos, { lat: offer.lat, lng: offer.lng });
  const pct = discountPct(offer);
  const merchantCount = byMerchant.get(offer.merchant_id) ?? 0;
  const categoryCount = byCategory.get(offer.category) ?? 0;
  const isFavourite = favourites.has(offer.id);

  const f = {
    discount: clamp((pct - 52) / 26, 0, 1),
    taste: clamp(
      (isFavourite ? 0.45 : 0) +
        Math.min(0.35, categoryCount * 0.12) +
        Math.min(0.35, merchantCount * 0.18),
      0, 1,
    ),
    // Unknown position should not punish an offer; treat it as neutral.
    distance: km == null ? 0.5 : clamp(1 - km / 9, 0, 1),
    timing:
      state === 'open' ? 1
      : state === 'soon' ? clamp(1 - (offer.pickup_start - ts) / (240 * 60_000), 0, 1)
      : clamp(0.55 - (offer.pickup_start - ts) / (1600 * 60_000), 0, 1),
    scarcity: offer.qty_left <= 1 ? 1 : offer.qty_left <= 2 ? 0.8 : offer.qty_left <= 4 ? 0.5 : 0.25,
    rating: clamp((offer.rating - 3.7) / 1.1, 0, 1),
  };

  let score = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) score += w * f[k];
  if (state === 'sold_out' || state === 'expired') score *= 0.15;

  const reasons = [];
  if (merchantCount >= 2) reasons.push({ weight: f.taste, code: 'repeat_merchant', n: merchantCount });
  else if (isFavourite) reasons.push({ weight: f.taste, code: 'favourite' });
  else if (categoryCount >= 2) reasons.push({ weight: f.taste, code: 'category', category: offer.category });
  if (state === 'open') reasons.push({ weight: f.timing, code: 'open_now' });
  else if (state === 'soon') reasons.push({ weight: f.timing, code: 'pickup_soon' });
  if (km != null && km < 1.6) reasons.push({ weight: f.distance, code: 'nearby', km });
  if (offer.qty_left <= 2 && state !== 'sold_out') reasons.push({ weight: f.scarcity, code: 'almost_gone', n: offer.qty_left });
  if (pct >= 66) reasons.push({ weight: f.discount, code: 'big_discount', pct });
  reasons.sort((a, b) => b.weight - a.weight);

  return {
    score: clamp(score, 0, 1),
    match: Math.round(clamp(score, 0, 1) * 100),
    factors: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Math.round(v * 100)])),
    reasons: reasons.map(({ weight, ...rest }) => rest),
    state,
    distanceKm: km,
    discountPct: pct,
  };
}
