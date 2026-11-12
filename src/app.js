'use strict';
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const webpush = require('web-push');
const { openDb, getSetting, setSetting, nowIso } = require('./db');
const { assertStorage } = require('./config');
const { loadOrCreateSecrets } = require('./secrets');
const { ensureFirstAdmin } = require('./auth');
const { createSender } = require('./push');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');

const DEFAULT_SETTINGS = {
  site_name: 'Peugeot Giama',
  logo_url: '/brand/logo.png',
  icon_url: '/brand/icon-192.png',
  badge_url: '/brand/badge-96.png',
  optin_title: 'Enterate primero',
  optin_text: 'Activá los avisos y te contamos novedades, promociones y el estado de tu presupuesto. Sin mails ni llamadas: solo notificaciones en este dispositivo.',
  optin_button: 'Activar avisos',
  consent_text: 'Al activar los avisos aceptás recibir notificaciones de Peugeot Giama en este navegador. Podés darte de baja cuando quieras desde esta página o desde la configuración del navegador.',
  success_text: 'Listo, ya tenés los avisos activados. Te vamos a avisar solo lo importante.',
  default_url: 'https://www.peugeotgiama.com.ar/',
  privacy_contact: 'el canal de contacto de la concesionaria',
};

async function seedDefaults(db) {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if ((await getSetting(db, k)) === null) await setSetting(db, k, v);
  const has = (await db.get('SELECT COUNT(*) AS n FROM automations')).n;
  if (!has) {
    await db.run("INSERT INTO automations(type, name, enabled, days) VALUES('welcome', 'Bienvenida al suscribirse', 0, 0)");
    await db.run("INSERT INTO automations(type, name, enabled, days, filters) VALUES('recontact', 'Recontacto a los N días', 0, 7, '{}')");
  }
}

function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
}

async function createApp({ cfg, db, sendNotification, logger = console } = {}) {
  assertStorage(cfg);
  db = db || await openDb({ tursoUrl: cfg.tursoUrl, tursoToken: cfg.tursoToken, file: cfg.dbFile, driver: cfg.dbDriver });
  const secrets = await loadOrCreateSecrets(db, cfg, logger);
  cfg.phoneHashSecret = secrets.phoneHashSecret;
  const vapid = { publicKey: secrets.vapidPublicKey, privateKey: secrets.vapidPrivateKey, subject: cfg.vapidSubject, source: secrets.vapidSource };
  await seedDefaults(db);
  await ensureFirstAdmin(db, cfg, logger);
  const prevPub = await getSetting(db, 'vapid_public_in_use');
  if (prevPub && prevPub !== vapid.publicKey) {
    logger.warn('[vapid] La clave pública VAPID cambió respecto de la que usaron los suscriptores existentes: los envíos a esos suscriptores van a fallar (403). Restaurá las claves anteriores.');
  }
  await setSetting(db, 'vapid_public_in_use', vapid.publicKey);

  const sender = createSender({ db, cfg, vapid, logger, sendNotification: sendNotification || webpush.sendNotification.bind(webpush) });
  const ctx = { db, cfg, vapid, sender, logger, startedAt: nowIso() };

  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', 1);
  app.use(securityHeaders);

  const health = async (req, res) => {
    let dbOk = true;
    try { await db.get('SELECT 1 AS x'); } catch { dbOk = false; }
    res.status(dbOk ? 200 : 503).json({ ok: dbOk, service: 'webpush', time: nowIso() });
  };
  app.get('/health', health);
  app.get('/healthz', health);

  // Assets de marca: primero BRAND_DIR (reemplazos del Diseñador), si no, public/brand
  if (cfg.brandDir && fs.existsSync(cfg.brandDir)) app.use('/brand', express.static(cfg.brandDir, { maxAge: '1h', dotfiles: 'allow' }));
  app.use('/brand', express.static(path.join(cfg.root, 'public/brand'), { maxAge: '1h', dotfiles: 'allow' }));
  // Al despertar, o en serverless (sin timers), una visita puede retomar campañas atrasadas.
  // El trabajo se persiste por tanda en la DB; /api/cron/tick es el camino confiable.
  app.use((req, res, next) => {
    if (req.path === '/api/cron/tick' || req.path === '/health' || req.path === '/healthz') return next();
    const p = sender.nudge(60e3);
    if (p && cfg.serverless) {
      try { const { waitUntil } = require('@vercel/functions'); if (typeof waitUntil === 'function') waitUntil(p); } catch { /* paquete opcional */ }
    }
    next();
  });

  app.use(publicRoutes(ctx));
  app.use('/admin/api', adminRoutes(ctx));
  app.use('/api', apiRoutes(ctx));
  app.use('/admin', express.static(path.join(cfg.root, 'public/admin'), { index: 'index.html', dotfiles: 'allow' }));
  app.use(express.static(path.join(cfg.root, 'public'), { index: false, extensions: ['html'], dotfiles: 'allow' }));

  app.use((req, res) => res.status(404).type('text/plain').send('No encontrado'));
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) logger.error('[error]', err.message);
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Archivo o pedido demasiado grande' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    res.status(status).json({ error: status >= 500 ? 'Error interno' : err.message });
  });

  return { app, db, sender, ctx };
}

module.exports = { createApp, DEFAULT_SETTINGS };
