'use strict';
// Motor de envío: arma el payload por suscriptor, envía en lotes con reintentos,
// desactiva suscripciones muertas (404/410) y registra cada envío.
const { nowIso, getSetting } = require('./db');
const { buildWhere } = require('./segments');
const { randomToken } = require('./util');

const MAX_ATTEMPTS = 3;

function renderVars(text, sub = {}) {
  if (!text) return text;
  const vals = {
    marca: sub.marca ? titleCase(sub.marca) : '',
    modelo: sub.modelo ? titleCase(sub.modelo) : '',
    asesor: sub.asesor || '',
    zona: sub.phone_zone || '',
    region: sub.phone_region || '',
  };
  return String(text).replace(/\{\{\s*(\w+)\s*(?:\|([^}]*))?\}\}/g, (m, k, def) => {
    const v = vals[k.toLowerCase()];
    if (v) return v;
    if (def !== undefined) return def.trim();
    return k.toLowerCase() in vals ? '' : m;
  }).replace(/\s{2,}/g, ' ').trim();
}

function titleCase(s) {
  // "PEUGEOT" -> "Peugeot"; modelos numéricos quedan igual ("208"); siglas cortas en mayúscula ("GT")
  return String(s).split(' ').map((w) => (w.length <= 3 || /\d/.test(w) ? w : w[0] + w.slice(1).toLowerCase())).join(' ');
}

function absUrl(u, baseUrl) {
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('/')) return baseUrl + u;
  return u;
}

function slug(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function addUtm(url, { campaign, piece }) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('utm_source')) u.searchParams.set('utm_source', 'webpush');
    if (!u.searchParams.has('utm_medium')) u.searchParams.set('utm_medium', 'push');
    if (!u.searchParams.has('utm_campaign')) u.searchParams.set('utm_campaign', campaign ? `${slug(campaign.name) || 'campana'}-${campaign.id}` : 'prueba');
    if (!u.searchParams.has('utm_content')) u.searchParams.set('utm_content', `pieza-${piece.id}`);
    return u.toString();
  } catch { return url; }
}

// URL final (después del tracking) para el clic principal (a=0) o un botón (a=1,2)
function targetUrl({ piece, campaign, sub, action = 0, baseUrl }) {
  const actions = parseJson(piece.actions, []);
  let url = action > 0 && actions[action - 1] ? actions[action - 1].url : piece.url;
  url = absUrl(renderVars(url, sub).replace(/\s/g, ''), baseUrl);
  if (piece.utm_auto) url = addUtm(url, { campaign, piece });
  return url;
}

function parseJson(s, def) { try { return s ? JSON.parse(s) : def; } catch { return def; } }

function buildPayload({ piece, sub, token, baseUrl, siteIcon, badge }) {
  const actions = parseJson(piece.actions, []).slice(0, 2);
  return {
    title: renderVars(piece.title, sub).slice(0, 120),
    body: renderVars(piece.body, sub).slice(0, 400),
    icon: absUrl(piece.icon || siteIcon, baseUrl),
    image: piece.image ? absUrl(piece.image, baseUrl) : undefined,
    badge: absUrl(badge, baseUrl),
    tag: `c-${token.slice(0, 8)}`,
    requireInteraction: !!piece.require_interaction,
    actions: actions.map((a, i) => ({ action: `a${i + 1}`, title: renderVars(a.title, sub).slice(0, 40) })),
    data: {
      url: `${baseUrl}/r/${token}`,
      actionUrls: actions.map((a, i) => `${baseUrl}/r/${token}?a=${i + 1}`),
      delivered: `${baseUrl}/t/d/${token}`,
      closed: `${baseUrl}/t/c/${token}`,
    },
  };
}

