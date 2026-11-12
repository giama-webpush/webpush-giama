'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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
  assert.equal(typeof tick.default, 'function');
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
    assert.match(bodyBuf(land).toString(), /Quiero recibir las ofertas|Peugeot/i);

    const prefixed = await fn(event({ path: '/.netlify/functions/app/s' }));
    assert.equal(prefixed.statusCode, 200);
    assert.match(bodyBuf(prefixed).toString(), /Quiero recibir las ofertas|Peugeot/i);

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

function cookieFrom(res) {
  const h = res.headers || {};
  const mv = res.multiValueHeaders || {};
  const raw = h['set-cookie'] || h['Set-Cookie'] || mv['set-cookie'] || mv['Set-Cookie'] || '';
  const first = Array.isArray(raw) ? raw[0] : String(raw);
  return (first.split(';')[0] || '').trim();
}

test('login por Lambda: body JSON en texto y en base64, cookie de sesión y /me', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-nl-login-'));
  const silent = { log() {}, warn() {}, error() {} };
  const fn = createNetlifyFunction({
    cfg: testCfg(dir, { cookieSecure: true, production: true, trustProxy: true }),
    logger: silent,
    sendNotification: async () => ({ statusCode: 201 }),
  });
  const ctx = {};
  const creds = { username: 'admin', password: 'clave-de-test-123' };
  try {
    // 1) body en texto plano, content-type json
    const plain = await fn(event({
      method: 'POST', path: '/admin/api/login',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.20' },
      body: JSON.stringify(creds),
    }), ctx);
    assert.equal(plain.statusCode, 200, plain.body);
    const pbody = JSON.parse(bodyBuf(plain).toString());
    assert.equal(pbody.ok, true);
    assert.ok(pbody.csrf);
    const cookiePlain = cookieFrom(plain);
    assert.match(cookiePlain, /^wp_sid=/);
    assert.match(String(plain.headers['set-cookie']), /HttpOnly/i);
    assert.match(String(plain.headers['set-cookie']), /SameSite=Strict/i);
    assert.match(String(plain.headers['set-cookie']), /Secure/i);
    assert.ok(plain.multiValueHeaders && plain.multiValueHeaders['set-cookie']);

    // 2) body en base64 (como suele mandarlo Netlify)
    const raw = JSON.stringify(creds);
    const b64 = await fn(event({
      method: 'POST', path: '/admin/api/login',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(raw),
    }), ctx);
    // event() already base64-encodes Buffers; also try explicit
    assert.equal(b64.statusCode, 200, b64.body);

    const explicit = await fn({
      httpMethod: 'POST',
      path: '/admin/api/login',
      headers: { host: 'ejemplo.netlify.app', 'content-type': 'application/json', accept: '*/*' },
      body: Buffer.from(raw).toString('base64'),
      isBase64Encoded: true,
      requestContext: { httpMethod: 'POST', path: '/admin/api/login' },
    }, ctx);
    assert.equal(explicit.statusCode, 200, explicit.body);
    const cookie = cookieFrom(explicit);
    assert.match(cookie, /^wp_sid=/);

    // 3) la cookie abre el panel
    const me = await fn(event({
      path: '/admin/api/me',
      headers: { cookie },
    }), ctx);
    assert.equal(me.statusCode, 200, me.body);
    const meBody = JSON.parse(bodyBuf(me).toString());
    assert.equal(meBody.user.username, 'admin');
    assert.equal(meBody.csrf, JSON.parse(bodyBuf(explicit).toString()).csrf);

    // 4) sin content-type, body JSON (rewrite que pierde el header)
    const noCt = await fn({
      httpMethod: 'POST',
      path: '/admin/api/login',
      headers: { host: 'ejemplo.netlify.app', accept: '*/*' },
      body: raw,
      isBase64Encoded: false,
      requestContext: { httpMethod: 'POST', path: '/admin/api/login' },
    }, ctx);
    assert.equal(noCt.statusCode, 200, noCt.body);

    // 5) contraseña incorrecta sigue en 401
    const bad = await fn(event({
      method: 'POST', path: '/admin/api/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'no-es-esa' }),
    }), ctx);
    assert.equal(bad.statusCode, 401);

    const { db } = await fn.ensure();
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('suscripción y subida de imagen por Lambda con body en base64', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-nl-body-'));
  const silent = { log() {}, warn() {}, error() {} };
  const fn = createNetlifyFunction({
    cfg: testCfg(dir, { cookieSecure: false, maxUploadBytes: 20000 }),
    logger: silent,
    sendNotification: async () => ({ statusCode: 201 }),
  });
  try {
    const sub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/netlify-body-test',
      keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') },
    };
    const subRes = await fn({
      httpMethod: 'POST',
      path: '/api/subscribe',
      headers: { host: 'ejemplo.netlify.app', 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36' },
      body: Buffer.from(JSON.stringify({ subscription: sub, meta: { marca: 'PEUGEOT', modelo: '208' } })).toString('base64'),
      isBase64Encoded: true,
      requestContext: { httpMethod: 'POST', path: '/api/subscribe' },
    }, {});
    assert.equal(subRes.statusCode, 201, subRes.body);
    assert.ok(JSON.parse(bodyBuf(subRes).toString()).manageToken);

    const loginRes = await fn(event({
      method: 'POST', path: '/admin/api/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'clave-de-test-123' }),
    }), {});
    assert.equal(loginRes.statusCode, 200, loginRes.body);
    const cookie = cookieFrom(loginRes);
    const csrf = JSON.parse(bodyBuf(loginRes).toString()).csrf;
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
    const up = await fn({
      httpMethod: 'POST',
      path: '/admin/api/uploads',
      headers: {
        host: 'ejemplo.netlify.app',
        'content-type': 'image/png',
        cookie,
        'x-csrf-token': csrf,
        origin: 'https://ejemplo.netlify.app',
      },
      body: png.toString('base64'),
      isBase64Encoded: true,
      requestContext: { httpMethod: 'POST', path: '/admin/api/uploads' },
    }, {});
    assert.equal(up.statusCode, 201, up.body);
    const upBody = JSON.parse(bodyBuf(up).toString());
    assert.match(upBody.url, /^\/media\//);

    const { db } = await fn.ensure();
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tickChildEnv(dataDir, dbFile) {
  // Entorno mínimo: no heredamos TURSO_*/secretos del proceso (loadDotEnv no pisa claves ya definidas).
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || '',
    NODE_ENV: 'test',
    NETLIFY: 'true',
    NETLIFY_DEV: 'true',
    CONTEXT: 'dev',
    DATA_DIR: dataDir,
    DB_PATH: dbFile,
    DB_DRIVER: process.env.TEST_DB_DRIVER || 'libsql',
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'clave-de-test-123',
    ADMIN_KEY: 'api-key-de-test',
    PHONE_HASH_SECRET: 'secreto-test',
    COOKIE_SECURE: 'false',
    SCHEDULER_INTERVAL_MS: '999999',
    TICK_BUDGET_MS: '8000',
    BASE_URL: 'https://ejemplo.netlify.app',
    TURSO_DATABASE_URL: '',
    TURSO_AUTH_TOKEN: '',
    VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
    VAPID_SUBJECT: 'mailto:admin@example.com',
  };
  return env;
}

function invokeTickModule(modulePath, { dataDir, dbFile, cwd }) {
  const root = cwd || path.join(__dirname, '..');
  const script = `
'use strict';
const tick = require(${JSON.stringify(modulePath)});
const logs = [];
const wrap = (orig) => (...a) => {
  logs.push(a.map((x) => typeof x === 'string' ? x : (x && x.stack) || String(x)).join(' '));
  orig.apply(console, a);
};
console.log = wrap(console.log);
console.error = wrap(console.error);
function normalize(res) {
  if (res && typeof Response === 'function' && res instanceof Response) {
    return res.text().then((body) => ({ kind: 'Response', statusCode: res.status, body }));
  }
  return Promise.resolve({ kind: 'lambda', statusCode: res && res.statusCode, body: res && res.body });
}
(async () => {
  if (typeof tick.handler !== 'function' || typeof tick.default !== 'function') {
    throw new Error('faltan exports handler/default');
  }
  const h = await tick.handler({}, { callbackWaitsForEmptyEventLoop: true });
  const req = (typeof Request === 'function')
    ? new Request('https://ejemplo.netlify.app/.netlify/functions/tick-scheduled', { method: 'POST' })
    : {};
  const d = await tick.default(req, {});
  const handler = await normalize(h);
  const def = await normalize(d);
  process.stdout.write(JSON.stringify({ handler, default: def, logs }) + '\\n');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`;
  return spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...tickChildEnv(dataDir, dbFile), NODE_PATH: path.join(root, 'node_modules') },
  });
}

function assertTickInvocation(r, label) {
  assert.equal(r.status, 0, `${label} falló: ${(r.stderr || r.stdout || '').slice(0, 3000)}`);
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).at(-1);
  assert.ok(line, `${label}: sin JSON de salida`);
  const out = JSON.parse(line);
  assert.equal(out.handler.statusCode, 200, `${label} handler: ${out.handler.body}`);
  assert.equal(out.default.statusCode, 200, `${label} default: ${out.default.body}`);
  const hb = JSON.parse(out.handler.body);
  const db = JSON.parse(out.default.body);
  assert.equal(hb.ok, true);
  assert.equal(hb.source, 'schedule');
  assert.ok(Array.isArray(hb.processed));
  assert.equal(db.ok, true);
  assert.equal(db.source, 'schedule');
  const joined = (out.logs || []).join('\n');
  assert.match(joined, /\[tick-scheduled\] inicio/);
  assert.match(joined, /\[tick-scheduled\] resultado/);
  assert.match(joined, /"ok":true/);
  assert.doesNotMatch(joined, /tickBudgetMs/);
  return out;
}

