'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getConfig, assertStorage } = require('../src/config');
const { createApp } = require('../src/app');
const { createScheduledHandler } = require('../src/handler');
const { createNetlifyFunction } = require('../netlify/functions/app');
const { startTestApp, fakeSubscription, subscribe, adminLogin } = require('./helpers');

function testCfg(dir, extra = {}) {
  return getConfig({
    dataDir: dir, dbFile: path.join(dir, 'test.db'), tursoUrl: '', tursoToken: '',
    adminUser: 'admin', adminPassword: 'clave-de-test-123', apiKey: 'api-key-de-test',
    phoneHashSecret: 'secreto-test', cookieSecure: false, schedulerIntervalMs: 999999,
    baseUrl: 'https://ejemplo.netlify.app', ...extra,
  });
}

function event({ method = 'GET', path = '/', headers = {}, body = null, query = null } = {}) {
  const raw = body == null ? null : (Buffer.isBuffer(body) ? body : (typeof body === 'string' ? body : JSON.stringify(body)));
  const isB64 = Buffer.isBuffer(body);
  return {
    httpMethod: method,
    path,
    rawUrl: `https://ejemplo.netlify.app${path}`,
    headers: { host: 'ejemplo.netlify.app', 'x-forwarded-proto': 'https', accept: '*/*', ...headers },
    queryStringParameters: query,
    body: raw == null ? null : (isB64 ? Buffer.from(raw).toString('base64') : raw),
    isBase64Encoded: isB64,
    requestContext: { httpMethod: method, path },
  };
}

function header(res, name) {
  const h = res.headers || res.multiValueHeaders || {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return '';
  const v = h[key];
  return Array.isArray(v) ? v.join(', ') : String(v);
}

function bodyBuf(res) {
  if (res.isBase64Encoded) return Buffer.from(res.body || '', 'base64');
  return Buffer.from(res.body || '', 'utf8');
}

test('netlify/functions/app.js exporta un handler Lambda', () => {
  const mod = require('../netlify/functions/app.js');
  assert.equal(typeof mod.handler, 'function');
  assert.equal(typeof mod.createNetlifyFunction, 'function');
  const tick = require('../netlify/functions/tick-scheduled.js');
  assert.equal(typeof tick.handler, 'function');
  assert.equal(tick.config && tick.config.schedule, '*/5 * * * *');
  const toml = fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8');
  assert.match(toml, /schedule\s*=\s*"\*\/5 \* \* \* \*"/);
  assert.match(toml, /included_files\s*=\s*\["public\/\*\*"\]/);
  assert.match(toml, /external_node_modules\s*=\s*\["@libsql\/client"\]/);
  assert.match(toml, /Service-Worker-Allowed/);
});

test('el handler de Netlify sirve /health, /s y /sw.js (también bajo el prefijo de la función)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-netlify-'));
  const silent = { log() {}, warn() {}, error() {} };
  const fn = createNetlifyFunction({ cfg: testCfg(dir), logger: silent, sendNotification: async () => ({ statusCode: 201 }) });
  const ctx = { callbackWaitsForEmptyEventLoop: true };
  try {
    const h = await fn(event({ path: '/health' }), ctx);
    assert.equal(h.statusCode, 200);
    assert.equal(JSON.parse(bodyBuf(h).toString()).ok, true);
    assert.equal(ctx.callbackWaitsForEmptyEventLoop, false);

    const land = await fn(event({ path: '/s' }));
    assert.equal(land.statusCode, 200);
    assert.match(bodyBuf(land).toString(), /Activar avisos|Peugeot/i);

    const prefixed = await fn(event({ path: '/.netlify/functions/app/s' }));
    assert.equal(prefixed.statusCode, 200);
    assert.match(bodyBuf(prefixed).toString(), /Activar avisos|Peugeot/i);

    const sw = await fn(event({ path: '/sw.js' }));
    assert.equal(sw.statusCode, 200);
    assert.equal(header(sw, 'service-worker-allowed'), '/');
    assert.match(header(sw, 'cache-control'), /no-cache/i);
    assert.match(header(sw, 'content-type'), /javascript/);
    assert.match(bodyBuf(sw).toString(), /addEventListener\(['"]push['"]/);

    const icon = await fn(event({ path: '/brand/icon-192.png' }));
    assert.equal(icon.statusCode, 200);
    assert.match(header(icon, 'content-type'), /image\/png/);
    const img = bodyBuf(icon);
    assert.ok(img.length > 32);
    assert.deepEqual(img.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const { db } = await fn.ensure();
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('con NETLIFY=true y sin Turso el arranque falla con un mensaje claro', async () => {
  const prev = { NETLIFY: process.env.NETLIFY, AWS_LAMBDA_FUNCTION_NAME: process.env.AWS_LAMBDA_FUNCTION_NAME, NETLIFY_DEV: process.env.NETLIFY_DEV, CONTEXT: process.env.CONTEXT };
  process.env.NETLIFY = 'true';
  delete process.env.NETLIFY_DEV;
  delete process.env.CONTEXT;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-netlify-turso-'));
  const silent = { log() {}, warn() {}, error() {} };
  try {
    const cfg = testCfg(dir);
    assert.equal(cfg.serverless, true);
    assert.match(cfg.baseUrl, /ejemplo\.netlify\.app|localhost/);
    assert.throws(() => assertStorage(cfg), /TURSO_DATABASE_URL/);
    await assert.rejects(() => createApp({ cfg, logger: silent }), /TURSO_DATABASE_URL/);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BASE_URL usa process.env.URL como respaldo (Netlify)', () => {
  const prev = { BASE_URL: process.env.BASE_URL, URL: process.env.URL, VERCEL_URL: process.env.VERCEL_URL };
  delete process.env.BASE_URL;
  delete process.env.VERCEL_URL;
  process.env.URL = 'https://webpush-giama.netlify.app';
  try {
    const cfg = getConfig({ dataDir: os.tmpdir() });
    assert.equal(cfg.baseUrl, 'https://webpush-giama.netlify.app');
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('la función programada de Netlify corre el tick directo (por tandas)', async () => {
  const t = await startTestApp({ overrides: { sendBatchSize: 5, sendConcurrency: 2, tickBudgetMs: 0 } });
  try {
    for (let i = 0; i < 8; i++) await subscribe(t.base, { modelo: '208' }, fakeSubscription(`nl-${i}`));
    const s = await adminLogin(t.base);
    const pid = (await s.call('POST', '/pieces', { name: 'P', title: 'Hola', body: 'Promo', url: 'https://www.peugeotgiama.com.ar/' })).body.id;
    const id = (await s.call('POST', '/campaigns', { name: 'Netlify cron', piece_id: pid, mode: 'draft' })).body.id;
    await t.db.run("UPDATE campaigns SET status = 'programada', scheduled_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), id);

    const run = createScheduledHandler({ handler: { ensure: async () => ({ sender: t.sender, cfg: t.cfg }) } });
    const a = await run({}, {});
    assert.equal(a.statusCode, 200);
    const body = JSON.parse(a.body);
    assert.equal(body.ok, true);
    assert.equal(body.source, 'schedule');
    assert.deepEqual(body.processed, [id]);
    // sin maxBatches y con tickBudgetMs 0 procesa todo
    assert.equal(body.more, false);
    const st = (await s.call('GET', `/campaigns/${id}`)).body;
    assert.equal(st.status, 'finalizada');
    assert.equal(st.stats.sent, 8);
  } finally { await t.close(); }
});
