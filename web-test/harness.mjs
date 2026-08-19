/**
 * Everything the browser tests need to stand the product up: a seeded API, a
 * static host for the single-file app, and a stand-in for Wave so a payment can
 * be walked all the way through without an account at a real provider.
 *
 * Kept deliberately small — three child processes and a browser. A test suite
 * with its own infrastructure to debug is a test suite nobody runs.
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..');

/** Chromium comes from the environment when one is provided (CI images, this repo's sandbox). */
function launchOptions() {
  const fromEnv = process.env.CHROMIUM_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return { executablePath: fromEnv };
  const bundled = '/opt/pw-browsers';
  if (fs.existsSync(bundled)) {
    const dir = fs.readdirSync(bundled).find((d) => /^chromium-\d+$/.test(d));
    const exe = dir && path.join(bundled, dir, 'chrome-linux', 'chrome');
    if (exe && fs.existsSync(exe)) return { executablePath: exe };
  }
  return {};
}

const freePort = () => new Promise((resolve) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const waitFor = async (url, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`nothing answered at ${url}`);
};

/* ---------- a stand-in for Wave, speaking its checkout API ---------- */
function fakeWave() {
  const sessions = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const url = req.url.split('?')[0];
      if (req.method === 'POST' && url === '/v1/checkout/sessions') {
        const p = JSON.parse(body || '{}');
        const id = `cos-${sessions.size + 1}`;
        sessions.set(id, {
          id, client_reference: p.client_reference, amount: p.amount,
          success_url: p.success_url, error_url: p.error_url,
          checkout_status: 'open', payment_status: 'processing',
          wave_launch_url: `http://127.0.0.1:${server.address().port}/pay/${id}`,
        });
        return json(201, sessions.get(id));
      }
      const pay = url.match(/^\/pay\/([^/]+)$/);
      if (req.method === 'GET' && pay) {
        const s = sessions.get(pay[1]);
        if (!s) { res.writeHead(404); return res.end('no such session'); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><meta charset=utf-8><title>Wave</title>
          <body style="font-family:system-ui;padding:40px">
          <h1>Wave</h1><p>${s.amount} XOF</p>
          <button id=pay style="font-size:20px;padding:12px 24px">Payer</button>
          <button id=quit style="font-size:20px;padding:12px 24px">Annuler</button>
          <script>
            document.getElementById('pay').onclick=async()=>{
              await fetch('/settle/${s.id}',{method:'POST'});
              location.href=${JSON.stringify(s.success_url)};};
            document.getElementById('quit').onclick=()=>{location.href=${JSON.stringify(s.error_url)}};
          </script>`);
      }
      const settle = url.match(/^\/settle\/([^/]+)$/);
      if (req.method === 'POST' && settle) {
        const s = sessions.get(settle[1]);
        if (s) { s.payment_status = 'succeeded'; s.checkout_status = 'complete'; }
        return json(200, { ok: true });
      }
      const get = url.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
      if (req.method === 'GET' && get) {
        const s = sessions.get(get[1]);
        return s ? json(200, s) : json(404, { message: 'no such session' });
      }
      if (req.method === 'POST' && /\/refund$/.test(url)) return json(200, { ok: true });
      json(404, { message: 'not found' });
    });
  });
  return { server, sessions };
}

/** Brings the whole product up on free ports and hands back a page to drive. */
export async function startStack({ wallet = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai4food-web-'));
  const dbFile = path.join(dir, 'app.db');
  const apiPort = await freePort();
  const webPort = await freePort();

  const { server: wave, sessions } = fakeWave();
  await new Promise((r) => wave.listen(0, '127.0.0.1', r));
  const wavePort = wave.address().port;

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DB_FILE: dbFile,
    JWT_SECRET: 'web-test-secret',
    OTP_ECHO: 'true',
    PORT: String(apiPort),
    SMS_PROVIDER: 'console',
    RL_OTP_PER_HOUR: '1000',
    RL_WRITE_PER_MINUTE: '1000',
    RL_LOGIN_PER_HOUR: '1000',
    PUBLIC_API_URL: `http://127.0.0.1:${apiPort}`,
    PUBLIC_APP_URL: `http://127.0.0.1:${webPort}/ai4food-app.html`,
    PAYMENT_WINDOW_MINUTES: '15',
    ...(wallet ? {
      WAVE_BASE_URL: `http://127.0.0.1:${wavePort}`,
      WAVE_API_KEY: 'web-test-key',
      WAVE_WEBHOOK_SECRET: 'web-test-whsec',
    } : {}),
  };

  execFileSync('node', ['src/seed.js', '--fresh'],
    { cwd: path.join(repoRoot, 'server'), env, stdio: 'pipe' });

  const api = spawn('node', ['src/server.js'], { cwd: path.join(repoRoot, 'server'), env, stdio: 'pipe' });
  const web = spawn(process.execPath, [path.join(here, 'static-server.mjs'), String(webPort), repoRoot], { stdio: 'pipe' });

  await waitFor(`http://127.0.0.1:${apiPort}/health`);
  await waitFor(`http://127.0.0.1:${webPort}/ai4food-app.html`);

  const browser = await chromium.launch(launchOptions());
  const appUrl = `http://127.0.0.1:${webPort}/ai4food-app.html?api=http://127.0.0.1:${apiPort}`;

  return {
    appUrl, apiPort, webPort, sessions, browser,
    api: `http://127.0.0.1:${apiPort}`,
    /** A brand-new visitor: no cookies, no localStorage, nothing remembered. */
    async freshPage() {
      const context = await browser.newContext({ viewport: { width: 400, height: 860 } });
      const page = await context.newPage();
      page.errors = [];
      page.on('pageerror', (e) => page.errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) page.errors.push(m.text()); });
      return page;
    },
    async stop() {
      await browser.close().catch(() => {});
      api.kill('SIGTERM'); web.kill('SIGTERM'); wave.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The dev build prints the code into the field; this reads it back out. */
export async function signInAs(page, phone = '771234567') {
  await page.locator('input[type="tel"]').first().fill(phone);
  await page.getByRole('button', { name: /Recevoir le code/i }).click();
  await page.locator('#acode').waitFor({ timeout: 8000 });
  const code = await page.locator('#acode').inputValue();
  if (!code) throw new Error('no dev code came back');
  await page.getByRole('button', { name: /Se connecter/i }).click();
}

export const text = (page) => page.locator('body').innerText();
