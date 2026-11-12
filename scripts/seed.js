'use strict';
// DATOS DE EJEMPLO (ficticios) para probar el panel. No usar en producción.
//   npm run seed            -> carga ~80 suscriptores, 3 piezas, 2 segmentos y 1 campaña de EJEMPLO
//   npm run seed -- --borrar -> borra todo lo marcado como ejemplo
// Los suscriptores de ejemplo usan endpoints https://ejemplo.invalid/... (no existen: nunca reciben nada)
// y llevan la etiqueta "datos-de-ejemplo".
const crypto = require('node:crypto');
const { loadDotEnv, getConfig } = require('../src/config');
loadDotEnv();
const { openDb, nowIso } = require('../src/db');
const { upsertSubscription, setTags } = require('../src/subscribers');
const { loadOrCreateSecrets } = require('../src/secrets');

const TAG = 'datos-de-ejemplo';
const UAS = [
  'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; moto g84) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0',
];
const MODELOS = ['208', '2008', '3008', 'PARTNER', 'EXPERT', '208', '2008', '208'];
const TELS = ['11 5555 0101', '011 15 5555 0102', '+54 9 351 555 0103', '0341 15 555 0104', '2614 55 0105', '221 555 0106', '11 5555 0107', '', '', '0299 555 0108', '387 555 0109', '11 5555 0110'];
const ASESORES = ['Asesor A (ejemplo)', 'Asesor B (ejemplo)', 'Asesor C (ejemplo)'];
const ORIGENES = ['presupuesto', 'presupuesto', 'qr-salon', 'instagram', 'web'];

function pick(a, i) { return a[i % a.length]; }

