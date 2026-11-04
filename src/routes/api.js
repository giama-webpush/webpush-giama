'use strict';
// API de integración (Pilot Solution, webhooks, cron externo). Autenticación: ADMIN_KEY
// en header "Authorization: Bearer <ADMIN_KEY>" o "X-API-Key: <ADMIN_KEY>".
const express = require('express');
const { nowIso, audit } = require('../db');
const { requireApiKey } = require('../auth');
const { normalizeFilters, countSegment, describeFilters } = require('../segments');
const { setTagsBulk } = require('../subscribers');
const { normalizeArPhone, hashPhone } = require('../phone');
const { parseJson } = require('../push');
const { clean, isHttpUrl, rateLimiter, safeEqual } = require('../util');

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

module.exports = function apiRoutes(ctx) {
  const { db, cfg, sender } = ctx;
  const r = express.Router();
  const json = express.json({ limit: '100kb' });
  const limit = rateLimiter({ windowMs: 60e3, max: 120 });
  const key = requireApiKey(cfg);

  // Cron externo: procesa programadas vencidas, reintentos y automatizaciones.
  // Acepta la clave también como ?key= para servicios de ping que no permiten headers.
  const cronAuth = (req, res, next) => {
    if (req.query.key && cfg.apiKey && safeEqual(String(req.query.key), cfg.apiKey)) return next();
    return key(req, res, next);
  };
  const cron = async (req, res) => {
    const out = await sender.tick();
    res.json({ ok: true, at: nowIso(), ...out });
  };
  r.get('/cron/tick', limit, cronAuth, cron);
  r.post('/cron/tick', limit, cronAuth, cron);

  // Resolver a quién aplica: subscriber_ids, phone (se compara por hash), manage_token o filters
  async function resolveTargets(b) {
    if (Array.isArray(b.subscriber_ids) && b.subscriber_ids.length) return { filters: { ids: b.subscriber_ids, status: 'all' } };
    if (b.phone) {
      const p = normalizeArPhone(b.phone);
      if (!p || !p.valid) throw bad('Teléfono inválido');
      const rows = await db.all('SELECT id FROM subscribers WHERE phone_hash = ?', hashPhone(p.e164, cfg.phoneHashSecret));
      return { filters: { ids: rows.map((x) => x.id), status: 'all' }, empty: !rows.length };
    }
    if (b.manage_token) {
      const row = await db.get('SELECT id FROM subscribers WHERE manage_token = ?', String(b.manage_token));
      return { filters: { ids: row ? [row.id] : [], status: 'all' }, empty: !row };
    }
    if (b.filters && typeof b.filters === 'object') return { filters: b.filters };
    throw bad('Indicá subscriber_ids, phone, manage_token o filters');
  }

  // POST /api/subscribers/tag  { phone | subscriber_ids | manage_token | filters, add: [], remove: [] }
  r.post('/subscribers/tag', limit, key, json, async (req, res) => {
    const b = req.body || {};
    const add = Array.isArray(b.add) ? b.add.slice(0, 20) : [];
    const remove = Array.isArray(b.remove) ? b.remove.slice(0, 20) : [];
    if (!add.length && !remove.length) throw bad('Indicá add y/o remove');
    const t = await resolveTargets(b);
    if (t.empty) return res.json({ ok: true, matched: 0 });
    const { buildWhere } = require('../segments');
    const w = buildWhere(t.filters, { defaultStatus: 'all' });
    const ids = (await db.all(`SELECT s.id FROM subscribers s ${w.sql}`, ...w.params)).map((x) => x.id);
    await setTagsBulk(db, ids, add, remove);
    audit(db, 'api', 'api_tag', { n: ids.length, add, remove });
    res.json({ ok: true, matched: ids.length });
  });

  // POST /api/campaigns/send
  // { name, piece_id | piece:{title, body, url, image?, icon?, actions?}, segment_id | filters | phone | subscriber_ids,
  //   scheduled_at? (ISO con zona), ttl?, urgency?, freq_cap_hours?, dry_run? }
  r.post('/campaigns/send', limit, key, json, async (req, res) => {
    const b = req.body || {};
    let pieceId = Number(b.piece_id) || null;
    if (pieceId && !(await db.get('SELECT id FROM pieces WHERE id = ?', pieceId))) throw bad('piece_id inexistente', 404);
    if (!pieceId) {
      const p = b.piece || {};
      const title = clean(p.title, 120); const url = String(p.url || '').trim();
      if (!title || !isHttpUrl(url, { allowRelative: true })) throw bad('Falta piece_id o piece {title, url}');
      const actions = (Array.isArray(p.actions) ? p.actions : []).slice(0, 2).filter((a) => a && a.title && isHttpUrl(a.url, { allowRelative: true })).map((a) => ({ title: clean(a.title, 40), url: a.url }));
      const x = await db.run('INSERT INTO pieces(name, title, body, image, icon, url, actions) VALUES(?,?,?,?,?,?,?)', `API: ${title}`.slice(0, 80), title, clean(p.body, 400) || '', isHttpUrl(p.image, { allowRelative: true }) ? p.image : null, isHttpUrl(p.icon, { allowRelative: true }) ? p.icon : null, url, JSON.stringify(actions));
      pieceId = x.lastInsertRowid;
    }
    let filters;
    if (b.segment_id) {
      const seg = await db.get('SELECT filters FROM segments WHERE id = ?', Number(b.segment_id));
      if (!seg) throw bad('segment_id inexistente', 404);
      filters = parseJson(seg.filters, {});
    } else {
      const t = await resolveTargets(b);
      filters = t.filters;
      if (filters.ids) filters = { ...filters, status: 'active' };
    }
    filters = normalizeFilters(filters);
    const count = await countSegment(db, filters);
    if (b.dry_run) return res.json({ ok: true, dry_run: true, count, description: describeFilters(filters) });
    let scheduledAt = null;
    if (b.scheduled_at) {
      const d = new Date(b.scheduled_at);
      if (Number.isNaN(d.getTime())) throw bad('scheduled_at inválido (usá ISO 8601 con zona, ej. 2026-11-10T10:00:00-03:00)');
      scheduledAt = d.toISOString();
    }
    const ttl = Math.max(60, Math.min(2419200, Number(b.ttl) || 86400));
    const urgency = ['very-low', 'low', 'normal', 'high'].includes(b.urgency) ? b.urgency : 'normal';
    const x = await db.run("INSERT INTO campaigns(name, kind, piece_id, segment_id, filters, status, scheduled_at, ttl, urgency, freq_cap_hours) VALUES(?, 'api', ?, ?, ?, 'programada', ?, ?, ?, ?)",
      clean(b.name, 100) || `API ${nowIso().slice(0, 16)}`, pieceId, b.segment_id ? Number(b.segment_id) : null, JSON.stringify(filters), scheduledAt, ttl, urgency, Math.max(0, Number(b.freq_cap_hours) || 0));
    const id = x.lastInsertRowid;
    audit(db, 'api', 'api_campana', { id, count });
    if (!scheduledAt) setImmediate(() => sender.processCampaign(id));
    res.status(202).json({ ok: true, campaign_id: id, estimated: count, scheduled_at: scheduledAt });
  });

  // GET /api/campaigns/:id  estado y métricas
  r.get('/campaigns/:id', limit, key, async (req, res) => {
    const c = await db.get('SELECT id, name, kind, status, scheduled_at, started_at, finished_at, total_targeted, skipped_freq FROM campaigns WHERE id = ?', Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'No existe' });
    const st = await db.get("SELECT SUM(status='queued') AS queued, SUM(status='sent') AS sent, SUM(status='failed') AS failed, SUM(status='dead') AS dead, SUM(delivered_at IS NOT NULL) AS delivered, SUM(clicked_at IS NOT NULL) AS clicked FROM sends WHERE campaign_id = ? AND is_test = 0", c.id);
    res.json({ ...c, stats: st });
  });

  return r;
};
