import { firstName, maskPhone, shortName } from './lib/util.js';
import { discountPct, offerState } from './lib/rank.js';

/**
 * One place decides which fields each audience receives. Routes never hand a
 * raw database row to res.json(), so a new column cannot leak by accident.
 *
 *   publicOffer   — anyone, signed in or not
 *   merchantOffer — the shop that owns it (adds stock and takings)
 *   customerOrder — the customer who placed it (adds their pickup code)
 *   merchantOrder — the shop fulfilling it (adds a masked customer, no history)
 *   adminOrder    — AI4Food staff (adds both sides plus money)
 */

export function publicOffer(offer, extra = {}) {
  return {
    id: offer.id,
    name: offer.name,
    description: offer.description,
    image_key: offer.image_key,
    category: offer.category,
    price_cfa: offer.price_cfa,
    was_cfa: offer.was_cfa,
    discount_pct: discountPct(offer),
    qty_left: offer.qty_left,
    pickup: {
      date: offer.pickup_date,
      from: offer.pickup_from,
      to: offer.pickup_to,
      start: offer.pickup_start,
      end: offer.pickup_end,
    },
    state: offerState(offer),
    merchant: {
      id: offer.merchant_id,
      name: offer.merchant_name,
      zone: offer.zone,
      address: offer.address,
      rating: offer.rating,
      reviews_count: offer.reviews_count,
      lat: offer.lat,
      lng: offer.lng,
    },
    ...extra,
  };
}

export function merchantOffer(offer, sold = {}) {
  return {
    ...publicOffer(offer),
    status: offer.status,
    qty_total: offer.qty_total,
    qty_sold: sold.qty ?? offer.qty_total - offer.qty_left,
    revenue_cfa: sold.revenue ?? 0,
    created_at: offer.created_at,
    updated_at: offer.updated_at,
  };
}

export function publicMerchant(m, extra = {}) {
  return {
    id: m.id,
    name: m.name,
    followers: m.followers ?? 0,
    slug: m.slug,
    category: m.category,
    zone: m.zone,
    address: m.address,
    lat: m.lat,
    lng: m.lng,
    rating: m.rating,
    reviews_count: m.reviews_count,
    is_partner: m.status === 'active',
    ...extra,
  };
}

export function adminMerchant(m, extra = {}) {
  return {
    ...publicMerchant(m),
    status: m.status,
    phone: m.phone,
    commission_bps: m.commission_bps,
    created_at: m.created_at,
    approved_at: m.approved_at,
    approved_by: m.approved_by,
    ...extra,
  };
}

const orderCore = (o) => ({
  id: o.id,
  status: o.status,
  qty: o.qty,
  payment_method: o.payment_method,
  payment_status: o.payment_status,
  // Set while a wallet order is holding a bag it has not paid for. The app
  // counts down against it; past it the hold is released.
  payment_due_at: o.payment_due_at ?? null,
  pickup: { start: o.pickup_start, end: o.pickup_end, from: o.pickup_from, to: o.pickup_to },
  created_at: o.created_at,
  picked_up_at: o.picked_up_at,
  cancelled_at: o.cancelled_at,
});

/** What the app needs to send someone to a wallet and pick them up after. */
export const paymentInfo = (p) => (p ? {
  id: p.id,
  provider: p.provider,
  status: p.status,
  amount_cfa: p.amount_cfa,
  checkout_url: p.checkout_url,
  expires_at: p.expires_at,
} : null);

export function customerOrder(o, extra = {}) {
  return {
    ...orderCore(o),
    code: o.code, // only ever shown to the person who booked it
    total_cfa: o.total_cfa,
    was_total_cfa: o.was_total_cfa,
    saving_cfa: o.was_total_cfa - o.total_cfa,
    offer: {
      id: o.offer_id,
      name: o.offer_name,
      image_key: o.image_key,
      category: o.category,
    },
    merchant: {
      id: o.merchant_id,
      name: o.merchant_name,
      address: o.address,
      zone: o.zone,
      lat: o.lat,
      lng: o.lng,
    },
    ...extra,
  };
}

/** What the person who booked sees about the link they sent out. */
export function transferInfo(t) {
  return {
    token: t.token,
    to_name: t.to_name,
    note: t.note,
    claimed: !!t.claimed_at,
    claimed_by_name: t.claimed_by_name ? shortName(t.claimed_by_name) : null,
    claimed_at: t.claimed_at,
    created_at: t.created_at,
  };
}

/**
 * The friend collecting on someone else's behalf. They need to walk in, say
 * the code and leave — so that is all this returns. No amount paid, no phone
 * number, no order id, nothing about the sender beyond a first name and the
 * note they wrote.
 */
export function bearerOrder(o, t, extra = {}) {
  return {
    code: o.code,
    qty: o.qty,
    status: o.status,
    offer: { name: o.offer_name, image_key: o.image_key, category: o.category },
    merchant: {
      name: o.merchant_name,
      address: o.address,
      zone: o.zone,
      lat: o.lat,
      lng: o.lng,
    },
    pickup: { start: o.pickup_start, end: o.pickup_end, from: o.pickup_from, to: o.pickup_to },
    from_name: firstName(o.customer_name),
    note: t.note,
    to_name: t.to_name,
    claimed: !!t.claimed_at,
    ...extra,
  };
}

export function merchantOrder(o, extra = {}) {
  const commission = o.commission_cfa;
  return {
    ...orderCore(o),
    code: o.code, // needed at the counter
    offer: { id: o.offer_id, name: o.offer_name },
    customer: {
      // Enough to greet the person and check the phone they booked with.
      // Never the id, the full number, or anything about their other orders.
      name: shortName(o.customer_name),
      phone_masked: maskPhone(o.customer_phone),
    },
    gross_cfa: o.total_cfa,
    commission_cfa: commission,
    payout_cfa: o.total_cfa - commission,
    ...extra,
  };
}

export function adminOrder(o) {
  return {
    ...orderCore(o),
    code: o.code,
    offer: { id: o.offer_id, name: o.offer_name },
    merchant: { id: o.merchant_id, name: o.merchant_name, zone: o.zone },
    customer: {
      id: o.user_id,
      name: shortName(o.customer_name),
      phone_masked: maskPhone(o.customer_phone),
    },
    gross_cfa: o.total_cfa,
    was_total_cfa: o.was_total_cfa,
    commission_cfa: o.commission_cfa,
    payout_cfa: o.total_cfa - o.commission_cfa,
  };
}

/** Password hashes and OTP rows are not exposed by any endpoint, at any role. */
export function adminUser(u, extra = {}) {
  return {
    id: u.id,
    name: u.name,
    phone_masked: maskPhone(u.phone),
    email: u.email,
    role: u.role,
    status: u.status,
    zone: u.zone,
    locale: u.locale,
    created_at: u.created_at,
    last_seen_at: u.last_seen_at,
    ...extra,
  };
}

/** The signed-in person's own profile — they may see their own phone in full. */
export function selfUser(u, extra = {}) {
  return {
    id: u.id,
    name: u.name,
    phone: u.phone,
    email: u.email,
    role: u.role,
    zone: u.zone,
    lat: u.lat,
    lng: u.lng,
    locale: u.locale,
    created_at: u.created_at,
    ...extra,
  };
}

export function notification(n) {
  return {
    id: n.id,
    kind: n.kind,
    payload: JSON.parse(n.payload || '{}'),
    read: !!n.read_at,
    created_at: n.created_at,
  };
}
