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
    baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, ''),
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
    trustProxy: bool(env.TRUST_PROXY, false),
    timezone: env.APP_TIMEZONE || 'America/Argentina/Buenos_Aires',
    schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS || 15000),
    sendConcurrency: Number(env.SEND_CONCURRENCY || 10),
    sendBatchSize: Number(env.SEND_BATCH_SIZE || 200),
    maxUploadBytes: Math.round(Number(env.MAX_UPLOAD_KB || 700) * 1024),   // imágenes guardadas en la base
    sessionHours: Number(env.SESSION_HOURS || 12),
    ...overrides,
  };
  return cfg;
}

module.exports = { loadDotEnv, getConfig, ROOT };
