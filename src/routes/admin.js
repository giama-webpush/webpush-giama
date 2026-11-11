'use strict';
const express = require('express');
const { getSetting, getSettings, setSetting, nowIso, audit } = require('../db');
const { login, requireAdmin, requireRole, cookieHeader, sessionFrom, sameOrigin, COOKIE, parseCookies } = require('../auth');
const { buildWhere, countSegment, normalizeFilters, describeFilters, LIST_FIELDS } = require('../segments');
const { setTags, setTagsBulk, subscriberTags } = require('../subscribers');
const { parseJson, renderVars } = require('../push');
const { decryptPhone } = require('../phone');
const { rateLimiter, randomToken, sha256, hashPassword, verifyPassword, clean, isHttpUrl, zonedLocalToUtc, zonedParts, csvEscape } = require('../util');

const IMAGE_TYPES = {
  'image/png': { ext: 'png', magic: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: 'webp', magic: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
  'image/gif': { ext: 'gif', magic: (b) => b.slice(0, 3).toString() === 'GIF' },
};

function imageSize(buf, type) {
  try {
    if (type === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (type === 'image/gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (type === 'image/jpeg') {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    if (type === 'image/webp') {
      const fmt = buf.slice(12, 16).toString();
      if (fmt === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') { const b = buf.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
    }
  } catch { /* tamaño desconocido */ }
  return null;
}

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

function pieceFromBody(b) {
  const name = clean(b.name, 80); const title = clean(b.title, 120); const body = clean(b.body, 400) || '';
  const url = String(b.url || '').trim();
  if (!name) throw bad('Poné un nombre a la pieza');
  if (!title) throw bad('Falta el título');
  if (!isHttpUrl(url.replace(/\{\{[^}]*\}\}/g, 'x'), { allowRelative: true })) throw bad('La URL de destino tiene que empezar con https:// o /');
  for (const k of ['image', 'icon']) if (b[k] && !isHttpUrl(b[k], { allowRelative: true })) throw bad(`URL de ${k === 'image' ? 'imagen' : 'ícono'} inválida`);
  const actions = (Array.isArray(b.actions) ? b.actions : []).filter((a) => a && clean(a.title, 40)).slice(0, 2).map((a) => {
    const u = String(a.url || '').trim();
    if (!isHttpUrl(u.replace(/\{\{[^}]*\}\}/g, 'x'), { allowRelative: true })) throw bad(`URL del botón "${a.title}" inválida`);
    return { title: clean(a.title, 40), url: u };
  });
  return { name, title, body, url, image: b.image || null, icon: b.icon || null, actions: JSON.stringify(actions), utm_auto: b.utm_auto === false ? 0 : 1, require_interaction: b.require_interaction ? 1 : 0 };
}

module.exports = function adminRoutes(ctx) {
  const { db, cfg, vapid, sender } = ctx;
  const r = express.Router();
  r.use(express.json({ limit: '2mb' }));
  const loginLimit = rateLimiter({ windowMs: 15 * 60e3, max: 10 });
  const auth = requireAdmin(db, cfg);
  const onlyAdmin = requireRole('admin');

  // ---------- Sesión ----------
  r.post('/login', loginLimit, async (req, res) => {
    const origin = req.get('origin');
    if (origin && !sameOrigin(origin, req, cfg)) return res.status(403).json({ error: 'Origen no permitido' });
    const noAdmins = (await db.get('SELECT COUNT(*) AS n FROM admins')).n === 0;
    if (noAdmins) return res.status(503).json({ error: 'Panel bloqueado: falta configurar ADMIN_PASSWORD en el servidor' });
    const { username, password } = req.body || {};
    const s = await login(db, cfg, username, password);
    if (!s) { audit(db, clean(username, 40), 'login_fallido', { ip: req.ip }); return res.status(401).json({ error: 'Usuario o contraseña incorrectos' }); }
    audit(db, s.admin.username, 'login', { ip: req.ip });
    res.set('Set-Cookie', cookieHeader(cfg, s.token, cfg.sessionHours * 3600));
    res.json({ ok: true, csrf: s.csrf, user: { username: s.admin.username, role: s.admin.role } });
  });
  r.post('/logout', async (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) (await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token)));
    res.set('Set-Cookie', cookieHeader(cfg, '', 0));
    res.json({ ok: true });
  });
  r.get('/me', async (req, res) => {
    const s = await sessionFrom(db, req);
    if (!s) return res.status(401).json({ error: 'Sin sesión', locked: (await db.get('SELECT COUNT(*) AS n FROM admins')).n === 0 });
    res.json({ user: { username: s.username, role: s.role }, csrf: s.csrf, siteName: await getSetting(db, 'site_name'), logoUrl: await getSetting(db, 'logo_url'), timezone: cfg.timezone });
  });

  r.use(auth);

  // ---------- Dashboard ----------
  r.get('/dashboard', async (req, res) => {
    const days = Math.max(7, Math.min(180, Number(req.query.days) || 30));
    const q = (sql, ...p) => db.all(sql, ...p);
    const one = (sql, ...p) => db.get(sql, ...p);
    const totals = await one(`SELECT COUNT(*) AS total, SUM(status='active') AS active, SUM(status='unsubscribed') AS unsubscribed, SUM(status='dead') AS dead FROM subscribers`);
    const group = (col) => q(`SELECT COALESCE(NULLIF(${col}, ''), '(vacío)') AS k, COUNT(*) AS n FROM subscribers WHERE status='active' GROUP BY k ORDER BY n DESC LIMIT 12`);
    const since = new Date(Date.now() - days * 86400e3);
    const sinceLocal = zonedParts(since, cfg.timezone).date;
    const signups = await q('SELECT sub_local_date AS d, COUNT(*) AS n FROM subscribers WHERE sub_local_date >= ? GROUP BY d ORDER BY d', sinceLocal);
    const unsubsRaw = await q("SELECT unsubscribed_at FROM subscribers WHERE status='unsubscribed' AND unsubscribed_at >= ?", since.toISOString());
    const unsubMap = {};
    for (const u of unsubsRaw) { const d = zonedParts(new Date(u.unsubscribed_at), cfg.timezone).date; unsubMap[d] = (unsubMap[d] || 0) + 1; }
    const sendsAgg = await one(`SELECT COUNT(*) AS attempted, SUM(status='sent') AS sent, SUM(status='failed') AS failed, SUM(status='dead') AS dead,
        SUM(delivered_at IS NOT NULL) AS delivered, SUM(clicked_at IS NOT NULL) AS clicked FROM sends WHERE is_test = 0`);
    const sendsDaily = await q('SELECT sent_at FROM sends WHERE is_test = 0 AND sent_at >= ?', since.toISOString());
    const clicksDaily = await q('SELECT clicked_at FROM sends WHERE is_test = 0 AND clicked_at >= ?', since.toISOString());
    const byDay = (rows, col) => { const m = {}; for (const x of rows) { const d = zonedParts(new Date(x[col]), cfg.timezone).date; m[d] = (m[d] || 0) + 1; } return m; };
    const series = [];
    const sm = Object.fromEntries(signups.map((x) => [x.d, x.n]));
    const sendM = byDay(sendsDaily, 'sent_at'); const clickM = byDay(clicksDaily, 'clicked_at');
    for (let i = days - 1; i >= 0; i--) {
      const d = zonedParts(new Date(Date.now() - i * 86400e3), cfg.timezone).date;
      series.push({ d, altas: sm[d] || 0, bajas: unsubMap[d] || 0, envios: sendM[d] || 0, clics: clickM[d] || 0 });
    }
    const recent = await q("SELECT c.id, c.name, c.status, c.started_at, c.finished_at, c.total_targeted, (SELECT COUNT(*) FROM sends s WHERE s.campaign_id=c.id AND s.is_test=0 AND s.status='sent') AS sent, (SELECT COUNT(*) FROM sends s WHERE s.campaign_id=c.id AND s.is_test=0 AND s.clicked_at IS NOT NULL) AS clicked FROM campaigns c WHERE c.kind IN ('manual','api') ORDER BY c.id DESC LIMIT 5");
    res.json({
      days, totals: { total: totals.total || 0, active: totals.active || 0, unsubscribed: totals.unsubscribed || 0, dead: totals.dead || 0 },
      sends: { attempted: sendsAgg.attempted || 0, sent: sendsAgg.sent || 0, failed: sendsAgg.failed || 0, dead: sendsAgg.dead || 0, delivered: sendsAgg.delivered || 0, clicked: sendsAgg.clicked || 0, ctr: sendsAgg.sent ? (sendsAgg.clicked || 0) / sendsAgg.sent : null },
      by: Object.fromEntries(await Promise.all(Object.entries({ marca: 'marca', modelo: 'modelo', zona: 'phone_zone', area: 'phone_area', device: 'device_type', os: 'os', browser: 'browser', origen: 'origen', asesor: 'asesor' }).map(async ([k, c]) => [k, await group(c)]))),
      series, recent,
    });
  });

  // ---------- Público ----------
  r.get('/facets', async (req, res) => {
    const out = {};
    for (const [k, col] of Object.entries(LIST_FIELDS)) {
      out[k] = (await db.all(`SELECT ${col.replace('s.', '')} AS v, COUNT(*) AS n FROM subscribers WHERE ${col.replace('s.', '')} IS NOT NULL AND ${col.replace('s.', '')} <> '' GROUP BY v ORDER BY n DESC LIMIT 200`));
    }
    out.tags = (await db.all('SELECT tag AS v, COUNT(*) AS n FROM subscriber_tags GROUP BY tag ORDER BY n DESC LIMIT 300'));
    res.json(out);
  });

  function filtersFromQuery(qs) {
    const f = {};
    for (const [k, v] of Object.entries(qs)) if (!['page', 'limit', 'sort'].includes(k)) f[k] = v;
    return f;
  }

  const SUB_COLS = 's.id, s.status, s.created_at, s.updated_at, s.unsubscribed_at, s.last_push_at, s.device_type, s.os, s.browser, s.lang, s.timezone, s.marca, s.modelo, s.origen, s.campana, s.asesor, s.utm_source, s.utm_medium, s.utm_campaign, s.phone_area, s.phone_zone, s.phone_region, (s.phone_hash IS NOT NULL) AS has_phone, s.sub_local_date, s.sub_hour, s.sub_daypart';

  r.get('/subscribers', async (req, res) => {
    const filters = req.query.filters ? parseJson(req.query.filters, {}) : filtersFromQuery(req.query);
    const w = buildWhere(filters);
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const page = Math.max(1, Number(req.query.page) || 1);
    const total = (await db.get(`SELECT COUNT(*) AS n FROM subscribers s ${w.sql}`, ...w.params)).n;
    const rows = (await db.all(`SELECT ${SUB_COLS}, (SELECT group_concat(tag, '|') FROM subscriber_tags t WHERE t.subscriber_id = s.id) AS tags FROM subscribers s ${w.sql} ORDER BY s.id DESC LIMIT ? OFFSET ?`, ...w.params, limit, (page - 1) * limit));
    res.json({ total, page, limit, rows: rows.map((x) => ({ ...x, has_phone: !!x.has_phone, tags: x.tags ? x.tags.split('|') : [] })), description: describeFilters(filters) });
  });

  r.get('/subscribers/:id', async (req, res) => {
    const s = (await db.get(`SELECT ${SUB_COLS}, s.utm_content, s.utm_term, s.landing_path, s.phone_enc FROM subscribers s WHERE s.id = ?`, Number(req.params.id)));
    if (!s) return res.status(404).json({ error: 'No existe' });
    const phone = req.admin.role === 'admin' && cfg.phoneEncKey ? decryptPhone(s.phone_enc, cfg.phoneEncKey) : null;
    delete s.phone_enc;
    const sends = (await db.all('SELECT x.id, x.campaign_id, c.name AS campaign, x.is_test, x.status, x.http_status, x.error, x.sent_at, x.delivered_at, x.clicked_at FROM sends x JOIN campaigns c ON c.id = x.campaign_id WHERE x.subscriber_id = ? ORDER BY x.id DESC LIMIT 50', s.id));
    res.json({ ...s, has_phone: !!s.has_phone, phone, tags: await subscriberTags(db, s.id), sends });
  });

  // Edición masiva de etiquetas: por filtros o por ids
  r.post('/subscribers/tags', async (req, res) => {
    const { filters, ids, add = [], remove = [] } = req.body || {};
    if (!add.length && !remove.length) throw bad('Indicá etiquetas para agregar o quitar');
    const f = ids && ids.length ? { ids, status: 'all' } : (filters || {});
    const w = buildWhere(f);
    const targets = (await db.all(`SELECT s.id FROM subscribers s ${w.sql}`, ...w.params));
    await setTagsBulk(db, targets.map((t) => t.id), add, remove);
    audit(db, req.admin.username, 'tags_masivo', { n: targets.length, add, remove });
    res.json({ ok: true, affected: targets.length });
  });

  r.post('/subscribers/:id/unsubscribe', async (req, res) => {
    (await db.run("UPDATE subscribers SET status='unsubscribed', unsubscribed_at=?, updated_at=? WHERE id = ? AND status='active'", nowIso(), nowIso(), Number(req.params.id)));
    audit(db, req.admin.username, 'baja_manual', { id: Number(req.params.id) });
    res.json({ ok: true });
  });

  // Borrado definitivo (derecho de supresión)
  r.delete('/subscribers/:id', onlyAdmin, async (req, res) => {
    const id = Number(req.params.id);
    // Borrado en cascada explícito (no depende de PRAGMA foreign_keys, que Turso remoto no garantiza)
    await db.batch([['DELETE FROM subscriber_tags WHERE subscriber_id = ?', [id]], ['DELETE FROM sends WHERE subscriber_id = ?', [id]], ['DELETE FROM subscribers WHERE id = ?', [id]]]);
    const r2 = { changes: (await db.get('SELECT COUNT(*) AS n FROM subscribers WHERE id = ?', id)).n === 0 ? 1 : 0 };
    audit(db, req.admin.username, 'borrado_suscriptor', { id: Number(req.params.id) });
    res.json({ ok: true, deleted: r2.changes });
  });

  r.post('/segments/count', async (req, res) => {
    const filters = (req.body && req.body.filters) || {};
    res.json({ count: await countSegment(db, filters), description: describeFilters(filters) });
  });

  r.get('/export.csv', async (req, res) => {
    const filters = req.query.filters ? parseJson(req.query.filters, {}) : filtersFromQuery(req.query);
    const w = buildWhere(filters);
    const rows = (await db.all(`SELECT ${SUB_COLS}, (SELECT group_concat(tag, '|') FROM subscriber_tags t WHERE t.subscriber_id = s.id) AS tags FROM subscribers s ${w.sql} ORDER BY s.id`, ...w.params));
    const cols = ['id', 'status', 'created_at', 'sub_local_date', 'sub_hour', 'sub_daypart', 'marca', 'modelo', 'phone_zone', 'phone_area', 'phone_region', 'has_phone', 'device_type', 'os', 'browser', 'lang', 'timezone', 'origen', 'campana', 'asesor', 'utm_source', 'utm_medium', 'utm_campaign', 'last_push_at', 'unsubscribed_at', 'tags'];
    const lines = [cols.join(',')].concat(rows.map((x) => cols.map((c) => csvEscape(c === 'has_phone' ? (x[c] ? 'si' : 'no') : x[c])).join(',')));
    audit(db, req.admin.username, 'export_csv', { n: rows.length });
    res.set('Content-Disposition', `attachment; filename="suscriptores-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.type('text/csv; charset=utf-8').send('\ufeff' + lines.join('\r\n'));
  });

  // Export / import JSON completo de suscripciones (para migrar de hosting). Contiene endpoints y claves de suscripción: tratar como dato sensible.
  r.get('/export.json', onlyAdmin, async (req, res) => {
    const subs = (await db.all('SELECT * FROM subscribers ORDER BY id'));
    const tags = (await db.all('SELECT subscriber_id, tag FROM subscriber_tags'));
    const tagMap = {};
    for (const t of tags) (tagMap[t.subscriber_id] = tagMap[t.subscriber_id] || []).push(t.tag);
    audit(db, req.admin.username, 'export_json', { n: subs.length });
    res.set('Content-Disposition', `attachment; filename="webpush-suscriptores-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ format: 'webpush-giama-subscribers', version: 1, exported_at: nowIso(), vapid_public_key: vapid.publicKey,
      note: 'Las suscripciones solo funcionan con el MISMO par de claves VAPID. Migrá también VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.',
      subscribers: subs.map((s) => ({ ...s, tags: tagMap[s.id] || [] })) });
  });

  r.post('/import.json', onlyAdmin, express.json({ limit: '50mb' }), async (req, res) => {
    const data = req.body || {};
    if (data.format !== 'webpush-giama-subscribers' || !Array.isArray(data.subscribers)) throw bad('Archivo inválido: se espera un export JSON de esta app');
    const cols = ['endpoint', 'p256dh', 'auth', 'status', 'manage_token', 'created_at', 'updated_at', 'unsubscribed_at', 'last_push_at', 'device_type', 'os', 'browser', 'lang', 'timezone', 'marca', 'modelo', 'origen', 'campana', 'asesor', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'phone_area', 'phone_zone', 'phone_region', 'phone_hash', 'phone_enc', 'sub_local_date', 'sub_hour', 'sub_weekday', 'sub_daypart', 'landing_path'];
    let inserted = 0; let updated = 0; let skipped = 0;
    await db.tx(async (t) => {
      for (const s of data.subscribers) {
        if (!s || !s.endpoint || !s.p256dh || !s.auth || !String(s.endpoint).startsWith('https://')) { skipped++; continue; }
        const row = { ...s, manage_token: s.manage_token || randomToken(18), created_at: s.created_at || nowIso(), updated_at: nowIso(), status: ['active', 'unsubscribed', 'dead'].includes(s.status) ? s.status : 'active' };
        const ex = await t.get('SELECT id FROM subscribers WHERE endpoint = ?', row.endpoint);
        let id;
        if (ex) {
          const upd = cols.filter((c) => c !== 'endpoint' && c !== 'manage_token');
          await t.run(`UPDATE subscribers SET ${upd.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...upd.map((c) => row[c] ?? null), ex.id);
          id = ex.id; updated++;
        } else {
          const r2 = await t.run(`INSERT INTO subscribers(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...cols.map((c) => row[c] ?? null));
          id = Number(r2.lastInsertRowid); inserted++;
        }
        if (Array.isArray(s.tags)) await setTags(t, id, s.tags);
      }
    });
    audit(db, req.admin.username, 'import_json', { inserted, updated, skipped });
    const warn = data.vapid_public_key && data.vapid_public_key !== vapid.publicKey ? 'Atención: el archivo fue exportado con otra clave VAPID pública. Configurá las mismas claves VAPID o los envíos a estos suscriptores fallarán.' : null;
    res.json({ ok: true, inserted, updated, skipped, warning: warn });
  });

  // ---------- Segmentos ----------
  r.get('/segments', async (req, res) => {
    const rows = (await db.all('SELECT * FROM segments ORDER BY name'));
    res.json(await Promise.all(rows.map(async (s) => { const f = parseJson(s.filters, {}); return { ...s, filters: f, count: await countSegment(db, f), description: describeFilters(f) }; })));
  });
  r.post('/segments', async (req, res) => {
    const name = clean(req.body && req.body.name, 80);
    if (!name) throw bad('Poné un nombre al segmento');
    const f = normalizeFilters((req.body && req.body.filters) || {});
    const x = (await db.run('INSERT INTO segments(name, filters) VALUES(?, ?)', name, JSON.stringify(f)));
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });
  r.put('/segments/:id', async (req, res) => {
    const name = clean(req.body && req.body.name, 80);
    const f = normalizeFilters((req.body && req.body.filters) || {});
    (await db.run('UPDATE segments SET name = COALESCE(?, name), filters = ?, updated_at = ? WHERE id = ?', name, JSON.stringify(f), nowIso(), Number(req.params.id)));
    res.json({ ok: true });
  });
  r.delete('/segments/:id', async (req, res) => {
    (await db.run('DELETE FROM segments WHERE id = ?', Number(req.params.id)));
    res.json({ ok: true });
  });

  // ---------- Piezas ----------
  r.get('/pieces', async (req, res) => {
    const rows = (await db.all(`SELECT p.*, (SELECT COUNT(*) FROM campaigns c WHERE c.piece_id = p.id AND c.kind <> 'test') AS used FROM pieces p WHERE archived = ? ORDER BY p.id DESC`, req.query.archived === '1' ? 1 : 0));
    res.json(rows.map((p) => ({ ...p, actions: parseJson(p.actions, []) })));
  });
  r.get('/pieces/:id', async (req, res) => {
    const p = (await db.get('SELECT * FROM pieces WHERE id = ?', Number(req.params.id)));
    if (!p) return res.status(404).json({ error: 'No existe' });
    res.json({ ...p, actions: parseJson(p.actions, []) });
  });
  r.post('/pieces', async (req, res) => {
    const p = pieceFromBody(req.body || {});
    const keys = Object.keys(p);
    const x = (await db.run(`INSERT INTO pieces(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map((k) => p[k])));
    audit(db, req.admin.username, 'pieza_creada', { id: Number(x.lastInsertRowid) });
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });
  r.put('/pieces/:id', async (req, res) => {
    const p = pieceFromBody(req.body || {});
    const keys = Object.keys(p);
    await db.run(`UPDATE pieces SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => p[k]), nowIso(), Number(req.params.id));
    res.json({ ok: true });
  });
  r.post('/pieces/:id/archive', async (req, res) => {
    (await db.run('UPDATE pieces SET archived = ? WHERE id = ?', req.body && req.body.archived === false ? 0 : 1, Number(req.params.id)));
    res.json({ ok: true });
  });
  r.post('/pieces/:id/duplicate', async (req, res) => {
    const p = (await db.get('SELECT * FROM pieces WHERE id = ?', Number(req.params.id)));
    if (!p) return res.status(404).json({ error: 'No existe' });
    const x = (await db.run('INSERT INTO pieces(name, title, body, image, icon, url, actions, utm_auto, require_interaction) VALUES(?,?,?,?,?,?,?,?,?)', `${p.name} (copia)`, p.title, p.body, p.image, p.icon, p.url, p.actions, p.utm_auto, p.require_interaction));
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });
  r.post('/pieces/:id/preview', async (req, res) => {
    const p = (await db.get('SELECT * FROM pieces WHERE id = ?', Number(req.params.id)));
    if (!p) return res.status(404).json({ error: 'No existe' });
    const sample = (req.body && req.body.sample) || { marca: 'PEUGEOT', modelo: '208' };
    res.json({ title: renderVars(p.title, sample), body: renderVars(p.body, sample) });
  });
  r.post('/pieces/:id/test', async (req, res, next) => {
    try {
      const subscriberId = Number(req.body && req.body.subscriberId);
      if (!subscriberId) throw bad('Elegí el suscriptor (tu dispositivo) para la prueba');
      const out = await sender.sendTest({ pieceId: Number(req.params.id), subscriberId });
      audit(db, req.admin.username, 'prueba_pieza', { piece: Number(req.params.id), subscriberId, result: out.result });
      res.json(out);
    } catch (e) { next(e); }
  });

  // Subida de imágenes: cuerpo binario con Content-Type image/*. Se guardan EN LA BASE (tabla media)
  // para no depender del disco del hosting (Render free no persiste disco). Se sirven en /media/<token>.<ext>
  r.post('/uploads', express.raw({ type: Object.keys(IMAGE_TYPES), limit: cfg.maxUploadBytes }), async (req, res) => {
    const type = (req.get('content-type') || '').split(';')[0].trim();
    const info = IMAGE_TYPES[type];
    if (!info) throw bad('Formato no permitido: usá PNG, JPG, WEBP o GIF');
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 16) throw bad('Archivo vacío');
    if (!info.magic(buf)) throw bad('El archivo no coincide con su formato');
    const token = randomToken(12);
    const size = imageSize(buf, type) || {};
    const name = clean(req.get('x-file-name'), 120);
    await db.run('INSERT INTO media(token, name, mime, bytes, width, height, data) VALUES(?,?,?,?,?,?,?)', token, name, type, buf.length, size.width || null, size.height || null, buf);
    audit(db, req.admin.username, 'upload', { token, bytes: buf.length });
    const url = `/media/${token}.${info.ext}`;
    res.status(201).json({ url, absoluteUrl: `${cfg.baseUrl}${url}`, bytes: buf.length, ...size });
  });
  r.get('/uploads', async (req, res) => {
    const rows = await db.all('SELECT token, name, mime, bytes, width, height, created_at FROM media ORDER BY id DESC LIMIT 200');
    res.json(rows.map((m) => ({ ...m, url: `/media/${m.token}.${(IMAGE_TYPES[m.mime] || { ext: 'img' }).ext}` })));
  });
  r.delete('/uploads/:token', async (req, res) => {
    await db.run('DELETE FROM media WHERE token = ?', String(req.params.token));
    res.json({ ok: true });
  });

  // ---------- Campañas ----------
  async function campaignStats(id) {
    return (await db.get(`SELECT COUNT(*) AS total, SUM(status='queued') AS queued, SUM(status='sent') AS sent, SUM(status='failed') AS failed, SUM(status='dead') AS dead, SUM(status='cancelled') AS cancelled,
      SUM(delivered_at IS NOT NULL) AS delivered, SUM(clicked_at IS NOT NULL) AS clicked, SUM(closed_at IS NOT NULL) AS closed FROM sends WHERE campaign_id = ? AND is_test = 0`, id));
  }

  async function campaignFromBody(b, existing) {
    const name = clean(b.name, 100) || (existing && existing.name);
    if (!name) throw bad('Poné un nombre a la campaña');
    const pieceId = Number(b.piece_id || (existing && existing.piece_id));
    if (!(await db.get('SELECT id FROM pieces WHERE id = ?', pieceId))) throw bad('Elegí una pieza');
    let segmentId = b.segment_id ? Number(b.segment_id) : null;
    let filters = b.filters || {};
    if (segmentId) {
      const seg = (await db.get('SELECT * FROM segments WHERE id = ?', segmentId));
      if (!seg) throw bad('Segmento inexistente');
      filters = parseJson(seg.filters, {});
    } else segmentId = null;
    const ttl = Math.max(60, Math.min(2419200, Number(b.ttl) || 86400));
    const urgency = ['very-low', 'low', 'normal', 'high'].includes(b.urgency) ? b.urgency : 'normal';
    const freq = Math.max(0, Math.min(720, Number(b.freq_cap_hours) || 0));
    let scheduledAt = null;
    if (b.mode === 'schedule') {
      const d = zonedLocalToUtc(b.scheduled_local, cfg.timezone);
      if (!d) throw bad('Fecha y hora de envío inválidas');
      if (d.getTime() < Date.now() - 60e3) throw bad('La fecha programada ya pasó');
      scheduledAt = d.toISOString();
    }
    const status = b.mode === 'now' ? 'programada' : b.mode === 'schedule' ? 'programada' : 'borrador';
    return { name, piece_id: pieceId, segment_id: segmentId, filters: JSON.stringify(normalizeFilters(filters)), ttl, urgency, freq_cap_hours: freq, scheduled_at: scheduledAt, status };
  }

  r.get('/campaigns', async (req, res) => {
    const rows = (await db.all("SELECT c.*, p.name AS piece_name, p.title AS piece_title, g.name AS segment_name FROM campaigns c JOIN pieces p ON p.id = c.piece_id LEFT JOIN segments g ON g.id = c.segment_id WHERE c.kind IN ('manual','api') ORDER BY c.id DESC LIMIT 200"));
    res.json(await Promise.all(rows.map(async (c) => ({ ...c, filters: parseJson(c.filters, {}), description: describeFilters(parseJson(c.filters, {})), stats: await campaignStats(c.id), estimated: ['borrador', 'programada'].includes(c.status) ? await countSegment(db, parseJson(c.filters, {})) : null }))));
  });

  r.get('/campaigns/:id', async (req, res) => {
    const c = (await db.get('SELECT c.*, p.name AS piece_name FROM campaigns c JOIN pieces p ON p.id = c.piece_id WHERE c.id = ?', Number(req.params.id)));
    if (!c) return res.status(404).json({ error: 'No existe' });
    const stats = await campaignStats(c.id);
    const errors = (await db.all("SELECT http_status, error, COUNT(*) AS n FROM sends WHERE campaign_id = ? AND status IN ('failed','dead') AND is_test = 0 GROUP BY http_status, error ORDER BY n DESC LIMIT 10", c.id));
    const bySeg = async (col) => (await db.all(`SELECT COALESCE(NULLIF(s.${col}, ''), '(vacío)') AS k, COUNT(*) AS sent, SUM(x.clicked_at IS NOT NULL) AS clicked FROM sends x JOIN subscribers s ON s.id = x.subscriber_id WHERE x.campaign_id = ? AND x.is_test = 0 AND x.status = 'sent' GROUP BY k ORDER BY sent DESC LIMIT 10`, c.id));
    const actions = (await db.all('SELECT click_action AS a, COUNT(*) AS n FROM sends WHERE campaign_id = ? AND is_test = 0 AND clicked_at IS NOT NULL GROUP BY click_action', c.id));
    const tests = (await db.all('SELECT id, subscriber_id, status, http_status, error, sent_at, delivered_at, clicked_at FROM sends WHERE campaign_id = ? AND is_test = 1 ORDER BY id DESC LIMIT 10', c.id));
    res.json({ ...c, filters: parseJson(c.filters, {}), description: describeFilters(parseJson(c.filters, {})), stats, errors, by: { modelo: await bySeg('modelo'), zona: await bySeg('phone_zone'), device_type: await bySeg('device_type') }, actions, tests });
  });

  r.post('/campaigns', async (req, res) => {
    const c = await campaignFromBody(req.body || {});
    const keys = Object.keys(c);
    const x = (await db.run(`INSERT INTO campaigns(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map((k) => c[k])));
    const id = Number(x.lastInsertRowid);
    audit(db, req.admin.username, 'campana_creada', { id, status: c.status });
    if (c.status === 'programada' && !c.scheduled_at) await sender.launch(id);
    res.status(201).json({ id, status: c.status });
  });

  r.put('/campaigns/:id', async (req, res) => {
    const ex = (await db.get('SELECT * FROM campaigns WHERE id = ?', Number(req.params.id)));
    if (!ex) return res.status(404).json({ error: 'No existe' });
    if (!['borrador', 'programada'].includes(ex.status)) throw bad('Solo se pueden editar campañas en borrador o programadas');
    const c = await campaignFromBody(req.body || {}, ex);
    const keys = Object.keys(c);
    await db.run(`UPDATE campaigns SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => c[k]), nowIso(), ex.id);
    if (c.status === 'programada' && !c.scheduled_at) await sender.launch(ex.id);
    res.json({ ok: true, status: c.status });
  });

  r.post('/campaigns/:id/cancel', async (req, res) => {
    const x = (await db.run("UPDATE campaigns SET status = 'cancelada', finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('borrador','programada','enviando')", nowIso(), nowIso(), Number(req.params.id)));
    (await db.run("UPDATE sends SET status = 'cancelled', error = 'campaña cancelada' WHERE campaign_id = ? AND status = 'queued'", Number(req.params.id)));
    audit(db, req.admin.username, 'campana_cancelada', { id: Number(req.params.id) });
    res.json({ ok: !!x.changes });
  });

  r.post('/campaigns/:id/duplicate', async (req, res) => {
    const c = (await db.get('SELECT * FROM campaigns WHERE id = ?', Number(req.params.id)));
    if (!c) return res.status(404).json({ error: 'No existe' });
    const x = (await db.run("INSERT INTO campaigns(name, kind, piece_id, segment_id, filters, status, ttl, urgency, freq_cap_hours) VALUES(?, 'manual', ?, ?, ?, 'borrador', ?, ?, ?)", `${c.name} (copia)`, c.piece_id, c.segment_id, c.filters, c.ttl, c.urgency, c.freq_cap_hours));
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });

  r.delete('/campaigns/:id', async (req, res) => {
    const c = (await db.get('SELECT status FROM campaigns WHERE id = ?', Number(req.params.id)));
    if (!c) return res.status(404).json({ error: 'No existe' });
    if (!['borrador', 'cancelada'].includes(c.status)) throw bad('Solo se borran borradores o canceladas sin envíos');
    if ((await db.get('SELECT COUNT(*) AS n FROM sends WHERE campaign_id = ? AND sent_at IS NOT NULL', Number(req.params.id))).n) throw bad('Tiene envíos registrados: no se borra para conservar el reporte');
    await db.batch([['DELETE FROM sends WHERE campaign_id = ?', [Number(req.params.id)]], ['DELETE FROM campaigns WHERE id = ?', [Number(req.params.id)]]]);
    res.json({ ok: true });
  });

  r.post('/campaigns/:id/test', async (req, res, next) => {
    try {
      const subscriberId = Number(req.body && req.body.subscriberId);
      if (!subscriberId) throw bad('Elegí el suscriptor (tu dispositivo) para la prueba');
      const out = await sender.sendTest({ campaignId: Number(req.params.id), subscriberId });
      audit(db, req.admin.username, 'prueba_campana', { id: Number(req.params.id), subscriberId, result: out.result });
      res.json(out);
    } catch (e) { next(e); }
  });

  r.get('/campaigns/:id/sends.csv', async (req, res) => {
    const rows = (await db.all('SELECT x.id, x.subscriber_id, x.status, x.http_status, x.error, x.attempts, x.sent_at, x.delivered_at, x.clicked_at, x.click_action, s.marca, s.modelo, s.phone_zone, s.device_type FROM sends x JOIN subscribers s ON s.id = x.subscriber_id WHERE x.campaign_id = ? AND x.is_test = 0 ORDER BY x.id', Number(req.params.id)));
    const cols = ['id', 'subscriber_id', 'status', 'http_status', 'error', 'attempts', 'sent_at', 'delivered_at', 'clicked_at', 'click_action', 'marca', 'modelo', 'phone_zone', 'device_type'];
    res.set('Content-Disposition', `attachment; filename="campana-${req.params.id}-envios.csv"`);
    res.type('text/csv; charset=utf-8').send('\ufeff' + [cols.join(',')].concat(rows.map((x) => cols.map((c) => csvEscape(x[c])).join(','))).join('\r\n'));
  });

  // ---------- Automatizaciones (opcional) ----------
  r.get('/automations', async (req, res) => {
    const rows = (await db.all('SELECT a.*, p.name AS piece_name FROM automations a LEFT JOIN pieces p ON p.id = a.piece_id ORDER BY a.id'));
    res.json(await Promise.all(rows.map(async (a) => {
      const st = a.campaign_id ? (await db.get("SELECT COUNT(*) AS total, SUM(status='sent') AS sent, SUM(clicked_at IS NOT NULL) AS clicked, SUM(status='queued') AS queued FROM sends WHERE campaign_id = ? AND is_test = 0", a.campaign_id)) : null;
      return { ...a, filters: parseJson(a.filters, {}), description: describeFilters(parseJson(a.filters, {})), stats: st };
    })));
  });
  r.put('/automations/:id', async (req, res) => {
    const a = (await db.get('SELECT * FROM automations WHERE id = ?', Number(req.params.id)));
    if (!a) return res.status(404).json({ error: 'No existe' });
    const b = req.body || {};
    const pieceId = b.piece_id ? Number(b.piece_id) : a.piece_id;
    const enabled = b.enabled ? 1 : 0;
    if (enabled && !pieceId) throw bad('Elegí una pieza antes de activar');
    const days = Math.max(0, Math.min(365, Number(b.days ?? a.days) || 0));
    if (a.type === 'recontact' && enabled && days < 1) throw bad('El recontacto necesita al menos 1 día');
    const filters = JSON.stringify(normalizeFilters(b.filters || parseJson(a.filters, {})));
    let campaignId = a.campaign_id;
    if (pieceId && !campaignId) {
      const x = (await db.run("INSERT INTO campaigns(name, kind, piece_id, status, ttl) VALUES(?, 'auto', ?, 'automatica', 259200)", `Auto: ${a.name}`, pieceId));
      campaignId = Number(x.lastInsertRowid);
    } else if (campaignId && pieceId) (await db.run('UPDATE campaigns SET piece_id = ? WHERE id = ?', pieceId, campaignId));
    const enabledAt = enabled && !a.enabled ? nowIso() : a.enabled_at;
    (await db.run('UPDATE automations SET enabled = ?, piece_id = ?, days = ?, filters = ?, campaign_id = ?, enabled_at = ? WHERE id = ?', enabled, pieceId, days, filters, campaignId, enabledAt, a.id));
    audit(db, req.admin.username, 'automatizacion', { id: a.id, enabled });
    res.json({ ok: true });
  });

  // ---------- Configuración ----------
  const EDITABLE = ['site_name', 'logo_url', 'icon_url', 'badge_url', 'optin_title', 'optin_text', 'optin_button', 'consent_text', 'success_text', 'default_url', 'privacy_contact'];
  r.get('/settings', async (req, res) => {
    const out = {};
    Object.assign(out, await getSettings(db, EDITABLE));
    res.json({ settings: out, vapidPublicKey: vapid.publicKey, vapidSource: vapid.source, vapidSubject: vapid.subject, baseUrl: cfg.baseUrl, https: cfg.baseUrl.startsWith('https://'), apiEnabled: !!cfg.apiKey, phoneEncryption: !!cfg.phoneEncKey, timezone: cfg.timezone, dbDriver: db.driver });
  });
  r.put('/settings', onlyAdmin, async (req, res) => {
    const b = req.body || {};
    for (const k of EDITABLE) if (b[k] !== undefined) {
      const v = String(b[k]).slice(0, 1000);
      if (/_url$/.test(k) && v && !isHttpUrl(v, { allowRelative: true })) throw bad(`URL inválida en ${k}`);
      await setSetting(db, k, v);
    }
    audit(db, req.admin.username, 'config', { keys: Object.keys(b) });
    res.json({ ok: true });
  });

  // ---------- Usuarios admin ----------
  r.get('/admins', onlyAdmin, async (req, res) => res.json((await db.all('SELECT id, username, role, created_at, last_login_at FROM admins ORDER BY id'))));
  r.post('/admins', onlyAdmin, async (req, res) => {
    const username = clean(req.body && req.body.username, 40);
    const password = String((req.body && req.body.password) || '');
    const role = req.body && req.body.role === 'editor' ? 'editor' : 'admin';
    if (!username || !/^[\w.@-]{3,40}$/.test(username)) throw bad('Usuario inválido (3 a 40 caracteres: letras, números, . _ - @)');
    if (password.length < 10) throw bad('La contraseña necesita al menos 10 caracteres');
    if ((await db.get('SELECT id FROM admins WHERE username = ?', username))) throw bad('Ese usuario ya existe');
    (await db.run('INSERT INTO admins(username, pass_hash, role) VALUES(?,?,?)', username, hashPassword(password), role));
    audit(db, req.admin.username, 'admin_creado', { username, role });
    res.status(201).json({ ok: true });
  });
  r.delete('/admins/:id', onlyAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.admin.id) throw bad('No podés borrar tu propio usuario');
    const target = (await db.get('SELECT role FROM admins WHERE id = ?', id));
    if (target && target.role === 'admin' && (await db.get("SELECT COUNT(*) AS n FROM admins WHERE role = 'admin'")).n <= 1) throw bad('Tiene que quedar al menos un admin');
    await db.batch([['DELETE FROM sessions WHERE admin_id = ?', [id]], ['DELETE FROM admins WHERE id = ?', [id]]]);
    audit(db, req.admin.username, 'admin_borrado', { id });
    res.json({ ok: true });
  });
  r.post('/me/password', async (req, res) => {
    const { current, next: nw } = req.body || {};
    const a = (await db.get('SELECT * FROM admins WHERE id = ?', req.admin.id));
    if (!verifyPassword(current || '', a.pass_hash)) throw bad('La contraseña actual no coincide', 403);
    if (String(nw || '').length < 10) throw bad('La nueva contraseña necesita al menos 10 caracteres');
    (await db.run('UPDATE admins SET pass_hash = ? WHERE id = ?', hashPassword(nw), a.id));
    (await db.run('DELETE FROM sessions WHERE admin_id = ? AND csrf <> ?', a.id, req.admin.csrf));
    res.json({ ok: true });
  });

  // Identificar el suscriptor de este navegador (dispositivo de prueba del equipo)
  r.post('/me/device', async (req, res) => {
    const endpoint = req.body && req.body.endpoint;
    const row = endpoint ? await db.get('SELECT id, status FROM subscribers WHERE endpoint = ?', String(endpoint)) : null;
    res.json(row ? { id: row.id, status: row.status } : { id: null });
  });

  r.get('/audit', onlyAdmin, async (req, res) => res.json((await db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200'))));

  return r;
};
