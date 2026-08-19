#!/usr/bin/env node
/**
 * Putting a backup back. Deliberately manual, because it overwrites live data.
 *
 *   node ops/restore.mjs /data/backups/ai4food-20260819T030000Z.db.gz
 *
 * Stop the API first. Restoring underneath a running writer is how one outage
 * becomes two. The database being replaced is moved aside, never deleted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';

const src = process.argv[2];
if (!src) {
  console.error('usage: node ops/restore.mjs <backup.db.gz>');
  process.exit(1);
}
const db_file = process.env.DB_FILE || '/data/ai4food.db';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ai4food-restore-'));
const staged = path.join(work, 'restore.db');

try {
  if (src.endsWith('.gz')) {
    await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(staged));
  } else {
    fs.copyFileSync(src, staged);
  }

  const check = new Database(staged, { readonly: true });
  const integrity = check.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`that backup is damaged (${integrity})`);
  const orders = check.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const merchants = check.prepare('SELECT COUNT(*) AS n FROM merchants').get().n;
  check.close();
  console.log(`restore: ${src} holds ${orders} orders across ${merchants} shops`);

  if (fs.existsSync(db_file)) {
    const kept = `${db_file}.replaced-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')}`;
    fs.renameSync(db_file, kept);
    for (const tail of ['-wal', '-shm']) {
      if (fs.existsSync(db_file + tail)) fs.rmSync(db_file + tail);
    }
    console.log(`restore: the database that was there is now ${kept}`);
  }

  fs.mkdirSync(path.dirname(db_file), { recursive: true });
  fs.copyFileSync(staged, db_file);
  console.log('restore: done. Start the API and check /ready.');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
