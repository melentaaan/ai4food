/**
 * The orders table has to be rebuilt to hold the payment states, and a rebuild
 * is the one migration that can quietly lose data: rows, indexes, or the
 * foreign keys other tables point at it with. So build a database on the old
 * schema, migrate it, and check all three survived.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

const OLD_ORDERS = `
CREATE TABLE orders (
  id               TEXT PRIMARY KEY,
  code             TEXT UNIQUE NOT NULL,
  user_id          TEXT NOT NULL REFERENCES users(id),
  offer_id         TEXT NOT NULL REFERENCES offers(id),
  merchant_id      TEXT NOT NULL REFERENCES merchants(id),
  qty              INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cfa   INTEGER NOT NULL,
  total_cfa        INTEGER NOT NULL,
  was_total_cfa    INTEGER NOT NULL,
  commission_cfa   INTEGER NOT NULL,
  payment_method   TEXT NOT NULL CHECK (payment_method IN ('wave','om','cash')),
  payment_status   TEXT NOT NULL DEFAULT 'pending'
                   CHECK (payment_status IN ('pending','paid','refunded')),
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','picked_up','expired','cancelled')),
  pickup_start     INTEGER NOT NULL,
  pickup_end       INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  picked_up_at     INTEGER,
  picked_up_by     TEXT REFERENCES users(id),
  cancelled_at     INTEGER,
  cancel_reason    TEXT
);
CREATE INDEX idx_orders_user     ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_merchant ON orders(merchant_id, status);
CREATE INDEX idx_orders_status   ON orders(status, pickup_end);
`;

/** Everything the current schema declares except the orders table itself. */
function schemaWithoutOrders() {
  const sql = fs.readFileSync(path.join(serverRoot, 'src', 'schema.sql'), 'utf8');
  return sql
    .replace(/CREATE TABLE IF NOT EXISTS orders \([\s\S]*?\n\);\n/, '')
    .replace(/CREATE INDEX IF NOT EXISTS idx_orders_\w+\s+ON orders\([^)]*\);\n/g, '');
}

function buildLegacyDb(file) {
  const d = new Database(file);
  d.exec(schemaWithoutOrders());
  d.exec(OLD_ORDERS);
  const t = Date.now();
  d.prepare(`INSERT INTO users (id, phone, name, role, created_at) VALUES ('u1','+221770000009','Test','customer',?)`).run(t);
  d.prepare(`INSERT INTO merchants (id, slug, name, category, zone, lat, lng, created_at)
             VALUES ('m1','shop','Shop','Boulangeries','Plateau',14.6928,-17.4467,?)`).run(t);
  d.prepare(`INSERT INTO offers (id, merchant_id, name, category, price_cfa, was_cfa, qty_total, qty_left,
                                 pickup_date, pickup_from, pickup_to, pickup_start, pickup_end,
                                 created_at, updated_at)
             VALUES ('o1','m1','Bag','Boulangeries',1000,3000,5,5,'2026-01-01','18:00','19:00',?,?,?,?)`)
    .run(t, t + 3_600_000, t, t);
  d.prepare(`INSERT INTO orders (id, code, user_id, offer_id, merchant_id, qty, unit_price_cfa, total_cfa,
                                 was_total_cfa, commission_cfa, payment_method, payment_status, status,
                                 pickup_start, pickup_end, created_at)
             VALUES ('ord1','AI4-TEST','u1','o1','m1',1,1000,1000,3000,150,'cash','pending','active',?,?,?)`)
    .run(t, t + 3_600_000, t);
  d.prepare(`INSERT INTO order_transfers (id, order_id, token, created_by, created_at)
             VALUES ('tr1','ord1','tok-1','u1',?)`).run(t);
  d.close();
}

describe('migrating a database from before payments', () => {
  test('rebuilds orders without losing rows, indexes or foreign keys', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai4food-migrate-'));
    const file = path.join(dir, 'legacy.db');
    buildLegacyDb(file);

    process.env.DB_FILE = file;
    // A fresh module graph so db.js opens this file rather than any earlier one.
    const { migrate, db } = await import(`../src/db.js?migrate-test=${Date.now()}`);
    migrate();

    const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'`).get().sql;
    assert.ok(sql.includes('pending_payment'), 'orders should accept the new status');
    assert.ok(sql.includes('payment_due_at'), 'orders should carry the hold deadline');

    const order = db.prepare('SELECT * FROM orders').get();
    assert.equal(order.id, 'ord1');
    assert.equal(order.code, 'AI4-TEST');
    assert.equal(order.status, 'active');
    assert.equal(order.payment_due_at, null);

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='orders' AND sql IS NOT NULL`)
      .all().map((r) => r.name);
    for (const name of ['idx_orders_user', 'idx_orders_merchant', 'idx_orders_status']) {
      assert.ok(indexes.includes(name), `${name} should have been recreated`);
    }

    const transfers = db.prepare(`SELECT sql FROM sqlite_master WHERE name='order_transfers'`).get().sql;
    assert.ok(transfers.includes('REFERENCES orders(id)'), 'the transfer FK must still name orders');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_transfers').get().n, 1);
    assert.deepEqual(db.pragma('foreign_key_check'), []);

    for (const table of ['payments', 'sms_messages']) {
      assert.ok(
        db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table),
        `${table} should have been created`,
      );
    }

    // Running it again must be a no-op, not a second rebuild.
    migrate();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
    assert.equal(db.pragma('user_version', { simple: true }), 2);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
