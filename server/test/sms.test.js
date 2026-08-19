/**
 * Sign-in depends on a message we hand to somebody else. These tests point the
 * gateway at a local stand-in and check the two things that matter: the code
 * the customer receives is the code that works, and a gateway that fails says
 * so instead of leaving a live code nobody can read.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai4food-sms-')), 'test.db');

/* ---------- a stand-in for the SMS gateway ---------- */
const sent = [];
let gatewayDown = false;

const gateway = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (gatewayDown) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'gateway on fire' }));
    }
    const parsed = JSON.parse(body || '{}');
    sent.push(parsed);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `msg-${sent.length}` }));
  });
});

let server;
let base;
let db;

async function post(url, body) {
  const res = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const lastMessage = () => sent[sent.length - 1];
const codeFrom = (text) => (String(text).match(/\b(\d{6})\b/) || [])[1];

before(async () => {
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));

  process.env.NODE_ENV = 'test';
  process.env.DB_FILE = dbFile;
  process.env.JWT_SECRET = 'test-secret-not-for-production';
  process.env.OTP_ECHO = 'true';
  process.env.RL_OTP_PER_HOUR = '1000';
  process.env.SMS_PROVIDER = 'http';
  process.env.SMS_HTTP_URL = `http://127.0.0.1:${gateway.address().port}/send`;
  process.env.SMS_HTTP_BODY = '{"to":"{{to}}","message":"{{text}}"}';

  execFileSync('node', ['src/seed.js', '--fresh'], {
    cwd: serverRoot, env: { ...process.env, DB_FILE: dbFile }, stdio: 'pipe',
  });

  const { createApp } = await import('../src/app.js');
  ({ db } = await import('../src/db.js'));
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  gateway.close();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

describe('sending the sign-in code', () => {
  test('the code goes out over the gateway, and it is the one that works', async () => {
    const phone = '+221771230001';
    const asked = await post('/api/auth/otp/request', { phone });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));

    const message = lastMessage();
    assert.equal(message.to, phone, 'addressed to the number that asked');
    const delivered = codeFrom(message.message);
    assert.ok(delivered, `no code in "${message.message}"`);

    // The whole point: what the customer reads is what the API accepts.
    const verified = await post('/api/auth/otp/verify', { phone, code: delivered });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.user.phone, phone);
  });

  test('the message is written in the language the app asked for', async () => {
    await post('/api/auth/otp/request', { phone: '+221771230002', locale: 'en' });
    assert.match(lastMessage().message, /your code is/i);

    await post('/api/auth/otp/request', { phone: '+221771230003', locale: 'wo' });
    assert.match(lastMessage().message, /sa kod/i);

    await post('/api/auth/otp/request', { phone: '+221771230004' });
    assert.match(lastMessage().message, /votre code/i);
  });

  test('a gateway that fails is reported, and the code it never sent is dead', async () => {
    const phone = '+221771230005';
    const before = sent.length;
    gatewayDown = true;
    const asked = await post('/api/auth/otp/request', { phone });
    gatewayDown = false;

    assert.equal(asked.status, 502);
    assert.equal(asked.body.error.code, 'sms_failed');
    assert.equal(sent.length, before, 'nothing was delivered');

    // The row exists but is spent, so a guesser has nothing to guess at.
    const otp = db.prepare('SELECT * FROM otp_codes WHERE phone = ? ORDER BY created_at DESC LIMIT 1').get(phone);
    assert.ok(otp, 'the attempt should still be on record');
    assert.ok(otp.consumed_at, 'an undelivered code must not stay live');

    for (const code of ['000000', '123456']) {
      const tried = await post('/api/auth/otp/verify', { phone, code });
      assert.equal(tried.status, 401);
    }
  });

  test('every attempt is written down, and the code never is', async () => {
    const phone = '+221771230006';
    await post('/api/auth/otp/request', { phone });
    const row = db.prepare('SELECT * FROM sms_messages WHERE phone = ? ORDER BY created_at DESC LIMIT 1').get(phone);
    assert.equal(row.status, 'sent');
    assert.equal(row.kind, 'otp');
    assert.equal(row.provider, 'http');
    assert.ok(row.provider_ref, 'the gateway reference is what ties our log to theirs');

    const code = codeFrom(lastMessage().message);
    const columns = Object.values(row).map((v) => String(v ?? '')).join(' ');
    assert.ok(!columns.includes(code), 'the code itself must not be stored anywhere');

    gatewayDown = true;
    await post('/api/auth/otp/request', { phone: '+221771230007' });
    gatewayDown = false;
    const failed = db.prepare('SELECT * FROM sms_messages WHERE phone = ? ORDER BY created_at DESC LIMIT 1')
      .get('+221771230007');
    assert.equal(failed.status, 'failed');
    assert.ok(failed.error, 'a failure has to say what went wrong');
  });
});