test('createScheduledHandler arma el mismo ctx que /api/cron/tick (cfg en ctx, no suelto)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-sched-ctx-'));
  const silent = { log() {}, warn() {}, error() {} };
  const { createHandler } = require('../src/handler');
  const fn = createHandler({
    cfg: testCfg(dir, { tickBudgetMs: 8000 }),
    logger: silent,
    sendNotification: async () => ({ statusCode: 201 }),
  });
  try {
    const boot = await fn.ensure();
    assert.ok(boot.sender);
    assert.ok(boot.ctx && boot.ctx.cfg && typeof boot.ctx.cfg.tickBudgetMs === 'number');
    // El bug de producción: ensure() devuelve { app, db, sender, ctx } y cfg vive en ctx.cfg.
    // createScheduledHandler no debe asumir cfg en el top-level.
    const run = createScheduledHandler({ handler: fn });
    const a = await run({}, { callbackWaitsForEmptyEventLoop: true });
    assert.equal(a.statusCode, 200);
    const body = JSON.parse(a.body);
    assert.equal(body.ok, true);
    assert.equal(body.source, 'schedule');
    assert.ok(Array.isArray(body.processed));
    boot.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tick-scheduled: handler y default se invocan como Netlify y loguean resultado', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-tick-invoke-'));
  const dbFile = path.join(dir, 'test.db');
  try {
    const tickPath = path.join(__dirname, '..', 'netlify/functions/tick-scheduled.js');
    const r = invokeTickModule(tickPath, { dataDir: dir, dbFile, cwd: path.join(__dirname, '..') });
    assertTickInvocation(r, 'tick-scheduled fuente');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('el bundle esbuild de tick-scheduled se invoca como Netlify y loguea resultado', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-tick-bundle-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-tick-bundle-db-'));
  const outfile = path.join(outDir, 'tick-scheduled.js');
  const root = path.join(__dirname, '..');
  const bundled = spawnSync('npx', ['--yes', 'esbuild', 'netlify/functions/tick-scheduled.js', '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`, '--external:@libsql/client', '--log-level=warning'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
  });
  try {
    assert.equal(bundled.status, 0, (bundled.stderr || bundled.stdout || 'esbuild falló').slice(0, 2000));
    assert.ok(fs.existsSync(outfile));
    const js = fs.readFileSync(outfile, 'utf8');
    assert.match(js, /require\(["']@libsql\/client["']\)/, '@libsql/client debe quedar como require externo');
    const r = invokeTickModule(outfile, { dataDir, dbFile: path.join(dataDir, 'test.db'), cwd: root });
    const out = assertTickInvocation(r, 'tick-scheduled bundle');
    assert.equal(out.handler.kind, 'lambda');
    assert.equal(out.default.kind, 'Response');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
