/**
 * End-to-end tests over a real HTTP server and a throwaway database.
 *
 * Beyond the happy paths, the "who sees what" block is the important one: it
 * tries every cross-role read we never want to work, and asserts it fails.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai4food-test-')), 'test.db');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = dbFile;
process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.OTP_ECHO = 'true';
process.env.RL_OTP_PER_HOUR = '1000';
process.env.RL_WRITE_PER_MINUTE = '1000';

let server;
let base;
let db;

/* ---------- helpers ---------- */
async function call(method, url, { token, body } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const get = (url, token) => call('GET', url, { token });
const post = (url, body, token) => call('POST', url, { body, token });
const patch = (url, body, token) => call('PATCH', url, { body, token });

async function signInWithPhone(phone, name) {
  const asked = await post('/api/auth/otp/request', { phone });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const done = await post('/api/auth/otp/verify', { phone, code: asked.body.dev_code, name });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return done.body;
}
async function signInWithPassword(identifier, password) {
  const res = await post('/api/auth/login', { identifier, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

let customer;      // the seeded demo customer
let otherCustomer; // a second customer, used for isolation checks
let merchant;      // Boulangerie Jaune staff
let admin;

before(async () => {
  execFileSync('node', ['src/seed.js', '--fresh'], {
    cwd: serverRoot,
    env: { ...process.env, DB_FILE: dbFile },
    stdio: 'pipe',
  });

  const { createApp } = await import('../src/app.js');
  ({ db } = await import('../src/db.js'));
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  customer = await signInWithPhone('+221771234567');
  otherCustomer = await signInWithPhone('+221765550000', 'Ousmane Diop');
  merchant = await signInWithPassword('+221770000002', 'boulangerie-2026');
  admin = await signInWithPassword('+221770000001', 'admin-dakar-2026');
});

after(() => {
  server?.close();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

/* ================= authentication ================= */
describe('authentication', () => {
  test('a new phone number creates a customer account', async () => {
    const session = await signInWithPhone('+221761112233', 'Fatou Sarr');
    assert.equal(session.user.role, 'customer');
    assert.equal(session.user.phone, '+221761112233');
    assert.ok(session.access_token && session.refresh_token);
  });

  test('local phone formats normalise to E.164', async () => {
    const session = await signInWithPhone('77 111 22 44');
    assert.equal(session.user.phone, '+221771112244');
  });

  test('a wrong code is rejected', async () => {
    await post('/api/auth/otp/request', { phone: '+221765559999' });
    const res = await post('/api/auth/otp/verify', { phone: '+221765559999', code: '000000' });
    assert.equal(res.status, 401);
  });

  test('customers cannot use the staff password endpoint', async () => {
    const res = await post('/api/auth/login', { identifier: '+221771234567', password: 'whatever-long' });
    assert.equal(res.status, 401);
  });

  test('a wrong staff password is rejected', async () => {
    const res = await post('/api/auth/login', { identifier: '+221770000001', password: 'not-the-password' });
    assert.equal(res.status, 401);
  });

  test('refresh rotates the token and the old one stops working', async () => {
    const session = await signInWithPhone('+221765551111');
    const first = await post('/api/auth/refresh', { refresh_token: session.refresh_token });
    assert.equal(first.status, 200);
    const replay = await post('/api/auth/refresh', { refresh_token: session.refresh_token });
    assert.equal(replay.status, 401);
  });

  test('an invalid token is treated as anonymous, not as an error', async () => {
    const res = await get('/api/offers', 'garbage.token.here');
    assert.equal(res.status, 200);
  });
});

/* ================= catalogue ================= */
describe('catalogue', () => {
  test('offers are public and arrive ranked with reasons', async () => {
    const res = await get('/api/offers');
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length > 0);
    const first = res.body.items[0];
    assert.ok(first.rank.match >= 0 && first.rank.match <= 100);
    assert.ok(Array.isArray(first.rank.reasons));
    assert.ok(first.merchant.name);
  });

  test('ranking is personal: history and location change the order', async () => {
    const anon = await get('/api/offers');
    const mine = await get('/api/offers', customer.access_token);
    const anonIds = anon.body.items.map((i) => i.id).join(',');
    const mineIds = mine.body.items.map((i) => i.id).join(',');
    assert.notEqual(anonIds, mineIds);
  });

  test('search matches dish, shop and area', async () => {
    const res = await get('/api/offers?q=yassa');
    assert.equal(res.status, 200);
    assert.ok(res.body.items.every((i) =>
      `${i.name} ${i.description} ${i.merchant.name} ${i.merchant.zone} ${i.category}`
        .toLowerCase().includes('yassa')));
  });

  test('sorting by price is honoured', async () => {
    const res = await get('/api/offers?sort=price');
    const prices = res.body.items.map((i) => i.price_cfa);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  });

  test('the why sheet exposes all six factors', async () => {
    const list = await get('/api/offers', customer.access_token);
    const res = await get(`/api/offers/${list.body.items[0].id}`, customer.access_token);
    assert.equal(res.status, 200);
    assert.deepEqual(
      Object.keys(res.body.why.factors).sort(),
      ['discount', 'distance', 'rating', 'scarcity', 'taste', 'timing'],
    );
  });

  test('only partner shops appear in the catalogue', async () => {
    const res = await get('/api/offers?include_sold_out=true&limit=100');
    const ids = [...new Set(res.body.items.map((i) => i.merchant.id))];
    for (const id of ids) {
      assert.equal(db.prepare('SELECT status FROM merchants WHERE id = ?').get(id).status, 'active');
    }
  });
});

/* ================= ordering ================= */
describe('ordering', () => {
  const liveOffer = () => db.prepare(
    `SELECT * FROM offers WHERE status = 'live' AND qty_left >= 2 ORDER BY qty_left DESC LIMIT 1`).get();

  test('reserving decrements stock and returns a pickup code', async () => {
    const offer = liveOffer();
    const before = offer.qty_left;
    const res = await post('/api/orders',
      { offer_id: offer.id, qty: 2, payment_method: 'wave' }, customer.access_token);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.order.code, /^AI4-[A-Z0-9]{4}$/);
    assert.equal(res.body.order.status, 'active');
    assert.equal(db.prepare('SELECT qty_left FROM offers WHERE id = ?').get(offer.id).qty_left, before - 2);
  });

  test('you cannot reserve more than what is left', async () => {
    const offer = liveOffer();
    db.prepare('UPDATE offers SET qty_left = 2 WHERE id = ?').run(offer.id);
    const res = await post('/api/orders',
      { offer_id: offer.id, qty: 3, payment_method: 'wave' }, customer.access_token);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'out_of_stock');
  });

  test('two people racing for the last basket: exactly one wins', async () => {
    const offer = db.prepare(`SELECT * FROM offers WHERE status = 'live' AND qty_left >= 1 LIMIT 1`).get();
    db.prepare('UPDATE offers SET qty_left = 1 WHERE id = ?').run(offer.id);

    const [a, b] = await Promise.all([
      post('/api/orders', { offer_id: offer.id, qty: 1, payment_method: 'wave' }, customer.access_token),
      post('/api/orders', { offer_id: offer.id, qty: 1, payment_method: 'om' }, otherCustomer.access_token),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    assert.equal(db.prepare('SELECT qty_left FROM offers WHERE id = ?').get(offer.id).qty_left, 0);
    assert.equal(db.prepare('SELECT status FROM offers WHERE id = ?').get(offer.id).status, 'sold_out');
  });

  test('cancelling puts the basket back on the shelf', async () => {
    const offer = liveOffer();
    const created = await post('/api/orders',
      { offer_id: offer.id, qty: 1, payment_method: 'cash' }, customer.access_token);
    const after = db.prepare('SELECT qty_left FROM offers WHERE id = ?').get(offer.id).qty_left;

    const res = await post(`/api/orders/${created.body.order.id}/cancel`, {}, customer.access_token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.order.status, 'cancelled');
    assert.equal(db.prepare('SELECT qty_left FROM offers WHERE id = ?').get(offer.id).qty_left, after + 1);
  });

  test('cancelling is refused once the window is within two hours', async () => {
    const offer = liveOffer();
    const created = await post('/api/orders',
      { offer_id: offer.id, qty: 1, payment_method: 'wave' }, customer.access_token);
    db.prepare('UPDATE orders SET pickup_start = ? WHERE id = ?')
      .run(Date.now() + 30 * 60_000, created.body.order.id);

    const res = await post(`/api/orders/${created.body.order.id}/cancel`, {}, customer.access_token);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'cancel_window_closed');
  });

  test('impact counts collected baskets only', async () => {
    const res = await get('/api/me/impact', customer.access_token);
    assert.equal(res.status, 200);
    const picked = db.prepare(
      `SELECT COALESCE(SUM(qty),0) AS n FROM orders WHERE user_id = ? AND status = 'picked_up'`)
      .get(customer.user.id).n;
    assert.equal(res.body.impact.meals_saved, picked);
  });
});

/* ================= the counter ================= */
describe('merchant counter', () => {
  test('a merchant publishes an offer and it reaches the public catalogue', async () => {
    const res = await post('/api/merchant/offers', {
      name: 'Panier test du soir',
      description: 'Invendus du jour',
      price_cfa: 1200, was_cfa: 3600, qty: 4,
      pickup_from: '19:30', pickup_to: '20:30',
    }, merchant.access_token);
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const list = await get('/api/offers?q=Panier test du soir');
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].qty_left, 4);
  });

  test('a sale price above the shop value is rejected', async () => {
    const res = await post('/api/merchant/offers', {
      name: 'Panier absurde', price_cfa: 5000, was_cfa: 1000, qty: 2,
      pickup_from: '19:30', pickup_to: '20:30',
    }, merchant.access_token);
    assert.equal(res.status, 400);
  });

  test('a valid code is accepted once, and only once', async () => {
    const offers = await get('/api/merchant/offers?status=live', merchant.access_token);
    const offer = offers.body.items.find((o) => o.qty_left > 0);
    const order = await post('/api/orders',
      { offer_id: offer.id, qty: 1, payment_method: 'cash' }, customer.access_token);

    const first = await post('/api/merchant/pickups/validate',
      { code: order.body.order.code }, merchant.access_token);
    assert.equal(first.status, 200);
    assert.equal(first.body.order.status, 'picked_up');

    const second = await post('/api/merchant/pickups/validate',
      { code: order.body.order.code }, merchant.access_token);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'already_picked_up');
  });

  test('cash is only marked paid once the basket is handed over', async () => {
    const offers = await get('/api/merchant/offers?status=live', merchant.access_token);
    const offer = offers.body.items.find((o) => o.qty_left > 0);
    const order = await post('/api/orders',
      { offer_id: offer.id, qty: 1, payment_method: 'cash' }, customer.access_token);
    assert.equal(order.body.order.payment_status, 'pending');

    await post('/api/merchant/pickups/validate', { code: order.body.order.code }, merchant.access_token);
    const after = await get(`/api/orders/${order.body.order.id}`, customer.access_token);
    assert.equal(after.body.order.payment_status, 'paid');
  });

  test('a code from another shop simply does not exist here', async () => {
    const other = db.prepare(
      `SELECT o.id FROM offers o WHERE o.merchant_id <> (
         SELECT merchant_id FROM merchant_users mu WHERE mu.user_id = ?)
         AND o.status = 'live' AND o.qty_left > 0 LIMIT 1`).get(merchant.user.id);
    const order = await post('/api/orders',
      { offer_id: other.id, qty: 1, payment_method: 'wave' }, customer.access_token);

    const res = await post('/api/merchant/pickups/validate',
      { code: order.body.order.code }, merchant.access_token);
    assert.equal(res.status, 404);
  });

  test('merchant stats stay inside the shop', async () => {
    const res = await get('/api/merchant/stats', merchant.access_token);
    assert.equal(res.status, 200);
    const mine = db.prepare(
      `SELECT COALESCE(SUM(total_cfa - commission_cfa),0) AS v FROM orders
        WHERE merchant_id = (SELECT merchant_id FROM merchant_users WHERE user_id = ?)
          AND status = 'picked_up'`).get(merchant.user.id).v;
    assert.equal(res.body.stats.all_time.payout_cfa, mine);
  });

  test('the forecast suggests a quantity, a price and a window', async () => {
    const res = await get('/api/merchant/forecast', merchant.access_token);
    assert.equal(res.status, 200);
    assert.ok(res.body.forecast.predicted_surplus >= 1);
    assert.ok(res.body.forecast.suggested_price_cfa > 0);
    assert.match(res.body.forecast.window.from, /^\d{2}:\d{2}$/);
    assert.ok(res.body.forecast.confidence_pct <= 92);
  });
});

/* ================= who sees what ================= */
describe('who sees what', () => {
  test('anonymous visitors can browse but not order', async () => {
    assert.equal((await get('/api/offers')).status, 200);
    assert.equal((await get('/api/merchants')).status, 200);
    assert.equal((await get('/api/orders')).status, 401);
    assert.equal((await post('/api/orders', { offer_id: 'x', qty: 1, payment_method: 'wave' })).status, 401);
    assert.equal((await get('/api/me/impact')).status, 401);
  });

  test('a customer cannot reach the merchant console or the admin console', async () => {
    assert.equal((await get('/api/merchant/orders', customer.access_token)).status, 403);
    assert.equal((await get('/api/merchant/stats', customer.access_token)).status, 403);
    assert.equal((await get('/api/admin/overview', customer.access_token)).status, 403);
    assert.equal((await get('/api/admin/users', customer.access_token)).status, 403);
    assert.equal((await get('/api/admin/payouts', customer.access_token)).status, 403);
    assert.equal((await get('/api/admin/audit', customer.access_token)).status, 403);
  });

  test('a merchant cannot reach the admin console', async () => {
    assert.equal((await get('/api/admin/overview', merchant.access_token)).status, 403);
    assert.equal((await get('/api/admin/orders', merchant.access_token)).status, 403);
    assert.equal((await patch('/api/admin/users/anything', { status: 'suspended' }, merchant.access_token)).status, 403);
  });

  test('one customer cannot read another customer order', async () => {
    const list = await get('/api/orders', customer.access_token);
    const mine = list.body.items[0];
    const res = await get(`/api/orders/${mine.id}`, otherCustomer.access_token);
    assert.equal(res.status, 404, 'a stranger order must be indistinguishable from a missing one');
  });

  test('a customer order list only ever contains their own orders', async () => {
    const res = await get('/api/orders?limit=100', otherCustomer.access_token);
    for (const o of res.body.items) {
      assert.equal(
        db.prepare('SELECT user_id FROM orders WHERE id = ?').get(o.id).user_id,
        otherCustomer.user.id,
      );
    }
  });

  test('a merchant sees a masked customer, never a phone number or an id', async () => {
    const res = await get('/api/merchant/orders?limit=100', merchant.access_token);
    assert.ok(res.body.items.length > 0);
    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes('+2217'), 'no full phone numbers');
    assert.ok(!raw.includes(customer.user.id), 'no customer ids');
    for (const o of res.body.items) {
      assert.match(o.customer.phone_masked, /^••• \d\d \d\d$/);
      assert.equal(o.customer.id, undefined);
    }
  });

  test('a merchant only sees orders for their own shop', async () => {
    const res = await get('/api/merchant/orders?limit=200', merchant.access_token);
    const mine = db.prepare('SELECT merchant_id FROM merchant_users WHERE user_id = ?').get(merchant.user.id).merchant_id;
    for (const o of res.body.items) {
      assert.equal(db.prepare('SELECT merchant_id FROM orders WHERE id = ?').get(o.id).merchant_id, mine);
    }
  });

  test('a merchant cannot edit another shop offer', async () => {
    const foreign = db.prepare(
      `SELECT id FROM offers WHERE merchant_id <> (
         SELECT merchant_id FROM merchant_users WHERE user_id = ?) LIMIT 1`).get(merchant.user.id);
    const res = await patch(`/api/merchant/offers/${foreign.id}`, { qty: 99 }, merchant.access_token);
    assert.equal(res.status, 404);
  });

  test('a customer never receives commission or payout figures', async () => {
    const orders = await get('/api/orders', customer.access_token);
    const raw = JSON.stringify(orders.body);
    assert.ok(!raw.includes('commission'), 'commission is a merchant/admin concern');
    assert.ok(!raw.includes('payout'));
  });

  test('an admin sees the whole platform', async () => {
    const overview = await get('/api/admin/overview', admin.access_token);
    assert.equal(overview.status, 200);
    assert.ok(overview.body.overview.network.merchants_active > 0);
    assert.ok(overview.body.overview.series.length === 7);

    const orders = await get('/api/admin/orders?limit=200', admin.access_token);
    const total = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    assert.equal(orders.body.total, total, 'admins see every order, not just their own');
    assert.ok(orders.body.items[0].commission_cfa >= 0);
    assert.ok(orders.body.items[0].merchant.name);
  });

  test('no endpoint, at any role, leaks password hashes or codes', async () => {
    const responses = await Promise.all([
      get('/api/admin/users?limit=200', admin.access_token),
      get('/api/admin/orders?limit=50', admin.access_token),
      get('/api/admin/merchants?limit=50', admin.access_token),
      get('/api/auth/me', admin.access_token),
      get('/api/merchant/orders', merchant.access_token),
      get('/api/orders', customer.access_token),
    ]);
    for (const r of responses) {
      const raw = JSON.stringify(r.body);
      assert.ok(!raw.includes('password_hash'), 'password hashes must never be serialised');
      assert.ok(!raw.includes('scrypt$'));
      assert.ok(!raw.includes('code_hash'));
    }
  });

  test('the admin user list masks phone numbers too', async () => {
    const res = await get('/api/admin/users?limit=50', admin.access_token);
    assert.equal(res.status, 200);
    for (const u of res.body.items) {
      assert.equal(u.phone, undefined);
      assert.match(u.phone_masked, /^•••/);
    }
  });
});

