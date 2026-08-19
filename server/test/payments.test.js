/**
 * The wallet flow, against a stand-in for Wave that speaks its checkout API.
 *
 * The point of these is the money: that a bag is held but not sold until the
 * wallet confirms, that an unsigned callback cannot confirm it, and that every
 * way a payment can fail gives the bag back rather than leaving it in limbo.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai4food-pay-')), 'test.db');

const WEBHOOK_SECRET = 'whsec-test';

/* ---------- a stand-in for Wave ---------- */
const sessions = new Map();
let failNextCheckout = false;
const refunded = [];

const wave = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const reply = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const url = req.url.split('?')[0];

    if (req.method === 'POST' && url === '/v1/checkout/sessions') {
      if (failNextCheckout) {
        failNextCheckout = false;
        return reply(503, { message: 'wallet is having a moment' });
      }
      const parsed = JSON.parse(body || '{}');
      const id = `cos-${sessions.size + 1}`;
      sessions.set(id, {
        id,
        client_reference: parsed.client_reference,
        amount: parsed.amount,
        // Kept so a test can check what we actually handed the wallet.
        success_url: parsed.success_url,
        error_url: parsed.error_url,
        checkout_status: 'open',
        payment_status: 'processing',
        wave_launch_url: `https://pay.example/${id}`,
        when_expires: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
      return reply(201, sessions.get(id));
    }
    const refundMatch = url.match(/^\/v1\/checkout\/sessions\/([^/]+)\/refund$/);
    if (req.method === 'POST' && refundMatch) {
      refunded.push(refundMatch[1]);
      return reply(200, { ok: true });
    }
    const getMatch = url.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
    if (req.method === 'GET' && getMatch) {
      const s = sessions.get(getMatch[1]);
      return s ? reply(200, s) : reply(404, { message: 'no such session' });
    }
    reply(404, { message: 'not found' });
  });
});

/** Wave signs `${timestamp}${body}`; the header carries both halves. */
function signed(payload, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(payload);
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}${raw}`).digest('hex');
  return { raw, header: `t=${t},v1=${v1}` };
}

let server;
let base;
let db;
let customer;
let merchant;
let admin;

async function call(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const get = (url, token) => call('GET', url, { token });
const post = (url, body, token) => call('POST', url, { body, token });

const liveOffer = () =>
  db.prepare(`SELECT * FROM offers WHERE status = 'live' AND qty_left > 2 ORDER BY qty_left DESC LIMIT 1`).get();
/** A live bag at the shop the test merchant works for, for the counter tests. */
const liveOfferAtMyShop = () =>
  db.prepare(`SELECT * FROM offers WHERE status = 'live' AND qty_left > 2 AND merchant_id = ?
               ORDER BY qty_left DESC LIMIT 1`).get(merchant.user.merchant.id);
const stockOf = (id) => db.prepare('SELECT qty_left FROM offers WHERE id = ?').get(id).qty_left;
const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const paymentOf = (orderId) =>
  db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(orderId);

/** Reserves with Wave and returns { order, payment } as the app would see it. */
async function reserveWithWave(qty = 1, pick = liveOffer) {
  const offer = pick();
  const before = stockOf(offer.id);
  const res = await post('/api/orders',
    { offer_id: offer.id, qty, payment_method: 'wave' }, customer.access_token);
  return { offer, before, res };
}

before(async () => {
  await new Promise((r) => wave.listen(0, '127.0.0.1', r));
  const wavePort = wave.address().port;

  process.env.NODE_ENV = 'test';
  process.env.DB_FILE = dbFile;
  process.env.JWT_SECRET = 'test-secret-not-for-production';
  process.env.OTP_ECHO = 'true';
  process.env.RL_OTP_PER_HOUR = '1000';
  process.env.RL_WRITE_PER_MINUTE = '1000';
  process.env.WAVE_BASE_URL = `http://127.0.0.1:${wavePort}`;
  process.env.WAVE_API_KEY = 'wave-test-key';
  process.env.WAVE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.PAYMENT_WINDOW_MINUTES = '15';
  // Orange Money stays uncredentialed on purpose: it is the control case for
  // "a wallet nobody configured must not be offered".
  delete process.env.OM_CLIENT_ID;

  execFileSync('node', ['src/seed.js', '--fresh'], {
    cwd: serverRoot, env: { ...process.env, DB_FILE: dbFile }, stdio: 'pipe',
  });

  const { createApp } = await import('../src/app.js');
  ({ db } = await import('../src/db.js'));
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const asked = await post('/api/auth/otp/request', { phone: '+221771234567' });
  customer = (await post('/api/auth/otp/verify',
    { phone: '+221771234567', code: asked.body.dev_code })).body;
  merchant = (await post('/api/auth/login',
    { identifier: '+221770000002', password: 'boulangerie-2026' })).body;
  admin = (await post('/api/auth/login',
    { identifier: '+221770000001', password: 'admin-dakar-2026' })).body;
});