async function main() {
  const cfg = getConfig();
  if (cfg.production && !process.argv.includes('--force')) { console.error('NODE_ENV=production: el seed de ejemplo no se ejecuta (usá --force si de verdad querés).'); process.exit(1); }
  const db = await openDb({ tursoUrl: cfg.tursoUrl, tursoToken: cfg.tursoToken, file: cfg.dbFile, driver: cfg.dbDriver });
  const secrets = await loadOrCreateSecrets(db, cfg, { warn() {}, log() {} });
  cfg.phoneHashSecret = secrets.phoneHashSecret;

  if (process.argv.includes('--borrar')) {
    const ids = (await db.all('SELECT subscriber_id AS id FROM subscriber_tags WHERE tag = ?', TAG)).map((r) => r.id);
    for (const id of ids) await db.batch([['DELETE FROM sends WHERE subscriber_id = ?', [id]], ['DELETE FROM subscriber_tags WHERE subscriber_id = ?', [id]], ['DELETE FROM subscribers WHERE id = ?', [id]]]);
    const camps = await db.all("SELECT id FROM campaigns WHERE name LIKE 'EJEMPLO%'");
    for (const c of camps) await db.batch([['DELETE FROM sends WHERE campaign_id = ?', [c.id]], ['DELETE FROM campaigns WHERE id = ?', [c.id]]]);
    await db.run("DELETE FROM pieces WHERE name LIKE 'EJEMPLO%' AND id NOT IN (SELECT piece_id FROM campaigns)");
    await db.run("DELETE FROM segments WHERE name LIKE 'EJEMPLO%'");
    console.log(`Borrados ${ids.length} suscriptores de ejemplo, ${camps.length} campañas de ejemplo, piezas y segmentos de ejemplo.`);
    return;
  }

  const N = 80;
  const subIds = [];
  for (let i = 0; i < N; i++) {
    const sub = { endpoint: `https://ejemplo.invalid/push/${crypto.randomBytes(12).toString('hex')}`, keys: { p256dh: crypto.randomBytes(65).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
    const r = await upsertSubscription(db, cfg, {
      subscription: sub, userAgent: pick(UAS, i * 7 + (i % 3)),
      meta: { marca: 'PEUGEOT', modelo: pick(MODELOS, i * 3 + (i % 5)), tel: pick(TELS, i), asesor: pick(ASESORES, i), origen: pick(ORIGENES, i * 2), campana: i % 4 === 0 ? 'noviembre-2026' : null, lang: 'es-AR', tz: 'America/Argentina/Buenos_Aires', tags: [TAG] },
    });
    // Repartir las altas en los últimos 30 días
    const created = new Date(Date.now() - ((i * 37) % 30) * 86400e3 - (i % 9) * 3600e3);
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(created);
    await db.run('UPDATE subscribers SET created_at = ?, sub_local_date = ? WHERE id = ?', created.toISOString(), local, r.id);
    if (i % 11 === 0) await db.run("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ? WHERE id = ?", new Date(created.getTime() + 3 * 86400e3).toISOString(), r.id);
    if (i % 17 === 0) await db.run("UPDATE subscribers SET status = 'dead' WHERE id = ?", r.id);
    if (i % 6 === 0) await setTags(db, r.id, ['interesado-financiacion']);
    subIds.push(r.id);
  }
  const p1 = (await db.run("INSERT INTO pieces(name, title, body, image, url, actions) VALUES(?,?,?,?,?,?)", 'EJEMPLO Novedades del modelo', 'Novedades para tu {{modelo|Peugeot}}', 'Hay ofertas y beneficios vigentes en Peugeot Giama. Consultá el detalle con {{asesor|tu asesor}}.', '/brand/pieza-ejemplo-1024x512.png', 'https://www.peugeotgiama.com.ar/', JSON.stringify([{ title: 'Ver novedades', url: 'https://www.peugeotgiama.com.ar/' }, { title: 'Hablar con un asesor', url: 'https://www.peugeotgiama.com.ar/contacto' }]))).lastInsertRowid;
  await db.run("INSERT INTO pieces(name, title, body, url) VALUES(?,?,?,?)", 'EJEMPLO Bienvenida', 'Ya estás suscripto a Peugeot Giama', 'Solo te avisamos cuando hay algo que vale la pena sobre tu {{modelo|Peugeot}}.', 'https://www.peugeotgiama.com.ar/');
  await db.run("INSERT INTO pieces(name, title, body, url) VALUES(?,?,?,?)", 'EJEMPLO Test drive', 'Manejá el nuevo {{modelo|208}}', 'Reservá tu test drive en el salón más cercano.', 'https://www.peugeotgiama.com.ar/');
  await db.run("INSERT INTO pieces(name, title, body, url) VALUES(?,?,?,?)", 'EJEMPLO Recordatorio presupuesto', 'Tu presupuesto sigue vigente', 'Te esperamos para cerrar tu {{marca}} {{modelo}}.', 'https://www.peugeotgiama.com.ar/');
  await db.run("INSERT INTO segments(name, filters) VALUES(?, ?)", 'EJEMPLO 208 en AMBA', JSON.stringify({ modelo: ['208'], zona: ['AMBA'] }));
  await db.run("INSERT INTO segments(name, filters) VALUES(?, ?)", 'EJEMPLO Mobile interior', JSON.stringify({ device: ['mobile'], zona: ['Interior'] }));
  // Campaña de ejemplo ya "finalizada" con métricas simuladas (no se envió nada real)
  const started = new Date(Date.now() - 5 * 86400e3).toISOString();
  const cid = (await db.run("INSERT INTO campaigns(name, kind, piece_id, filters, status, started_at, finished_at, total_targeted) VALUES(?, 'manual', ?, '{}', 'finalizada', ?, ?, ?)", 'EJEMPLO Campaña simulada (sin envío real)', p1, started, started, 60)).lastInsertRowid;
  for (let i = 0; i < 60; i++) {
    const dead = i % 15 === 0;
    const sent = new Date(Date.parse(started) + i * 1000).toISOString();
    await db.run('INSERT INTO sends(token, campaign_id, subscriber_id, status, attempts, http_status, sent_at, delivered_at, clicked_at, click_action) VALUES(?,?,?,?,?,?,?,?,?,?)',
      crypto.randomBytes(12).toString('hex'), cid, subIds[i], dead ? 'dead' : 'sent', 1, dead ? 410 : 201, dead ? null : sent,
      !dead && i % 5 !== 0 ? sent : null, !dead && i % 6 === 0 ? sent : null, !dead && i % 6 === 0 ? String(i % 12 === 0 ? 1 : 0) : null);
  }
  console.log(`Cargados ${N} suscriptores, 3 piezas, 2 segmentos y 1 campaña. TODO ES DE EJEMPLO (etiqueta "${TAG}"). Para borrarlo: npm run seed -- --borrar`);
  console.log(nowIso());
}
main().catch((e) => { console.error(e); process.exit(1); });