/* ================= admin operations ================= */
describe('admin operations', () => {
  test('a shop cannot publish until it is approved, and can right after', async () => {
    const created = await post('/api/admin/merchants', {
      name: 'Boulangerie Test', category: 'Boulangeries', zone: 'Médina',
      lat: 14.6817, lng: -17.4497, status: 'pending',
    }, admin.access_token);
    assert.equal(created.status, 201);
    const shopId = created.body.merchant.id;

    const staff = await post(`/api/admin/merchants/${shopId}/staff`, {
      phone: '+221769998877', name: 'Awa Ba', password: 'test-password-2026',
    }, admin.access_token);
    assert.equal(staff.status, 201);

    const owner = await signInWithPassword('+221769998877', 'test-password-2026');
    const blocked = await post('/api/merchant/offers', {
      name: 'Pas encore', price_cfa: 500, was_cfa: 1500, qty: 2,
      pickup_from: '18:00', pickup_to: '19:00',
    }, owner.access_token);
    assert.equal(blocked.status, 403, 'an unapproved shop must not be able to sell');

    const approved = await patch(`/api/admin/merchants/${shopId}`, { status: 'active' }, admin.access_token);
    assert.equal(approved.body.merchant.status, 'active');

    const relogin = await signInWithPassword('+221769998877', 'test-password-2026');
    const ok = await post('/api/merchant/offers', {
      name: 'Enfin en ligne', price_cfa: 500, was_cfa: 1500, qty: 2,
      pickup_from: '18:00', pickup_to: '19:00',
    }, relogin.access_token);
    assert.equal(ok.status, 201);
  });

  test('suspending a shop pulls its live stock', async () => {
    const shops = await get('/api/admin/merchants?status=active&limit=100', admin.access_token);
    const target = shops.body.items.find((m) => m.live_offers > 0 && m.name !== 'Boulangerie Jaune');
    await patch(`/api/admin/merchants/${target.id}`, { status: 'suspended' }, admin.access_token);

    const left = db.prepare(
      `SELECT COUNT(*) AS n FROM offers WHERE merchant_id = ? AND status = 'live'`).get(target.id).n;
    assert.equal(left, 0);
    const publicList = await get('/api/offers?limit=100');
    assert.ok(!publicList.body.items.some((o) => o.merchant.id === target.id));

    await patch(`/api/admin/merchants/${target.id}`, { status: 'active' }, admin.access_token);
  });

  test('suspending a user ends their sessions', async () => {
    const victim = await signInWithPhone('+221765554444', 'Test Suspendu');
    assert.equal((await get('/api/orders', victim.access_token)).status, 200);

    await patch(`/api/admin/users/${victim.user.id}`, { status: 'suspended' }, admin.access_token);
    assert.equal((await get('/api/orders', victim.access_token)).status, 401);
    assert.equal((await post('/api/auth/refresh', { refresh_token: victim.refresh_token })).status, 401);
  });

  test('an admin cannot lock themselves out', async () => {
    const res = await patch(`/api/admin/users/${admin.user.id}`, { role: 'customer' }, admin.access_token);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'self_lockout');
  });

  test('payouts split gross into commission and what the shop is owed', async () => {
    const res = await get('/api/admin/payouts?days=60', admin.access_token);
    assert.equal(res.status, 200);
    assert.equal(res.body.totals.gross_cfa, res.body.totals.commission_cfa + res.body.totals.payout_cfa);
    for (const row of res.body.items) {
      assert.equal(row.gross_cfa, row.commission_cfa + row.payout_cfa);
    }
  });

  test('privileged actions land in the audit log with their actor', async () => {
    const res = await get('/api/admin/audit?action=merchant.update', admin.access_token);
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length > 0);
    assert.equal(res.body.items[0].actor.role, 'admin');
    assert.ok(res.body.items[0].created_at > 0);
  });

  test('admins can cancel outside the customer window, on the record', async () => {
    const offer = db.prepare(`SELECT * FROM offers WHERE status = 'live' AND qty_left > 0 LIMIT 1`).get();
    const order = await post('/api/orders',
      { offer_id: offer.id, qty: 1, payment_method: 'wave' }, customer.access_token);
    db.prepare('UPDATE orders SET pickup_start = ? WHERE id = ?')
      .run(Date.now() + 10 * 60_000, order.body.order.id);

    const refused = await post(`/api/orders/${order.body.order.id}/cancel`, {}, customer.access_token);
    assert.equal(refused.status, 409);

    const res = await post(`/api/admin/orders/${order.body.order.id}/cancel`,
      { reason: 'Client a appelé, commerce fermé' }, admin.access_token);
    assert.equal(res.status, 200);
    assert.equal(res.body.order.status, 'cancelled');
    assert.equal(res.body.order.payment_status, 'refunded');
  });
});

