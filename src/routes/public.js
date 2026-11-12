'use strict';
const path = require('node:path');
const express = require('express');
const { getSetting, getSettings, nowIso } = require('../db');
const { upsertSubscription, unsubscribe } = require('../subscribers');
const { targetUrl } = require('../push');
const { rateLimiter } = require('../util');

// `send` ignora rutas con segmentos .dot (p. ej. .netlify/functions-serve/... en netlify dev)
const SEND = { dotfiles: 'allow' };

module.exports = function publicRoutes(ctx) {
  const { db, cfg, vapid, sender, logger } = ctx;
  const r = express.Router();
  const json = express.json({ limit: '20kb' });
  const subLimit = rateLimiter({ windowMs: 60e3, max: 20 });
  const trackLimit = rateLimiter({ windowMs: 60e3, max: 120 });

  r.get('/', (req, res) => res.redirect(302, '/s'));
  r.get(['/s', '/s/'], (req, res) => res.sendFile(path.join(cfg.root, 'public/s.html'), SEND));
  r.get('/privacidad', (req, res) => res.sendFile(path.join(cfg.root, 'public/privacidad.html'), SEND));
  r.get('/baja', (req, res) => res.sendFile(path.join(cfg.root, 'public/baja.html'), SEND));

  r.get('/sw.js', (req, res) => {
    res.set('Service-Worker-Allowed', '/');
    res.set('Cache-Control', 'no-cache');
    res.type('application/javascript').sendFile(path.join(cfg.root, 'public/sw.js'), SEND);
  });

  r.get('/manifest.webmanifest', async (req, res) => {
    const name = await getSetting(db, 'site_name', 'Avisos');
    res.type('application/manifest+json').json({
      name: `${name} - Avisos`, short_name: name, start_url: '/s?pwa=1', scope: '/', display: 'standalone',
      background_color: '#FFFFFF', theme_color: '#0074E8', lang: 'es-AR',
      icons: [
        { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    });
  });

  // Configuración pública para la landing (nunca incluye la clave privada)
  r.get('/api/public-config', async (req, res) => {
    const st = await getSettings(db, ['site_name', 'logo_url', 'optin_title', 'optin_text', 'optin_button', 'consent_text', 'success_text', 'privacy_contact']);
    res.set('Cache-Control', 'no-store');
    res.json({
      vapidPublicKey: vapid.publicKey,
      siteName: st.site_name, logoUrl: st.logo_url,
      optinTitle: st.optin_title, optinText: st.optin_text, optinButton: st.optin_button,
      consentText: st.consent_text, successText: st.success_text, privacyContact: st.privacy_contact,
    });
  });

  r.post('/api/subscribe', subLimit, json, async (req, res) => {
    const { subscription, meta, oldEndpoint } = req.body || {};
    const m = meta && typeof meta === 'object' ? meta : {};
    // Renovación desde el service worker: mover la fila vieja al endpoint nuevo (conserva etiquetas)
    if (oldEndpoint && subscription && subscription.endpoint && oldEndpoint !== subscription.endpoint) {
      const exists = await db.get('SELECT id FROM subscribers WHERE endpoint = ?', String(subscription.endpoint));
      if (!exists) await db.run('UPDATE subscribers SET endpoint = ? WHERE endpoint = ?', String(subscription.endpoint).slice(0, 1000), String(oldEndpoint));
    }
    const result = await upsertSubscription(db, cfg, { subscription, meta: m, userAgent: req.get('user-agent') });
    res.status(result.created ? 201 : 200).json({ ok: true, created: result.created, manageToken: result.manageToken, phoneValid: result.phoneValid });
    if (result.created || result.reactivated) {
      const welcome = await db.get("SELECT * FROM automations WHERE type = 'welcome' AND enabled = 1 AND campaign_id IS NOT NULL");
      if (welcome) { try { await sender.sendAutomation(welcome, result.id); } catch (e) { logger.error('[welcome]', e.message); } }
    }
  });

  r.post('/api/unsubscribe', subLimit, json, async (req, res) => {
    const { endpoint, token } = req.body || {};
    if (!endpoint && !token) return res.status(400).json({ error: 'Falta endpoint o token' });
    await unsubscribe(db, { endpoint, token });
    res.json({ ok: true });
  });

  // Estado de la suscripción de este navegador (para la landing)
  r.post('/api/status', subLimit, json, async (req, res) => {
    const endpoint = req.body && req.body.endpoint;
    if (!endpoint) return res.json({ subscribed: false });
    const row = await db.get('SELECT status FROM subscribers WHERE endpoint = ?', String(endpoint));
    res.json({ subscribed: !!row && row.status === 'active' });
  });

  // Tracking de entrega / cierre (beacon desde el service worker)
  const track = (col) => async (req, res) => {
    const token = String(req.params.token || '').slice(0, 64);
    await db.run(`UPDATE sends SET ${col} = COALESCE(${col}, ?) WHERE token = ?`, nowIso(), token);
    res.status(204).end();
  };
  r.post('/t/d/:token', trackLimit, track('delivered_at'));
  r.post('/t/c/:token', trackLimit, track('closed_at'));

  // Clic: registra y redirige al destino con UTM
  r.get('/r/:token', trackLimit, async (req, res) => {
    const token = String(req.params.token || '').slice(0, 64);
    const send = await db.get('SELECT * FROM sends WHERE token = ?', token);
    if (!send) return res.redirect(302, await getSetting(db, 'default_url', '/s'));
    const action = Math.max(0, Math.min(2, Number(req.query.a) || 0));
    const now = nowIso();
    await db.run('UPDATE sends SET clicked_at = COALESCE(clicked_at, ?), click_action = COALESCE(click_action, ?), delivered_at = COALESCE(delivered_at, ?) WHERE id = ?', now, String(action), now, send.id);
    const campaign = await db.get('SELECT * FROM campaigns WHERE id = ?', send.campaign_id);
    const piece = campaign && await db.get('SELECT * FROM pieces WHERE id = ?', campaign.piece_id);
    const sub = (await db.get('SELECT * FROM subscribers WHERE id = ?', send.subscriber_id)) || {};
    if (!piece) return res.redirect(302, await getSetting(db, 'default_url', '/s'));
    res.set('Cache-Control', 'no-store');
    res.redirect(302, targetUrl({ piece, campaign, sub, action, baseUrl: cfg.baseUrl }));
  });

  // Imágenes subidas (guardadas en la base)
  r.get('/media/:file', async (req, res) => {
    const token = String(req.params.file || '').replace(/\.[a-z0-9]+$/i, '').slice(0, 64);
    const m = await db.get('SELECT mime, data FROM media WHERE token = ?', token);
    if (!m) return res.status(404).type('text/plain').send('No encontrado');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(m.mime).send(Buffer.from(m.data));
  });

  return r;
};
