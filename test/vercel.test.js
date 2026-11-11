'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getConfig, assertStorage } = require('../src/config');
const { createApp } = require('../src/app');
const { createHandler } = require('../src/handler');
const { startTestApp, fakeSubscription, subscribe, adminLogin } = require('./helpers');

async function crearPieza(s) {
  const r = await s.call('POST', '/pieces', { name: 'P', title: 'Hola {{modelo}}', body: 'Promo', url: 'https://www.peugeotgiama.com.ar/' });
  return r.body.id;
}

test('api/index.js exporta un handler (sin arrancar el servidor)', () => {
  const handler = require('../api/index.js');
  assert.equal(typeof handler, 'function');
  assert.equal(typeof handler.ensure, 'function');
});

test('el handler de Vercel sirve /health, /s y /sw.js con Service-Worker-Allowed: /', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-handler-'));
  const silent = { log() {}, warn() {}, error() {} };
  const cfg = getConfig({
    dataDir: dir, dbFile: path.join(dir, 'test.db'), tursoUrl: '', tursoToken: '',
    adminUser: 'admin', adminPassword: 'clave-de-test-123', apiKey: 'api-key-de-test',
    phoneHashSecret: 'secreto-test', cookieSecure: false, schedulerIntervalMs: 999999,
    baseUrl: 'http://127.0.0.1',
  });
  const handler = createHandler({ cfg, logger: silent, sendNotification: async () => ({ statusCode: 201 }) });
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => { handler(req, res); });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const h = await fetch(`${base}/health`);
    assert.equal(h.status, 200);
    assert.equal((await h.json()).ok, true);
    const land = await fetch(`${base}/s`);
    assert.equal(land.status, 200);
    assert.match(await land.text(), /Activar avisos|Peugeot/i);
    const sw = await fetch(`${base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.equal(sw.headers.get('service-worker-allowed'), '/');
    assert.match(sw.headers.get('cache-control') || '', /no-cache/i);
    assert.match(sw.headers.get('content-type') || '', /javascript/);
    assert.match(await sw.text(), /addEventListener\(['"]push['"]/);
    const adm = await fetch(`${base}/admin/`);
    assert.equal(adm.status, 200);
    const { app, db } = await handler.ensure();
    assert.ok(app);
    await new Promise((r) => server.close(r));
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('con VERCEL=1 y sin Turso el arranque falla con un mensaje claro', async () => {
  const prev = process.env.VERCEL;
  process.env.VERCEL = '1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-vercel-'));
  const silent = { log() {}, warn() {}, error() {} };
  try {
    const cfg = getConfig({
      dataDir: dir, dbFile: path.join(dir, 'test.db'), tursoUrl: '', tursoToken: '',
      adminPassword: 'clave-de-test-123',
    });
    assert.equal(cfg.serverless, true);
    assert.throws(() => assertStorage(cfg), /TURSO_DATABASE_URL/);
    await assert.rejects(() => createApp({ cfg, logger: silent }), /TURSO_DATABASE_URL/);
  } finally {
    if (prev === undefined) delete process.env.VERCEL; else process.env.VERCEL = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tick por tandas: retoma el envío desde la DB en la tanda siguiente', async () => {
  const t = await startTestApp({ overrides: { sendBatchSize: 5, sendConcurrency: 2, tickBudgetMs: 0 } });
  try {
    for (let i = 0; i < 12; i++) await subscribe(t.base, { modelo: '208' }, fakeSubscription(`lote-${i}`));
    const s = await adminLogin(t.base);
    const pid = await crearPieza(s);
    const id = (await s.call('POST', '/campaigns', { name: 'Por tandas', piece_id: pid, mode: 'draft' })).body.id;
    await t.db.run("UPDATE campaigns SET status = 'programada', scheduled_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), id);

    const a = await t.sender.tick({ maxBatches: 1 });
    assert.deepEqual(a.processed, [id]);
    assert.equal(a.more, true);
    assert.deepEqual(a.remaining, [id]);
    const st1 = (await s.call('GET', `/campaigns/${id}`)).body;
    assert.equal(st1.status, 'enviando');
    assert.equal(st1.stats.sent, 5);
    assert.equal(st1.stats.queued, 7);

    const b = await t.sender.tick({ maxBatches: 1 });
    assert.equal(b.more, true);
    assert.equal((await s.call('GET', `/campaigns/${id}`)).body.stats.sent, 10);

    const c = await t.sender.tick({ maxBatches: 1 });
    assert.equal(c.more, false);
    assert.deepEqual(c.remaining, []);
    const st3 = (await s.call('GET', `/campaigns/${id}`)).body;
    assert.equal(st3.status, 'finalizada');
    assert.equal(st3.stats.sent, 12);
    assert.equal(t.calls.length, 12);
  } finally { await t.close(); }
});

test('en modo serverless una campaña chica se envía en línea y una grande queda encolada', async () => {
  const t = await startTestApp({ overrides: { serverless: true, inlineSendMax: 2, sendBatchSize: 10, tickBudgetMs: 8000 } });
  try {
    await subscribe(t.base, { modelo: '2008' }, fakeSubscription('chica'));
    for (let i = 0; i < 5; i++) await subscribe(t.base, { modelo: '208' }, fakeSubscription(`grande-${i}`));
    const s = await adminLogin(t.base);
    const pid = await crearPieza(s);

    const grande = (await s.call('POST', '/campaigns', { name: 'Grande', piece_id: pid, filters: { modelo: ['208'] }, mode: 'now' })).body;
    assert.equal((await s.call('GET', `/campaigns/${grande.id}`)).body.status, 'programada');
    assert.equal(t.calls.length, 0);

    const chica = (await s.call('POST', '/campaigns', { name: 'Chica', piece_id: pid, filters: { modelo: ['2008'] }, mode: 'now' })).body;
    const stChica = (await s.call('GET', `/campaigns/${chica.id}`)).body;
    assert.equal(stChica.status, 'finalizada');
    assert.equal(stChica.stats.sent, 1);

    const tick = await t.sender.tick();
    assert.ok(tick.processed.includes(grande.id));
    const stG = (await s.call('GET', `/campaigns/${grande.id}`)).body;
    assert.equal(stG.status, 'finalizada');
    assert.equal(stG.stats.sent, 5);
    assert.equal(t.calls.length, 6);
  } finally { await t.close(); }
});
