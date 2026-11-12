'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { getConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { setSetting } = require('../src/db');

// Driver de la base para los tests: libsql en modo archivo local (file:) por defecto.
const DRIVER = process.env.TEST_DB_DRIVER || 'libsql';

async function startTestApp({ sendNotification, overrides = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-test-'));
  const cfg = getConfig({
    dataDir: dir, dbFile: path.join(dir, 'test.db'), dbDriver: DRIVER, tursoUrl: '', tursoToken: '',
    adminUser: 'admin', adminPassword: 'clave-de-test-123', apiKey: 'api-key-de-test',
    vapidPublicKey: '', vapidPrivateKey: '', phoneHashSecret: 'secreto-test', phoneEncKey: '',
    baseUrl: 'http://127.0.0.1', schedulerIntervalMs: 999999, cookieSecure: false, ...overrides,
  });
  const silent = { log() {}, warn() {}, error() {} };
  const calls = [];
  const sn = sendNotification || (async (sub, payload, opts) => { calls.push({ sub, payload: JSON.parse(payload), opts }); return { statusCode: 201 }; });
  const { app, db, sender } = await createApp({ cfg, sendNotification: async (...a) => sn(...a), logger: silent });
  // Los tests no deben depender de la hora de Buenos Aires: franja abierta 0-24.
  await setSetting(db, 'send_window_start', '0');
  await setSetting(db, 'send_window_end', '24');
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  cfg.baseUrl = base;
  return {
    base, db, sender, cfg, calls,
    async close() { await new Promise((r) => server.close(r)); db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function fakeSubscription(tag = crypto.randomBytes(8).toString('hex')) {
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${tag}`, keys: { p256dh: crypto.randomBytes(65).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}

const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function subscribe(base, meta = {}, sub = fakeSubscription(), ua = UA_ANDROID) {
  const res = await fetch(`${base}/api/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua }, body: JSON.stringify({ subscription: sub, meta }) });
  return { res, body: await res.json(), sub };
}

async function adminLogin(base, password = 'clave-de-test-123') {
  const res = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
  const body = await res.json();
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const call = async (method, p, data) => {
    const r = await fetch(`${base}/admin/api${p}`, { method, headers: { Cookie: cookie, 'X-CSRF-Token': body.csrf || '', ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
  };
  return { res, body, cookie, csrf: body.csrf, call };
}

module.exports = { startTestApp, fakeSubscription, subscribe, adminLogin, UA_ANDROID, UA_WIN, DRIVER };