/* ================= housekeeping ================= */
describe('housekeeping', () => {
  test('orders left uncollected expire once the window has passed', async () => {
    const offer = db.prepare(`SELECT * FROM offers WHERE status = 'live' AND qty_left > 0 LIMIT 1`).get();
    const order = await post('/api/orders',
      { offer_id: offer.id, qty: 1, payment_method: 'wave' }, customer.access_token);
    db.prepare('UPDATE orders SET pickup_end = ? WHERE id = ?')
      .run(Date.now() - 3 * 3600_000, order.body.order.id);

    const res = await post('/api/admin/maintenance/expire', {}, admin.access_token);
    assert.equal(res.status, 200);
    assert.ok(res.body.expired >= 1);
    assert.equal(
      db.prepare('SELECT status FROM orders WHERE id = ?').get(order.body.order.id).status,
      'expired',
    );
  });

  test('a pickup reminder is created once, not on every poll', async () => {
    const offer = db.prepare(`SELECT * FROM offers WHERE status = 'live' AND qty_left > 0 LIMIT 1`).get();
    const order = await post('/api/orders',
      { offer_id: offer.id, qty: 1, payment_method: 'wave' }, customer.access_token);
    db.prepare('UPDATE orders SET pickup_start = ?, pickup_end = ? WHERE id = ?')
      .run(Date.now() + 20 * 60_000, Date.now() + 80 * 60_000, order.body.order.id);

    await get('/api/notifications', customer.access_token);
    await get('/api/notifications', customer.access_token);
    const res = await get('/api/notifications', customer.access_token);
    const reminders = res.body.items.filter(
      (n) => n.kind === 'pickup_soon' && n.payload.order_id === order.body.order.id);
    assert.equal(reminders.length, 1);
  });

  test('marking notifications read clears the badge', async () => {
    await post('/api/notifications/read', {}, customer.access_token);
    const res = await get('/api/notifications', customer.access_token);
    assert.equal(res.body.unread, 0);
  });

  test('validation errors say which field is wrong', async () => {
    const res = await post('/api/orders',
      { offer_id: '', qty: 0, payment_method: 'bitcoin' }, customer.access_token);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'bad_request');
    assert.ok(res.body.error.details.some((d) => d.field === 'payment_method'));
  });

  test('unknown endpoints answer with a clean 404', async () => {
    const res = await get('/api/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
  });
});