after(() => {
  server?.close();
  wave.close();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

describe('which wallets exist', () => {
  test('only methods with a working provider are offered', async () => {
    const res = await get('/api/meta');
    const ids = res.body.payment_methods.map((m) => m.id);
    assert.ok(ids.includes('cash'), 'cash needs no provider');
    assert.ok(ids.includes('wave'), 'wave is credentialed in this run');
    assert.ok(!ids.includes('om'), 'an uncredentialed wallet must not be advertised');
  });

  test('an unconfigured wallet is refused at the door too', async () => {
    const offer = liveOffer();
    const res = await post('/api/orders',
      { offer_id: offer.id, qty: 1, payment_method: 'om' }, customer.access_token);
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details.some((d) => d.field === 'payment_method'));
  });
});

describe('paying with a wallet', () => {
  test('reserving holds the bag and hands back a checkout, but is not a sale yet', async () => {
    const { offer, before, res } = await reserveWithWave(1);
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const order = res.body.order;
    assert.equal(order.status, 'pending_payment');
    assert.equal(order.payment_status, 'pending');
    assert.ok(order.payment_due_at > Date.now(), 'the hold should carry a deadline');
    assert.match(res.body.payment.checkout_url, /^https:\/\/pay\.example\//);
    assert.equal(res.body.payment.status, 'pending');

    assert.equal(stockOf(offer.id), before - 1, 'the bag is held while the customer pays');

    // Nothing is confirmed to the customer before the money moves.
    const notifs = await get('/api/notifications', customer.access_token);
    assert.ok(!notifs.body.items.some((n) => n.kind === 'order_ok' && n.payload.order_id === order.id));
  });

  test('an unpaid bag cannot be collected at the counter', async () => {
    const { res } = await reserveWithWave(1, liveOfferAtMyShop);
    const order = res.body.order;
    const validated = await post('/api/merchant/pickups/validate',
      { code: order.code }, merchant.access_token);
    assert.equal(validated.status, 409);
    assert.equal(validated.body.error.code, 'not_paid');
  });

  test('an unpaid bag does not show up on the merchant counter at all', async () => {
    const { res } = await reserveWithWave(1, liveOfferAtMyShop);
    const list = await get('/api/merchant/orders', merchant.access_token);
    assert.ok(!list.body.items.some((o) => o.id === res.body.order.id));
  });

  test('an unpaid bag cannot be handed to a friend', async () => {
    const { res } = await reserveWithWave(1);
    const handed = await post(`/api/orders/${res.body.order.id}/transfer`, {}, customer.access_token);
    assert.equal(handed.status, 409);
    assert.equal(handed.body.error.code, 'not_paid');
  });

  test('a signed callback turns the hold into a booking', async () => {
    const { res } = await reserveWithWave(1, liveOfferAtMyShop);
    const order = res.body.order;
    const payment = paymentOf(order.id);

    const payload = {
      type: 'checkout.session.completed',
      data: { id: payment.provider_ref, client_reference: payment.reference, payment_status: 'succeeded', checkout_status: 'complete' },
    };
    const { raw, header } = signed(payload);
    const hook = await call('POST', '/api/payments/wave/webhook', { body: raw, headers: { 'wave-signature': header } });
    assert.equal(hook.status, 200, JSON.stringify(hook.body));
    assert.equal(hook.body.status, 'succeeded');

    const after = orderRow(order.id);
    assert.equal(after.status, 'active');
    assert.equal(after.payment_status, 'paid');
    assert.equal(after.payment_due_at, null);

    // Now, and only now, the customer is told the bag is theirs.
    const notifs = await get('/api/notifications', customer.access_token);
    assert.ok(notifs.body.items.some((n) => n.kind === 'order_ok' && n.payload.order_id === order.id));

    // And now the counter can see it.
    const list = await get('/api/merchant/orders', merchant.access_token);
    assert.ok(list.body.items.some((o) => o.id === order.id), 'a paid bag belongs on the counter');
  });

  test('an unsigned or wrongly signed callback settles nothing', async () => {
    const { res } = await reserveWithWave(1);
    const payment = paymentOf(res.body.order.id);
    const payload = {
      type: 'checkout.session.completed',
      data: { id: payment.provider_ref, payment_status: 'succeeded', checkout_status: 'complete' },
    };

    const bare = await call('POST', '/api/payments/wave/webhook', { body: JSON.stringify(payload) });
    assert.equal(bare.status, 401);

    const { raw, header } = signed(payload, 'not-the-secret');
    const forged = await call('POST', '/api/payments/wave/webhook', { body: raw, headers: { 'wave-signature': header } });
    assert.equal(forged.status, 401);

    assert.equal(orderRow(res.body.order.id).status, 'pending_payment', 'still unpaid');
  });

  test('the same callback twice is not two payments', async () => {
    const { res } = await reserveWithWave(1);
    const payment = paymentOf(res.body.order.id);
    const payload = {
      type: 'checkout.session.completed',
      data: { id: payment.provider_ref, payment_status: 'succeeded', checkout_status: 'complete' },
    };
    for (let i = 0; i < 2; i++) {
      const { raw, header } = signed(payload);
      const hook = await call('POST', '/api/payments/wave/webhook', { body: raw, headers: { 'wave-signature': header } });
      assert.equal(hook.status, 200);
    }
    const paid = db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND status = 'succeeded'`)
      .get(res.body.order.id).n;
    assert.equal(paid, 1);
    assert.equal(orderRow(res.body.order.id).payment_status, 'paid');
  });

  test('the app can ask directly, for when it beats the callback home', async () => {
    const { res } = await reserveWithWave(1);
    const payment = paymentOf(res.body.order.id);
    // The customer paid; Wave has not called us yet.
    const session = sessions.get(payment.provider_ref);
    session.payment_status = 'succeeded';
    session.checkout_status = 'complete';

    const refreshed = await post(`/api/orders/${res.body.order.id}/payment/refresh`, {}, customer.access_token);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.order.status, 'active');
    assert.equal(refreshed.body.payment.status, 'succeeded');
  });

  test('a refused payment puts the bag straight back on sale', async () => {
    const { offer, before, res } = await reserveWithWave(1);
    assert.equal(stockOf(offer.id), before - 1);
    const payment = paymentOf(res.body.order.id);
    const session = sessions.get(payment.provider_ref);
    session.payment_status = 'cancelled';

    await post(`/api/orders/${res.body.order.id}/payment/refresh`, {}, customer.access_token);

    const after = orderRow(res.body.order.id);
    assert.equal(after.status, 'cancelled');
    assert.equal(after.payment_status, 'failed');
    assert.equal(after.cancel_reason, 'payment_failed');
    assert.equal(stockOf(offer.id), before, 'the bag is back');
  });

  test('a wallet that will not open a checkout leaves no hold behind', async () => {
    const offer = liveOffer();
    const before = stockOf(offer.id);
    failNextCheckout = true;
    const res = await post('/api/orders',
      { offer_id: offer.id, qty: 1, payment_method: 'wave' }, customer.access_token);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'payment_unavailable');
    assert.equal(stockOf(offer.id), before, 'nothing was held');
  });

  test('a checkout nobody finishes expires and gives the bag back', async () => {
    const { offer, before, res } = await reserveWithWave(1);
    assert.equal(stockOf(offer.id), before - 1);

    // Wind the deadline back rather than waiting a quarter of an hour.
    db.prepare('UPDATE orders SET payment_due_at = ? WHERE id = ?').run(Date.now() - 1000, res.body.order.id);
    const { sweepExpiredHolds } = await import('../src/services/payments.js');
    const released = await sweepExpiredHolds();
    assert.ok(released >= 1);

    const after = orderRow(res.body.order.id);
    assert.equal(after.status, 'cancelled');
    assert.equal(after.cancel_reason, 'payment_expired');
    assert.equal(stockOf(offer.id), before, 'the bag is back on sale');
  });

  test('a hold whose payment landed at the last second is kept, not dropped', async () => {
    const { res } = await reserveWithWave(1);
    const payment = paymentOf(res.body.order.id);
    const session = sessions.get(payment.provider_ref);
    session.payment_status = 'succeeded';
    session.checkout_status = 'complete';
    db.prepare('UPDATE orders SET payment_due_at = ? WHERE id = ?').run(Date.now() - 1000, res.body.order.id);

    const { sweepExpiredHolds } = await import('../src/services/payments.js');
    await sweepExpiredHolds();
    assert.equal(orderRow(res.body.order.id).status, 'active');
  });

  test('cancelling a paid bag asks the wallet for the money back', async () => {
    const { res } = await reserveWithWave(1);
    const order = res.body.order;
    const payment = paymentOf(order.id);
    const payload = {
      type: 'checkout.session.completed',
      data: { id: payment.provider_ref, payment_status: 'succeeded', checkout_status: 'complete' },
    };
    const { raw, header } = signed(payload);
    await call('POST', '/api/payments/wave/webhook', { body: raw, headers: { 'wave-signature': header } });

    const cancelled = await post(`/api/orders/${order.id}/cancel`, {}, customer.access_token);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.refund.refunded, true);
    assert.equal(cancelled.body.order.payment_status, 'refunded');
    assert.ok(refunded.includes(payment.provider_ref), 'the wallet was actually called');
  });

  test('a customer can walk away from a checkout whenever they like', async () => {
    const { offer, before, res } = await reserveWithWave(1);
    // Past the cancellation window, which only ever applied to real bookings.
    db.prepare('UPDATE orders SET pickup_start = ? WHERE id = ?').run(Date.now() + 60_000, res.body.order.id);
    const cancelled = await post(`/api/orders/${res.body.order.id}/cancel`, {}, customer.access_token);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.order.status, 'cancelled');
    assert.equal(stockOf(offer.id), before);
  });

  test('paying for a bag you just cancelled gets your money straight back', async () => {
    const { offer, before, res } = await reserveWithWave(1);
    const order = res.body.order;
    const payment = paymentOf(order.id);

    // The customer gives up in the app while the wallet page is still open.
    const cancelled = await post(`/api/orders/${order.id}/cancel`, {}, customer.access_token);
    assert.equal(cancelled.status, 200);
    assert.equal(stockOf(offer.id), before, 'the bag went back on sale');

    // ...and then pays anyway.
    const payload = {
      type: 'checkout.session.completed',
      data: { id: payment.provider_ref, payment_status: 'succeeded', checkout_status: 'complete' },
    };
    const { raw, header } = signed(payload);
    const hook = await call('POST', '/api/payments/wave/webhook', { body: raw, headers: { 'wave-signature': header } });
    assert.equal(hook.status, 200);

    const after = orderRow(order.id);
    assert.equal(after.status, 'cancelled', 'a cancelled bag stays cancelled');
    assert.equal(after.payment_status, 'refunded', 'and the money does not stay with us');
    assert.ok(refunded.includes(payment.provider_ref), 'the wallet was told to give it back');
    assert.equal(stockOf(offer.id), before, 'and the bag is still on sale, once');
  });

  test('holds are not takings: an unpaid bag is in nobody\'s numbers', async () => {
    const beforeStats = await get('/api/admin/overview', admin.access_token);
    const beforeGross = beforeStats.body.overview.today.gross_cfa;
    await reserveWithWave(1);
    const afterStats = await get('/api/admin/overview', admin.access_token);
    assert.equal(afterStats.body.overview.today.gross_cfa, beforeGross, 'a hold must not read as revenue');
  });
});

describe('where the wallet sends people back to', () => {
  test('a return url off our origin is ignored, not obeyed', async () => {
    const offer = liveOffer();
    const res = await post('/api/orders',
      { offer_id: offer.id, qty: 1, payment_method: 'wave', return_url: 'https://evil.example/steal' },
      customer.access_token);
    assert.equal(res.status, 201, JSON.stringify(res.body));

    // Whatever the provider was handed, it cannot have been the attacker's.
    const payment = paymentOf(res.body.order.id);
    const session = sessions.get(payment.provider_ref);
    assert.ok(!/evil\.example/.test(session.success_url), 'a crafted return url reached the wallet');
    assert.ok(!/evil\.example/.test(session.error_url));
  });

  test('our own origin is honoured', async () => {
    const offer = liveOffer();
    const mine = process.env.PUBLIC_APP_URL || 'http://localhost:8080/ai4food-app.html';
    const res = await post('/api/orders',
      { offer_id: offer.id, qty: 1, payment_method: 'wave', return_url: mine },
      customer.access_token);
    assert.equal(res.status, 201);
    const payment = paymentOf(res.body.order.id);
    const session = sessions.get(payment.provider_ref);
    assert.ok(session.success_url.startsWith(new URL(mine).origin), 'our own return url was dropped');
  });
});
