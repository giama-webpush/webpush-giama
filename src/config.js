'use strict';
// Configuración desde variables de entorno (.env opcional, sin dependencias).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

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

function getConfig(overrides = {}) {
  const env = process.env;
  const dataDir = path.resolve(ROOT, overrides.dataDir || env.DATA_DIR || 'data');
  const production = (overrides.nodeEnv || env.NODE_ENV) === 'production';
  const cfg = {
    root: ROOT,
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    // En Vercel, VERCEL=1 y (si no hay BASE_URL) se usa https://$VERCEL_URL como respaldo
    serverless: bool(env.VERCEL, false) || bool(env.SERVERLESS, false),
    baseUrl: (env.BASE_URL || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : `http://localhost:${env.PORT || 3000}`)).replace(/\/+$/, ''),
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
    trustProxy: bool(env.TRUST_PROXY, bool(env.VERCEL, false)),
    timezone: env.APP_TIMEZONE || 'America/Argentina/Buenos_Aires',
    schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS || 15000),
    // En Vercel (Hobby, tope 10 s) lotes más chicos y un presupuesto de tiempo holgado
    sendConcurrency: Number(env.SEND_CONCURRENCY || (bool(env.VERCEL, false) ? 8 : 10)),
    sendBatchSize: Number(env.SEND_BATCH_SIZE || (bool(env.VERCEL, false) ? 40 : 200)),
    tickBudgetMs: env.TICK_BUDGET_MS != null && env.TICK_BUDGET_MS !== '' ? Number(env.TICK_BUDGET_MS) : (bool(env.VERCEL, false) ? 8000 : 0),
    inlineSendMax: Number(env.INLINE_SEND_MAX || 40),
    maxUploadBytes: Math.round(Number(env.MAX_UPLOAD_KB || 700) * 1024),   // imágenes guardadas en la base
    sessionHours: Number(env.SESSION_HOURS || 12),
    ...overrides,
  };
  return cfg;
}

function vercelRequiresTurso(cfg = {}) {
  // En el hosting de Vercel el disco es efímero. `vercel dev` (VERCEL_ENV=development) corre en tu máquina y puede usar SQLite local.
  if (!bool(process.env.VERCEL, false)) return false;
  if (process.env.VERCEL_ENV === 'development') return false;
  return !(cfg.tursoUrl && cfg.tursoToken);
}

function assertStorage(cfg) {
  if (vercelRequiresTurso(cfg)) {
    throw new Error('En Vercel el filesystem es efímero: definí TURSO_DATABASE_URL y TURSO_AUTH_TOKEN. Sin Turso la base se pierde en cada despliegue.');
  }
}

module.exports = { loadDotEnv, getConfig, assertStorage, vercelRequiresTurso, ROOT };
