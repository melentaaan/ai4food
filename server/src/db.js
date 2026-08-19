import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

export const SCHEMA_VERSION = 2;

const tableSql = (name) =>
  db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)?.sql || '';

const columns = (name) => db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);

/**
 * SQLite cannot widen a CHECK constraint in place, and `CREATE TABLE IF NOT
 * EXISTS` leaves an existing table exactly as it was — so a database created
 * before orders could sit in `pending_payment` has to be rebuilt rather than
 * patched. The rebuild is the documented dance: rename out of the way, let
 * schema.sql create the current shape, copy the rows that both versions share.
 *
 * Guarded on the live table's own SQL rather than on a version counter, so a
 * database that half-migrated once still lands in the right place.
 */
function rebuildOrders() {
  const legacy = 'orders_legacy_v2';
  db.pragma('foreign_keys = OFF');
  // Keeps other tables' foreign keys pointing at "orders" across the rename.
  db.pragma('legacy_alter_table = ON');
  try {
    db.exec(`DROP TABLE IF EXISTS ${legacy}`);
    db.exec(`ALTER TABLE orders RENAME TO ${legacy}`);
    // The old indexes followed the table; drop them so schema.sql can create
    // its own against the new one instead of finding the names taken.
    const stale = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`)
      .all(legacy);
    for (const idx of stale) db.exec(`DROP INDEX IF EXISTS "${idx.name}"`);
    db.pragma('legacy_alter_table = OFF');

    applySchema();

    const shared = columns(legacy).filter((c) => columns('orders').includes(c));
    const list = shared.map((c) => `"${c}"`).join(', ');
    db.transaction(() => {
      db.exec(`INSERT INTO orders (${list}) SELECT ${list} FROM ${legacy}`);
      db.exec(`DROP TABLE ${legacy}`);
    })();
    const moved = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    console.log(`[migrate] orders rebuilt for the payment states, ${moved} row(s) carried over`);
  } finally {
    db.pragma('legacy_alter_table = OFF');
    db.pragma('foreign_keys = ON');
  }
}

function applySchema() {
  const sql = fs.readFileSync(path.join(config.root, 'src', 'schema.sql'), 'utf8');
  db.exec(sql);
}

export function migrate() {
  const orders = tableSql('orders');
  if (orders && !orders.includes('pending_payment')) rebuildOrders();
  else applySchema();
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/** Run fn inside a transaction; better-sqlite3 handles nesting via savepoints. */
export const tx = (fn) => db.transaction(fn);

export const now = () => Date.now();
