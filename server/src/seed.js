/**
 * Seeds a working Dakar dataset: the 68 mapped shops and 16 baskets the
 * prototype shipped with, plus demo accounts for each role and a fortnight of
 * order history so the dashboards have something honest to show.
 *
 *   npm run seed          keeps existing data, adds what is missing
 *   npm run seed -- --fresh   wipes the database first
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db, migrate, now } from './db.js';
import { uid, pickupCode, resolveWindow, dayString, addDays, toEpoch } from './lib/util.js';
import { hashPassword, normalisePhone } from './lib/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(here, 'seed-data.json'), 'utf8'));

const ZONE_POS = {
  Ngor: [14.757, -17.508], Almadies: [14.7365, -17.52], Yoff: [14.7555, -17.472],
  Ouakam: [14.7285, -17.494], Mermoz: [14.7085, -17.4795], 'Sacré-Cœur': [14.7195, -17.4585],
  'Point E': [14.6965, -17.4515], Fann: [14.6905, -17.4755], Médina: [14.6805, -17.4525],
  Plateau: [14.6745, -17.4265],
};

const slugify = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function fresh() {
  for (const t of ['audit_log', 'refresh_tokens', 'otp_codes', 'merchant_invites', 'notifications',
    'favourites', 'orders', 'offers', 'merchant_users', 'merchants', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}

function seedMerchants() {
  const insert = db.prepare(
    `INSERT INTO merchants (id, name, slug, category, zone, address, lat, lng, rating, reviews_count,
                            status, commission_bps, created_at, approved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const byName = new Map();
  const ts = now();

  db.transaction(() => {
    for (const m of data.merchants) {
      const existing = db.prepare('SELECT * FROM merchants WHERE name = ?').get(m.n);
      if (existing) { byName.set(m.n, existing.id); continue; }
      const id = uid();
      // `live` in the prototype meant "already a partner"; the rest are prospects
      // the growth team still has to convince.
      const status = m.live ? 'active' : 'prospect';
      insert.run(id, m.n, `${slugify(m.n)}-${id.slice(0, 4)}`, m.c, m.z, `${m.z}, Dakar`,
        m.la, m.lo, m.r, m.k, status, config.defaultCommissionBps, ts, m.live ? ts : null);
      byName.set(m.n, id);
    }
  })();
  return byName;
}

/** Offers reference shops by name; anything not on the map gets created as a partner. */
function ensureMerchantFor(offer, byName) {
  if (byName.has(offer.merch)) return byName.get(offer.merch);
  const zone = offer.addr.split(',').pop().trim();
  const pos = ZONE_POS[zone] ?? [offer.la, offer.lo];
  const id = uid();
  db.prepare(
    `INSERT INTO merchants (id, name, slug, category, zone, address, lat, lng, rating, reviews_count,
                            status, commission_bps, created_at, approved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'active', ?, ?, ?)`,
  ).run(id, offer.merch, `${slugify(offer.merch)}-${id.slice(0, 4)}`, offer.cat, zone, offer.addr,
    offer.la ?? pos[0], offer.lo ?? pos[1], offer.rate, offer.avis, config.defaultCommissionBps, now(), now());
  byName.set(offer.merch, id);
  return id;
}

function seedOffers(byName) {
  const ids = [];
  db.transaction(() => {
    for (const o of data.offers) {
      const merchantId = ensureMerchantFor(o, byName);
      db.prepare(`UPDATE merchants SET status = 'active', approved_at = COALESCE(approved_at, ?) WHERE id = ?`)
        .run(now(), merchantId);
      if (db.prepare('SELECT 1 FROM offers WHERE merchant_id = ? AND name = ?').get(merchantId, o.name)) continue;

      const win = resolveWindow(o.from, o.to);
      const id = uid();
      db.prepare(
        `INSERT INTO offers (id, merchant_id, name, description, image_key, category, price_cfa, was_cfa,
                             qty_total, qty_left, pickup_date, pickup_from, pickup_to, pickup_start, pickup_end,
                             status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'live', ?, ?)`,
      ).run(id, merchantId, o.name, o.desc, o.img, o.cat, o.price, o.was, o.left, o.left,
        win.date, o.from, o.to, win.start, win.end, now(), now());
      ids.push(id);
    }
  })();
  return ids;
}

