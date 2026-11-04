'use strict';
const { nowIso } = require('./db');
const { parseUA } = require('./ua');
const { normalizeArPhone, hashPhone, encryptPhone } = require('./phone');
const { randomToken, clean, cleanUpper, normTag, zonedParts, daypart, isHttpUrl } = require('./util');

function validateSubscription(sub) {
  if (!sub || typeof sub !== 'object') return 'Falta la suscripción';
  if (!isHttpUrl(sub.endpoint) || !String(sub.endpoint).startsWith('https://')) return 'Endpoint inválido';
  if (String(sub.endpoint).length > 1000) return 'Endpoint demasiado largo';
  const k = sub.keys || {};
  if (typeof k.p256dh !== 'string' || !/^[A-Za-z0-9_\-+/=]{20,200}$/.test(k.p256dh)) return 'Clave p256dh inválida';
  if (typeof k.auth !== 'string' || !/^[A-Za-z0-9_\-+/=]{8,100}$/.test(k.auth)) return 'Clave auth inválida';
  return null;
}

// Etiquetas automáticas en formato "campo:valor" para filtrar fácil.
function autoTags(row) {
  const t = [];
  if (row.marca) t.push(`marca:${row.marca}`);
  if (row.modelo) t.push(`modelo:${row.modelo}`);
  if (row.phone_zone) t.push(`zona:${row.phone_zone}`);
  if (row.phone_area) t.push(`prefijo:0${row.phone_area}`);
  if (row.device_type) t.push(`dispositivo:${row.device_type}`);
  if (row.os) t.push(`so:${row.os}`);
  if (row.origen) t.push(`origen:${row.origen}`);
  return t.map(normTag).filter(Boolean);
}

// db puede ser la base o una transacción (misma interfaz)
async function setTags(db, subscriberId, add = [], remove = []) {
  for (const t of add.map(normTag).filter(Boolean)) await db.run('INSERT OR IGNORE INTO subscriber_tags(subscriber_id, tag) VALUES(?, ?)', subscriberId, t);
  for (const t of remove.map(normTag).filter(Boolean)) await db.run('DELETE FROM subscriber_tags WHERE subscriber_id = ? AND tag = ?', subscriberId, t);
}

// Versión para muchos suscriptores: pocas consultas (sirve igual en Turso remoto)
async function setTagsBulk(db, ids, add = [], remove = []) {
  const A = add.map(normTag).filter(Boolean); const R = remove.map(normTag).filter(Boolean);
  const stmts = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const ph = chunk.map(() => '?').join(',');
    for (const t of A) stmts.push([`INSERT OR IGNORE INTO subscriber_tags(subscriber_id, tag) SELECT id, ? FROM subscribers WHERE id IN (${ph})`, [t, ...chunk]]);
    for (const t of R) stmts.push([`DELETE FROM subscriber_tags WHERE tag = ? AND subscriber_id IN (${ph})`, [t, ...chunk]]);
  }
  if (stmts.length) await db.batch(stmts);
}

/**
 * Alta / actualización idempotente por endpoint.
 * meta: parámetros del link (marca, modelo, tel, asesor, origen, campana, utm_*), lang, tz, tags
 */
async function upsertSubscription(db, cfg, { subscription, meta = {}, userAgent = '' }) {
  const err = validateSubscription(subscription);
  if (err) { const e = new Error(err); e.status = 400; throw e; }
  const ua = parseUA(userAgent);
  const now = new Date();
  const zp = zonedParts(now, cfg.timezone);
  const phone = meta.tel ? normalizeArPhone(meta.tel) : null;
  const row = {
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    device_type: ua.device, os: ua.os, browser: ua.browser,
    lang: clean(meta.lang, 20), timezone: clean(meta.tz, 60),
    marca: cleanUpper(meta.marca, 40), modelo: cleanUpper(meta.modelo, 60),
    origen: normTag(meta.origen), campana: normTag(meta.campana),
    asesor: clean(meta.asesor, 80),
    utm_source: clean(meta.utm_source, 80), utm_medium: clean(meta.utm_medium, 80), utm_campaign: clean(meta.utm_campaign, 80),
    utm_content: clean(meta.utm_content, 80), utm_term: clean(meta.utm_term, 80),
    phone_area: phone && phone.valid ? phone.area : null,
    phone_zone: phone && phone.valid ? phone.zone : null,
    phone_region: phone && phone.valid ? phone.region : null,
    phone_hash: phone && phone.valid && cfg.phoneHashSecret ? hashPhone(phone.e164, cfg.phoneHashSecret) : null,
    phone_enc: phone && phone.valid && cfg.phoneEncKey ? encryptPhone(phone.e164, cfg.phoneEncKey) : null,
    landing_path: clean(meta.path, 200),
  };
  return db.tx(async (t) => {
    const existing = await t.get('SELECT * FROM subscribers WHERE endpoint = ?', row.endpoint);
    let id; let created = false; let reactivated = false;
    if (existing) {
      id = existing.id;
      reactivated = existing.status !== 'active';
      // No pisar etiquetas existentes con vacíos: COALESCE(nuevo, viejo)
      const cols = ['device_type', 'os', 'browser', 'lang', 'timezone', 'marca', 'modelo', 'origen', 'campana', 'asesor', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'phone_area', 'phone_zone', 'phone_region', 'phone_hash', 'phone_enc'];
      await t.run(`UPDATE subscribers SET p256dh = ?, auth = ?, status = 'active', unsubscribed_at = NULL, updated_at = ?, ${cols.map((c) => `${c} = COALESCE(?, ${c})`).join(', ')} WHERE id = ?`,
        row.p256dh, row.auth, nowIso(), ...cols.map((c) => row[c]), id);
    } else {
      created = true;
      const ins = {
        ...row, status: 'active', manage_token: randomToken(18), created_at: nowIso(), updated_at: nowIso(),
        sub_local_date: zp.date, sub_hour: zp.hour, sub_weekday: zp.weekday, sub_daypart: daypart(zp.hour),
      };
      const keys = Object.keys(ins);
      const r = await t.run(`INSERT INTO subscribers(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map((k) => ins[k]));
      id = Number(r.lastInsertRowid);
    }
    const full = await t.get('SELECT * FROM subscribers WHERE id = ?', id);
    const manual = Array.isArray(meta.tags) ? meta.tags : (meta.tags ? String(meta.tags).split(',') : []);
    await setTags(t, id, [...autoTags(full), ...manual.slice(0, 10)]);
    return { id, created, reactivated, manageToken: full.manage_token, phoneValid: phone ? !!phone.valid : null };
  });
}

async function unsubscribe(db, { endpoint, token }) {
  let row = null;
  if (token) row = await db.get('SELECT id, status FROM subscribers WHERE manage_token = ?', String(token));
  else if (endpoint) row = await db.get('SELECT id, status FROM subscribers WHERE endpoint = ?', String(endpoint));
  if (!row) return { ok: true, found: false };   // idempotente: no revelar existencia
  if (row.status === 'active') await db.run("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), row.id);
  return { ok: true, found: true, id: row.id };
}

async function subscriberTags(db, id) {
  return (await db.all('SELECT tag FROM subscriber_tags WHERE subscriber_id = ? ORDER BY tag', id)).map((r) => r.tag);
}

module.exports = { upsertSubscription, unsubscribe, setTags, setTagsBulk, subscriberTags, validateSubscription, autoTags };