function createSender({ db, cfg, sendNotification, vapid, logger = console }) {
  const running = new Set();
  let brand = { icon: '/brand/icon-192.png', badge: '/brand/badge-96.png', at: 0 };

  async function brandAssets() {
    if (Date.now() - brand.at > 60e3) {
      brand = { icon: await getSetting(db, 'icon_url', '/brand/icon-192.png'), badge: await getSetting(db, 'badge_url', '/brand/badge-96.png'), at: Date.now() };
    }
    return brand;
  }

  function sendOptions(campaign) {
    return {
      TTL: campaign.ttl, urgency: campaign.urgency, timeout: 15000,
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    };
  }

  // Envía una notificación y devuelve las sentencias SQL a registrar (se graban en lote)
  async function deliver(send, sub, campaign, piece, assets) {
    const stmts = [];
    if (!sub || (sub.status !== 'active' && !send.is_test)) {
      stmts.push(["UPDATE sends SET status = 'cancelled', error = 'suscriptor inactivo' WHERE id = ?", [send.id]]);
      return { result: 'cancelled', stmts };
    }
    const payload = buildPayload({ piece, sub, token: send.token, baseUrl: cfg.baseUrl, siteIcon: assets.icon, badge: assets.badge });
    const attempts = send.attempts + 1;
    try {
      const res = await sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), sendOptions(campaign));
      const now = nowIso();
      stmts.push(["UPDATE sends SET status = 'sent', attempts = ?, http_status = ?, sent_at = ?, error = NULL WHERE id = ?", [attempts, res && res.statusCode ? res.statusCode : 201, now, send.id]]);
      if (!send.is_test) stmts.push(['UPDATE subscribers SET last_push_at = ? WHERE id = ?', [now, sub.id]]);
      return { result: 'sent', stmts };
    } catch (err) {
      const code = err && err.statusCode ? err.statusCode : null;
      const msg = String((err && (err.body || err.message)) || 'error').slice(0, 300);
      if (code === 404 || code === 410) {
        stmts.push(["UPDATE sends SET status = 'dead', attempts = ?, http_status = ?, error = ? WHERE id = ?", [attempts, code, 'Suscripción vencida o dada de baja en el navegador', send.id]]);
        stmts.push(["UPDATE subscribers SET status = 'dead', updated_at = ? WHERE id = ?", [nowIso(), sub.id]]);
        return { result: 'dead', stmts };
      }
      const retryable = !code || code === 429 || code >= 500;
      if (retryable && attempts < MAX_ATTEMPTS) {
        const wait = (Number(err && err.headers && err.headers['retry-after']) * 1000) || 5000 * 2 ** (attempts - 1);
        stmts.push(['UPDATE sends SET attempts = ?, http_status = ?, error = ?, next_attempt_at = ? WHERE id = ?', [attempts, code, msg, new Date(Date.now() + wait).toISOString(), send.id]]);
        return { result: 'retry', stmts };
      }
      stmts.push(["UPDATE sends SET status = 'failed', attempts = ?, http_status = ?, error = ? WHERE id = ?", [attempts, code, msg, send.id]]);
      if (code === 403 || code === 401) logger.warn(`[push] ${code} en envío ${send.id}: revisar claves VAPID (¿cambiaron?)`);
      return { result: 'failed', stmts };
    }
  }

  // Arma la lista de destinatarios de una campaña una sola vez, con un único INSERT ... SELECT
  async function materialize(campaign) {
    return db.tx(async (t) => {
      const fresh = await t.get('SELECT * FROM campaigns WHERE id = ?', campaign.id);
      if (fresh.started_at) return fresh;
      const w = buildWhere(parseJson(fresh.filters, {}));
      const and = w.sql ? `${w.sql} AND` : 'WHERE';
      let skipped = 0;
      let capSql = ''; const capArgs = [];
      if (fresh.freq_cap_hours > 0) {
        const limit = new Date(Date.now() - fresh.freq_cap_hours * 3600e3).toISOString();
        skipped = (await t.get(`SELECT COUNT(*) AS n FROM subscribers s ${and} s.last_push_at >= ?`, ...w.params, limit)).n;
        capSql = `${and} (s.last_push_at IS NULL OR s.last_push_at < ?)`; capArgs.push(limit);
      }
      const ins = await t.run(`INSERT OR IGNORE INTO sends(token, campaign_id, subscriber_id) SELECT lower(hex(randomblob(16))), ?, s.id FROM subscribers s ${capSql || w.sql}`, fresh.id, ...w.params, ...capArgs);
      const now = nowIso();
      await t.run("UPDATE campaigns SET status = 'enviando', started_at = ?, total_targeted = ?, skipped_freq = ?, updated_at = ? WHERE id = ?", now, ins.changes, skipped, now, fresh.id);
      return t.get('SELECT * FROM campaigns WHERE id = ?', fresh.id);
    });
  }

  async function processCampaign(id) {
    if (running.has(id)) return;
    running.add(id);
    try {
      let campaign = await db.get('SELECT * FROM campaigns WHERE id = ?', id);
      if (!campaign) return;
      if (campaign.kind === 'manual' || campaign.kind === 'api') {
        if (!['programada', 'enviando'].includes(campaign.status)) return;
        if (campaign.status === 'programada' && campaign.scheduled_at && Date.parse(campaign.scheduled_at) > Date.now()) return;
        campaign = await materialize(campaign);
      }
      const piece = await db.get('SELECT * FROM pieces WHERE id = ?', campaign.piece_id);
      if (!piece) { logger.error(`[push] campaña ${id} sin pieza`); return; }
      const assets = await brandAssets();
      for (;;) {
        const st = (await db.get('SELECT status FROM campaigns WHERE id = ?', id)).status;
        if (st === 'cancelada') {
          await db.run("UPDATE sends SET status = 'cancelled', error = 'campaña cancelada' WHERE campaign_id = ? AND status = 'queued'", id);
          return;
        }
        // Lote con los datos del suscriptor en la misma consulta
        const batch = await db.all(`SELECT x.id, x.token, x.is_test, x.attempts, x.subscriber_id,
            s.id AS sid, s.endpoint, s.p256dh, s.auth, s.status AS sub_status, s.marca, s.modelo, s.asesor, s.phone_zone, s.phone_region
          FROM sends x LEFT JOIN subscribers s ON s.id = x.subscriber_id
          WHERE x.campaign_id = ? AND x.status = 'queued' AND (x.next_attempt_at IS NULL OR x.next_attempt_at <= ?) ORDER BY x.id LIMIT ?`, id, nowIso(), cfg.sendBatchSize);
        if (!batch.length) break;
        let i = 0; const stmts = [];
        const workers = Array.from({ length: Math.min(cfg.sendConcurrency, batch.length) }, async () => {
          while (i < batch.length) {
            const row = batch[i++];
            const sub = row.sid ? { id: row.sid, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth, status: row.sub_status, marca: row.marca, modelo: row.modelo, asesor: row.asesor, phone_zone: row.phone_zone, phone_region: row.phone_region } : null;
            const out = await deliver(row, sub, campaign, piece, assets);
            stmts.push(...out.stmts);
          }
        });
        await Promise.all(workers);
        await db.batch(stmts);
      }
      const pending = (await db.get("SELECT COUNT(*) AS n FROM sends WHERE campaign_id = ? AND status = 'queued'", id)).n;
      if (!pending && (campaign.kind === 'manual' || campaign.kind === 'api')) {
        await db.run("UPDATE campaigns SET status = 'finalizada', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'enviando'", nowIso(), nowIso(), id);
      }
    } catch (e) {
      logger.error(`[push] error procesando campaña ${id}: ${e.message}`);
    } finally {
      running.delete(id);
    }
  }

  async function sendTest({ campaignId, pieceId, subscriberId }) {
    let campaign;
    if (campaignId) campaign = await db.get('SELECT * FROM campaigns WHERE id = ?', campaignId);
    else {
      if (!(await db.get('SELECT id FROM pieces WHERE id = ?', pieceId))) throw Object.assign(new Error('Pieza inexistente'), { status: 404 });
      campaign = await db.get("SELECT * FROM campaigns WHERE kind = 'test' AND piece_id = ?", pieceId);
      if (!campaign) {
        const r = await db.run("INSERT INTO campaigns(name, kind, piece_id, status) VALUES(?, 'test', ?, 'finalizada')", `Pruebas pieza ${pieceId}`, pieceId);
        campaign = await db.get('SELECT * FROM campaigns WHERE id = ?', r.lastInsertRowid);
      }
    }
    if (!campaign) throw Object.assign(new Error('Campaña inexistente'), { status: 404 });
    const sub = await db.get('SELECT * FROM subscribers WHERE id = ?', subscriberId);
    if (!sub) throw Object.assign(new Error('Suscriptor inexistente'), { status: 404 });
    const piece = await db.get('SELECT * FROM pieces WHERE id = ?', campaign.piece_id);
    const r = await db.run('INSERT INTO sends(token, campaign_id, subscriber_id, is_test) VALUES(?, ?, ?, 1)', randomToken(16), campaign.id, sub.id);
    const send = await db.get('SELECT * FROM sends WHERE id = ?', r.lastInsertRowid);
    const out = await deliver(send, sub, campaign, piece, await brandAssets());
    await db.batch(out.stmts);
    const after = await db.get('SELECT status, http_status, error FROM sends WHERE id = ?', send.id);
    return { result: out.result, ...after };
  }

  // Envío automático a un suscriptor (bienvenida)
  async function sendAutomation(automation, subscriberId) {
    if (!automation.campaign_id) return null;
    const r = await db.run('INSERT OR IGNORE INTO sends(token, campaign_id, subscriber_id) VALUES(?, ?, ?)', randomToken(16), automation.campaign_id, subscriberId);
    if (!r.changes) return null;
    await processCampaign(automation.campaign_id);
    return true;
  }

  // Recontacto: encola a quienes cumplen N días desde que se activó la regla
  async function enqueueRecontacts() {
    const autos = await db.all("SELECT * FROM automations WHERE type = 'recontact' AND enabled = 1 AND campaign_id IS NOT NULL");
    let n = 0;
    for (const a of autos) {
      const w = buildWhere(parseJson(a.filters, {}));
      const cutoff = new Date(Date.now() - a.days * 86400e3).toISOString();
      const from = new Date(Date.parse(a.enabled_at || a.created_at) - a.days * 86400e3).toISOString();
      const r = await db.run(`INSERT OR IGNORE INTO sends(token, campaign_id, subscriber_id)
        SELECT lower(hex(randomblob(16))), ?, s.id FROM subscribers s ${w.sql} ${w.sql ? 'AND' : 'WHERE'} s.created_at <= ? AND s.created_at > ?`, a.campaign_id, ...w.params, cutoff, from);
      n += r.changes;
    }
    return n;
  }

  // Procesa todo lo atrasado: programadas vencidas, envíos en curso/reintentos y automatizaciones
  let ticking = null; let lastTick = 0;
  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      lastTick = Date.now();
      const recontacts = await enqueueRecontacts();
      const due = await db.all(`SELECT id FROM campaigns WHERE
          (status = 'programada' AND (scheduled_at IS NULL OR scheduled_at <= ?))
          OR status = 'enviando'
          OR (status = 'automatica' AND EXISTS (SELECT 1 FROM sends s WHERE s.campaign_id = campaigns.id AND s.status = 'queued'))`, nowIso());
      for (const c of due) await processCampaign(c.id);
      return { processed: due.map((c) => c.id), recontactsQueued: recontacts };
    })();
    try { return await ticking; } finally { ticking = null; }
  }

  // Dispara un tick en segundo plano si pasó más de `minMs` desde el último (al despertar el servidor)
  function nudge(minMs = 60e3) {
    if (!ticking && Date.now() - lastTick > minMs) tick().catch((e) => logger.error('[scheduler]', e.message));
  }

  let timer = null;
  function start() {
    if (timer) return;
    const loop = async () => { try { await tick(); } catch (e) { logger.error('[scheduler]', e.message); } timer = setTimeout(loop, cfg.schedulerIntervalMs); timer.unref?.(); };
    timer = setTimeout(loop, 500); timer.unref?.();
  }
  function stop() { if (timer) clearTimeout(timer); timer = null; }

  return { processCampaign, sendTest, sendAutomation, tick, nudge, start, stop, enqueueRecontacts };
}

module.exports = { createSender, renderVars, buildPayload, targetUrl, addUtm, parseJson, absUrl };
