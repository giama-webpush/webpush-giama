'use strict';
// Configuración desde variables de entorno (.env opcional, sin dependencias).
const fs = require('node:fs');
const path = require('node:path');

// En local, este archivo vive en src/ (raíz = padre). En Netlify/Vercel el bundle
// puede quedar en otro directorio: buscamos public/s.html hacia arriba y en cwd.
function findRoot() {
  const seen = [];
  const add = (d) => { try { d = path.resolve(d); } catch { return; } if (!seen.includes(d)) seen.push(d); };
  if (typeof __dirname === 'string') {
    add(__dirname);
    add(path.join(__dirname, '..'));
    add(path.join(__dirname, '../..'));
    add(path.join(__dirname, '../../..'));
  }
  add(process.cwd());
  for (const d of seen) {
    if (fs.existsSync(path.join(d, 'public', 's.html'))) return d;
  }
  return path.resolve(__dirname, '..');
}
const ROOT = findRoot();

function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'si', 'sí', 'on'].includes(String(v).toLowerCase());
}

function runningServerless() {
  const env = process.env;
  return bool(env.VERCEL, false) || bool(env.NETLIFY, false)
    || bool(env.AWS_LAMBDA_FUNCTION_NAME, false) || bool(env.AWS_EXECUTION_ENV, false)
    || bool(env.AWS_LAMBDA, false) || bool(env.SERVERLESS, false);
}

function isServerlessDev() {
  const env = process.env;
  return env.VERCEL_ENV === 'development' || bool(env.NETLIFY_DEV, false) || env.CONTEXT === 'dev';
}

function getConfig(overrides = {}) {
  const env = process.env;
  const dataDir = path.resolve(ROOT, overrides.dataDir || env.DATA_DIR || 'data');
  const production = (overrides.nodeEnv || env.NODE_ENV) === 'production';
  const serverless = runningServerless();
  const defaultBase = env.VERCEL_URL ? `https://${env.VERCEL_URL}` : (env.URL || `http://localhost:${env.PORT || 3000}`);
  const cfg = {
    root: ROOT,
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    // Vercel (VERCEL=1), Netlify (NETLIFY / AWS_LAMBDA_*) o SERVERLESS=1: sin timers, tandas de ~8 s
    serverless,
    // BASE_URL; si falta: https://$VERCEL_URL, o $URL (Netlify), o localhost
    baseUrl: (env.BASE_URL || defaultBase).replace(/\/+$/, ''),
    production,
    dataDir,
    dbFile: overrides.dbFile || (env.DB_PATH ? path.resolve(ROOT, env.DB_PATH) : path.join(dataDir, 'webpush.db')),
    tursoUrl: env.TURSO_DATABASE_URL || '',
    tursoToken: env.TURSO_AUTH_TOKEN || '',
    dbDriver: env.DB_DRIVER || 'libsql',
    brandDir: env.BRAND_DIR ? path.resolve(ROOT, env.BRAND_DIR) : null,
    adminUser: env.ADMIN_USER || 'admin',
    adminPassword: env.ADMIN_PASSWORD || '',
    apiKey: env.ADMIN_KEY || env.API_KEY || '',   // clave de la API de integración
    vapidPublicKey: env.VAPID_PUBLIC_KEY || '',
    vapidPrivateKey: env.VAPID_PRIVATE_KEY || '',
    vapidSubject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
    phoneHashSecret: env.PHONE_HASH_SECRET || '',
    phoneEncKey: env.PHONE_ENC_KEY || '',
    cookieSecure: bool(env.COOKIE_SECURE, production),
    trustProxy: bool(env.TRUST_PROXY, serverless),
    timezone: env.APP_TIMEZONE || 'America/Argentina/Buenos_Aires',
    schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS || 15000),
    // En serverless (Vercel Hobby 10 s / Netlify Functions ~10–26 s) lotes más chicos y presupuesto holgado
    sendConcurrency: Number(env.SEND_CONCURRENCY || (serverless ? 8 : 10)),
    sendBatchSize: Number(env.SEND_BATCH_SIZE || (serverless ? 40 : 200)),
    tickBudgetMs: env.TICK_BUDGET_MS != null && env.TICK_BUDGET_MS !== '' ? Number(env.TICK_BUDGET_MS) : (serverless ? 8000 : 0),
    inlineSendMax: Number(env.INLINE_SEND_MAX || 40),
    maxUploadBytes: Math.round(Number(env.MAX_UPLOAD_KB || 700) * 1024),   // imágenes guardadas en la base
    sessionHours: Number(env.SESSION_HOURS || 12),
    ...overrides,
  };
  return cfg;
}

function serverlessRequiresTurso(cfg = {}) {
  // En Vercel y Netlify el disco es efímero. `vercel dev` / `netlify dev` corren en tu máquina y pueden usar SQLite local.
  if (!runningServerless()) return false;
  if (isServerlessDev()) return false;
  return !(cfg.tursoUrl && cfg.tursoToken);
}

function assertStorage(cfg) {
  if (serverlessRequiresTurso(cfg)) {
    throw new Error('En Vercel y Netlify el filesystem es efímero: definí TURSO_DATABASE_URL y TURSO_AUTH_TOKEN. Sin Turso la base se pierde en cada despliegue.');
  }
}

const vercelRequiresTurso = serverlessRequiresTurso;

module.exports = { loadDotEnv, getConfig, assertStorage, serverlessRequiresTurso, vercelRequiresTurso, runningServerless, isServerlessDev, ROOT };
