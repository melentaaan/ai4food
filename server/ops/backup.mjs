#!/usr/bin/env node
/**
 * A SQLite backup that is safe to take while the server is writing.
 *
 * Copying the file with `cp` gives you whatever the write-ahead log happened
 * to contain at that instant, which you discover is not a database at the
 * worst possible moment. This asks SQLite for a consistent copy instead.
 *
 *   node ops/backup.mjs [destination-dir]
 *
 * Env: DB_FILE, BACKUP_DIR, BACKUP_KEEP (default 14), BACKUP_REMOTE
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';

const db_file = process.env.DB_FILE || '/data/ai4food.db';
const dest = process.argv[2] || process.env.BACKUP_DIR || path.join(path.dirname(db_file), 'backups');
const keep = Number(process.env.BACKUP_KEEP || 14);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
const out = path.join(dest, `ai4food-${stamp}.db`);

const say = (msg) => console.log(JSON.stringify({
  t: new Date().toISOString(), level: 'info', msg: 'backup', detail: msg,
}));

if (!fs.existsSync(db_file)) {
  console.error(`backup: no database at ${db_file}`);
  process.exit(1);
}
fs.mkdirSync(dest, { recursive: true });

const source = new Database(db_file, { readonly: true });
await source.backup(out);
source.close();

// A backup nobody has opened is a hope, not a backup. Open it, and count
// something that would be missing if the copy were short.
let orders;
try {
  const check = new Database(out, { readonly: true });
  const integrity = check.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`integrity_check said "${integrity}"`);
  orders = check.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  check.close();
} catch (err) {
  console.error(`backup: ${out} did not verify — ${err.message}. Keeping it for inspection.`);
  process.exit(1);
}

await pipeline(fs.createReadStream(out), zlib.createGzip(), fs.createWriteStream(`${out}.gz`));
// Opening the copy to verify it leaves a journal beside it; the archive is the
// only thing that should survive this script.
for (const tail of ['', '-wal', '-shm']) {
  if (fs.existsSync(out + tail)) fs.rmSync(out + tail);
}
say(`${out}.gz verified, ${orders} orders`);

// Keep the last N.
const olds = fs.readdirSync(dest).filter((f) => /^ai4food-.*\.db\.gz$/.test(f)).sort().reverse();
for (const stale of olds.slice(keep)) {
  fs.rmSync(path.join(dest, stale));
  say(`pruned ${stale}`);
}

// Still on the same disk as the original, which is not a backup as far as a
// dying disk is concerned. Put a copy somewhere else.
const remote = process.env.BACKUP_REMOTE;
if (remote) {
  try {
    fs.mkdirSync(remote, { recursive: true });
    fs.copyFileSync(`${out}.gz`, path.join(remote, path.basename(`${out}.gz`)));
    say(`copied to ${remote}`);
  } catch (err) {
    console.error(`backup: could not reach ${remote} (${err.message}) — the local copy stands`);
  }
}