function seedPeople() {
  const mk = (phone, name, role, password, zone) => {
    const p = normalisePhone(phone);
    const existing = db.prepare('SELECT * FROM users WHERE phone = ?').get(p);
    if (existing) return existing;
    const id = uid();
    const pos = ZONE_POS[zone] ?? ZONE_POS.Plateau;
    db.prepare(
      `INSERT INTO users (id, phone, name, role, password_hash, zone, lat, lng, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(id, p, name, role, password ? hashPassword(password) : null, zone, pos[0], pos[1], now());
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  };

  const admin = mk('+221770000001', 'Admin AI4Food', 'admin', 'admin-dakar-2026', 'Plateau');
  const customer = mk('+221771234567', 'Aïssatou Ndiaye', 'customer', null, 'Sacré-Cœur');
  const baker = mk('+221770000002', 'Moussa Fall', 'merchant', 'boulangerie-2026', 'Sacré-Cœur');

  const bakery = db.prepare(`SELECT * FROM merchants WHERE name = 'Boulangerie Jaune'`).get();
  if (bakery) {
    db.prepare(`UPDATE merchants SET status = 'active', phone = ?, approved_at = COALESCE(approved_at, ?) WHERE id = ?`)
      .run(baker.phone, now(), bakery.id);
    db.prepare('INSERT OR IGNORE INTO merchant_users (merchant_id, user_id, role, created_at) VALUES (?,?,?,?)')
      .run(bakery.id, baker.id, 'owner', now());
  }
  return { admin, customer, baker, bakery };
}

/** Two weeks of picked-up orders so impact, payouts and charts are not empty. */
function seedHistory(customer) {
  if (db.prepare('SELECT COUNT(*) AS n FROM orders').get().n > 0) return 0;
  const offers = db.prepare(
    `SELECT o.*, m.commission_bps FROM offers o JOIN merchants m ON m.id = o.merchant_id LIMIT 12`).all();
  if (!offers.length) return 0;

  let made = 0;
  db.transaction(() => {
    for (let daysAgo = 14; daysAgo >= 1; daysAgo--) {
      const date = addDays(dayString(), -daysAgo);
      const count = 1 + ((daysAgo * 7) % 3); // deterministic, 1-3 a day
      for (let i = 0; i < count; i++) {
        const offer = offers[(daysAgo + i) % offers.length];
        const qty = 1 + ((daysAgo + i) % 2);
        const total = offer.price_cfa * qty;
        const start = toEpoch(date, offer.pickup_from);
        db.prepare(
          `INSERT INTO orders (id, code, user_id, offer_id, merchant_id, qty, unit_price_cfa, total_cfa,
                               was_total_cfa, commission_cfa, payment_method, payment_status, status,
                               pickup_start, pickup_end, created_at, picked_up_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?, 'paid', 'picked_up', ?,?,?,?)`,
        ).run(uid(), pickupCode(), customer.id, offer.id, offer.merchant_id, qty, offer.price_cfa, total,
          offer.was_cfa * qty, Math.round((total * offer.commission_bps) / 10000),
          ['wave', 'om', 'cash'][i % 3], start, toEpoch(date, offer.pickup_to),
          start - 6 * 3600_000, start + 20 * 60_000);
        made++;
      }
    }
  })();
  return made;
}

function main() {
  migrate();
  if (process.argv.includes('--fresh')) { fresh(); console.log('cleared existing data'); }

  const byName = seedMerchants();
  const offerIds = seedOffers(byName);
  const { admin, customer, baker, bakery } = seedPeople();
  const history = seedHistory(customer);

  // Give the demo customer a couple of favourites so the ranker has a signal.
  const favs = db.prepare(`SELECT id FROM offers ORDER BY created_at LIMIT 2`).all();
  for (const f of favs) {
    db.prepare('INSERT OR IGNORE INTO favourites (user_id, offer_id, created_at) VALUES (?,?,?)')
      .run(customer.id, f.id, now());
  }

  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  console.log(`
Seeded ${config.dbFile}
  merchants   ${count('merchants')}  (${db.prepare(`SELECT COUNT(*) AS n FROM merchants WHERE status='active'`).get().n} partners)
  offers      ${count('offers')}  (${offerIds.length} new)
  orders      ${count('orders')}  (${history} historic)
  users       ${count('users')}

Demo accounts
  admin     ${admin.phone}  password: admin-dakar-2026
  merchant  ${baker.phone}  password: boulangerie-2026   shop: ${bakery?.name ?? 'n/a'}
  customer  ${customer.phone}  signs in with a phone code (dev returns it in the response)
`);
}

main();
