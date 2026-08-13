import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

export function migrate() {
  const sql = fs.readFileSync(path.join(config.root, 'src', 'schema.sql'), 'utf8');
  db.exec(sql);
}

/** Run fn inside a transaction; better-sqlite3 handles nesting via savepoints. */
export const tx = (fn) => db.transaction(fn);

export const now = () => Date.now();
