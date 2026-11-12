'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, fakeSubscription, subscribe, adminLogin, UA_ANDROID, UA_WIN, DRIVER } = require('./helpers');

test(`[${DRIVER}] health y config pública sin secretos`, async () => {
  const t = await startTestApp();
  try {
    const h = await (await fetch(`${t.base}/health`)).json();
    assert.equal(h.ok, true);
    const c = await (await fetch(`${t.base}/api/public-config`)).json();
    assert.ok(c.vapidPublicKey && c.vapidPublicKey.length > 60);
    assert.equal(JSON.stringify(c).includes('rivate'), false);
  } finally { await t.close(); }
});

test(`[${DRIVER}] suscripción idempotente con etiquetas automáticas`, async () => {
  const t = await startTestApp();
  try {
    const sub = fakeSubscription('idem');
    const meta = { marca: 'peugeot', modelo: '208', tel: '011 15 5555 1234', asesor: 'Laura', origen: 'Presupuesto', campana: 'Nov 2026', utm_source: 'pilot', lang: 'es-AR', tz: 'America/Argentina/Buenos_Aires' };
    const a = await subscribe(t.base, meta, sub);
    assert.equal(a.res.status, 201);
    assert.ok(a.body.manageToken);
    const b = await subscribe(t.base, meta, sub);
    assert.equal(b.res.status, 200);
    assert.equal(b.body.created, false);
    const rows = await t.db.all('SELECT * FROM subscribers');
    assert.equal(rows.length, 1);
    const s = rows[0];
    assert.equal(s.marca, 'PEUGEOT'); assert.equal(s.modelo, '208');
    assert.equal(s.phone_area, '11'); assert.equal(s.phone_zone, 'AMBA');
    assert.ok(s.phone_hash && !String(s.phone_hash).includes('5555'));
    assert.equal(s.phone_enc, null);
    assert.equal(s.device_type, 'mobile'); assert.equal(s.os, 'Android'); assert.equal(s.browser, 'Chrome');
    assert.equal(s.origen, 'presupuesto'); assert.equal(s.campana, 'nov-2026');
    const tags = (await t.db.all('SELECT tag FROM subscriber_tags WHERE subscriber_id = ?', s.id)).map((x) => x.tag);
    for (const tg of ['marca:peugeot', 'modelo:208', 'zona:amba', 'prefijo:011', 'dispositivo:mobile', 'so:android', 'origen:presupuesto']) assert.ok(tags.includes(tg), tg);
  } finally { await t.close(); }
});

test(`[${DRIVER}] validación y rate limit de /api/subscribe`, async () => {
  const t = await startTestApp();
  try {
    const bad = await fetch(`${t.base}/api/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: { endpoint: 'http://inseguro', keys: {} } }) });
    assert.equal(bad.status, 400);
    let last;
    for (let i = 0; i < 22; i++) last = await fetch(`${t.base}/api/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(last.status, 429);
  } finally { await t.close(); }
});

test(`[${DRIVER}] baja por endpoint y por token (idempotente)`, async () => {
  const t = await startTestApp();
  try {
    const a = await subscribe(t.base, { modelo: '2008' });
    let r = await fetch(`${t.base}/api/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: a.sub.endpoint }) });
    assert.equal(r.status, 200);
    assert.equal((await t.db.get('SELECT status FROM subscribers')).status, 'unsubscribed');
    r = await fetch(`${t.base}/api/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: a.body.manageToken }) });
    assert.equal(r.status, 200);
    // volver a suscribirse reactiva
    await subscribe(t.base, {}, a.sub);
    assert.equal((await t.db.get('SELECT status FROM subscribers')).status, 'active');
  } finally { await t.close(); }
});

test(`[${DRIVER}] auth y CSRF del panel`, async () => {
  const t = await startTestApp();
  try {
    assert.equal((await fetch(`${t.base}/admin/api/dashboard`)).status, 401);
    const wrong = await adminLogin(t.base, 'incorrecta');
    assert.equal(wrong.res.status, 401);
    const s = await adminLogin(t.base);
    assert.equal(s.res.status, 200);
    assert.match(s.res.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(s.res.headers.get('set-cookie'), /SameSite=Strict/i);
    assert.equal((await s.call('GET', '/dashboard')).status, 200);
    // POST sin token CSRF -> 403
    const noCsrf = await fetch(`${t.base}/admin/api/segments`, { method: 'POST', headers: { Cookie: s.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', filters: {} }) });
    assert.equal(noCsrf.status, 403);
    // Origen cruzado -> 403
    const cross = await fetch(`${t.base}/admin/api/segments`, { method: 'POST', headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf, Origin: 'https://malicioso.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', filters: {} }) });
    assert.equal(cross.status, 403);
    assert.equal((await s.call('POST', '/segments', { name: 'ok', filters: {} })).status, 201);
    // settings nunca expone la clave privada
    const st = await s.call('GET', '/settings');
    assert.equal(JSON.stringify(st.body).includes(t.cfg.vapidPrivateKey || 'zzzz-no'), false);
    assert.equal('vapidPrivateKey' in st.body, false);
    // logout invalida la sesión
    await s.call('POST', '/logout');
    assert.equal((await s.call('GET', '/dashboard')).status, 401);
  } finally { await t.close(); }
});

test(`[${DRIVER}] filtros de segmentos combinables`, async () => {
  const t = await startTestApp();
  try {
    await subscribe(t.base, { marca: 'PEUGEOT', modelo: '208', tel: '1155550001', origen: 'presupuesto', asesor: 'Ana' }, fakeSubscription(), UA_ANDROID);
    await subscribe(t.base, { marca: 'PEUGEOT', modelo: '208', tel: '3515550002', origen: 'qr' }, fakeSubscription(), UA_WIN);
    await subscribe(t.base, { marca: 'PEUGEOT', modelo: '2008', tel: '1155550003', origen: 'presupuesto', tags: ['vip'] }, fakeSubscription(), UA_ANDROID);
    await subscribe(t.base, { marca: 'PEUGEOT', modelo: '3008' }, fakeSubscription(), UA_WIN);
    const s = await adminLogin(t.base);
    const count = async (filters) => (await s.call('POST', '/segments/count', { filters })).body.count;
    assert.equal(await count({}), 4);
    assert.equal(await count({ modelo: ['208'] }), 2);
    assert.equal(await count({ modelo: ['208', '2008'] }), 3);
    assert.equal(await count({ modelo: ['208'], zona: ['AMBA'] }), 1);
    assert.equal(await count({ zona: ['AMBA'], device: ['mobile'] }), 2);
    assert.equal(await count({ area: ['351'] }), 1);
    assert.equal(await count({ device: ['desktop'], os: ['Windows'] }), 2);
    assert.equal(await count({ has_phone: false }), 1);
    assert.equal(await count({ tags: ['vip'] }), 1);
    assert.equal(await count({ tags: ['modelo:208', 'zona:amba'], tags_mode: 'all' }), 1);
    assert.equal(await count({ exclude_tags: ['vip'], origen: ['presupuesto'] }), 1);
    assert.equal(await count({ asesor: ['ana'] }), 1);
    assert.equal(await count({ q: '3008' }), 1);
    // etiquetado masivo por filtro y CSV
    const tg = await s.call('POST', '/subscribers/tags', { filters: { zona: ['AMBA'] }, add: ['Evento Noviembre'] });
    assert.equal(tg.body.affected, 2);
    assert.equal(await count({ tags: ['evento-noviembre'] }), 2);
    const csv = await s.call('GET', '/export.csv?filters=' + encodeURIComponent(JSON.stringify({ modelo: ['208'] })));
    assert.equal(csv.body.trim().split('\r\n').length, 3);
    assert.equal(csv.body.includes('5555'), false); // el teléfono nunca sale en claro
  } finally { await t.close(); }
});

async function crearPieza(s, extra = {}) {
  const r = await s.call('POST', '/pieces', { name: 'Promo', title: 'Tu {{modelo|Peugeot}} te espera', body: 'Hola {{asesor|}}', url: 'https://www.peugeotgiama.com.ar/promo', actions: [{ title: 'Ver', url: 'https://www.peugeotgiama.com.ar/ver' }], ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}

test(`[${DRIVER}] campaña: envío en lotes, 410 desactiva, tracking de entrega y clic con UTM`, async () => {
  const t = await startTestApp({
    sendNotification: async (sub, payload) => {
      if (sub.endpoint.endsWith('muerta')) { const e = new Error('Gone'); e.statusCode = 410; throw e; }
      t.calls.push(JSON.parse(payload));
      return { statusCode: 201 };
    },
  });
  try {
    await subscribe(t.base, { modelo: '208', asesor: 'Laura' }, fakeSubscription('viva1'));
    await subscribe(t.base, { modelo: '2008' }, fakeSubscription('viva2'));
    await subscribe(t.base, { modelo: '208' }, fakeSubscription('muerta'));
    const s = await adminLogin(t.base);
    const pid = await crearPieza(s);
    const c = await s.call('POST', '/campaigns', { name: 'Noviembre', piece_id: pid, filters: {}, mode: 'draft' });
    assert.equal(c.body.status, 'borrador');
    await s.call('PUT', `/campaigns/${c.body.id}`, { name: 'Noviembre', piece_id: pid, filters: {}, mode: 'now', ttl: 3600, urgency: 'high' });
    await t.sender.processCampaign(c.body.id);
    const rep = (await s.call('GET', `/campaigns/${c.body.id}`)).body;
    assert.equal(rep.status, 'finalizada');
    assert.equal(rep.total_targeted, 3);
    assert.equal(rep.stats.sent, 2);
    assert.equal(rep.stats.dead, 1);
    assert.equal((await t.db.get("SELECT status FROM subscribers WHERE endpoint LIKE '%muerta'")).status, 'dead');
    // payload personalizado
    const p208 = t.calls.find((p) => p.title.includes('208'));
    assert.equal(p208.title, 'Tu 208 te espera');
    assert.equal(p208.body, 'Hola Laura');
    assert.equal(p208.actions.length, 1);
    // entrega (beacon del service worker)
    const token = p208.data.url.split('/r/')[1];
    assert.equal((await fetch(p208.data.delivered, { method: 'POST' })).status, 204);
    // clic -> redirección con UTM
    const r = await fetch(`${t.base}/r/${token}?a=1`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.pathname, '/ver');
    assert.equal(loc.searchParams.get('utm_source'), 'webpush');
    assert.equal(loc.searchParams.get('utm_medium'), 'push');
    assert.match(loc.searchParams.get('utm_campaign'), /noviembre-\d+/);
    const rep2 = (await s.call('GET', `/campaigns/${c.body.id}`)).body;
    assert.equal(rep2.stats.delivered, 1);
    assert.equal(rep2.stats.clicked, 1);
    const dash = (await s.call('GET', '/dashboard')).body;
    assert.equal(dash.sends.sent, 2); assert.equal(dash.sends.clicked, 1); assert.equal(dash.totals.dead, 1);
  } finally { await t.close(); }
});

test(`[${DRIVER}] reintentos ante 5xx, límite de frecuencia, cancelar y duplicar`, async () => {
  let fallas = 0;
  const t = await startTestApp({
    sendNotification: async (sub) => {
      if (sub.endpoint.endsWith('flaky') && fallas < 1) { fallas++; const e = new Error('Server'); e.statusCode = 503; e.headers = { 'retry-after': '0' }; throw e; }
      return { statusCode: 201 };
    },
  });
  try {
    await subscribe(t.base, { modelo: '208' }, fakeSubscription('flaky'));
    await subscribe(t.base, { modelo: '208' }, fakeSubscription('ok'));
    const s = await adminLogin(t.base);
    const pid = await crearPieza(s);
    const c1 = (await s.call('POST', '/campaigns', { name: 'C1', piece_id: pid, mode: 'now', freq_cap_hours: 24 })).body.id;
    await t.sender.processCampaign(c1);
    let st = (await s.call('GET', `/campaigns/${c1}`)).body;
    assert.equal(st.status, 'enviando');            // queda el reintento pendiente
    await t.db.run("UPDATE sends SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE status = 'queued'");
    await t.sender.tick();
    st = (await s.call('GET', `/campaigns/${c1}`)).body;
    assert.equal(st.status, 'finalizada');
    assert.equal(st.stats.sent, 2);
    // segunda campaña con límite de 24 h: todos omitidos
    const c2 = (await s.call('POST', '/campaigns', { name: 'C2', piece_id: pid, mode: 'now', freq_cap_hours: 24 })).body.id;
    await t.sender.processCampaign(c2);
    const r2 = (await s.call('GET', `/campaigns/${c2}`)).body;
    assert.equal(r2.total_targeted, 0); assert.equal(r2.skipped_freq, 2);
    // programada a futuro + cancelar
    const fut = new Date(Date.now() + 86400e3);
    const local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short' }).format(fut).replace(' ', 'T');
    const c3 = (await s.call('POST', '/campaigns', { name: 'C3', piece_id: pid, mode: 'schedule', scheduled_local: local })).body.id;
    await t.sender.tick();
    assert.equal((await s.call('GET', `/campaigns/${c3}`)).body.status, 'programada');
    await s.call('POST', `/campaigns/${c3}/cancel`);
    assert.equal((await s.call('GET', `/campaigns/${c3}`)).body.status, 'cancelada');
    const dup = (await s.call('POST', `/campaigns/${c3}/duplicate`)).body.id;
    assert.equal((await s.call('GET', `/campaigns/${dup}`)).body.status, 'borrador');
  } finally { await t.close(); }
});

test(`[${DRIVER}] programada vencida se procesa vía /api/cron/tick (protegido con ADMIN_KEY)`, async () => {
  const t = await startTestApp();
  try {
    await subscribe(t.base, { modelo: '208' });
    const s = await adminLogin(t.base);
    const pid = await crearPieza(s);
    const c = (await s.call('POST', '/campaigns', { name: 'Atrasada', piece_id: pid, mode: 'draft' })).body.id;
    // simular que estaba programada para hace 10 minutos (el servidor dormía)
    await t.db.run("UPDATE campaigns SET status = 'programada', scheduled_at = ? WHERE id = ?", new Date(Date.now() - 600e3).toISOString(), c);
    assert.equal((await fetch(`${t.base}/api/cron/tick`)).status, 401);
    const r = await fetch(`${t.base}/api/cron/tick`, { headers: { Authorization: 'Bearer api-key-de-test' } });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).processed, [c]);
    assert.equal((await s.call('GET', `/campaigns/${c}`)).body.status, 'finalizada');
    assert.equal(t.calls.length, 1);
    const r2 = await fetch(`${t.base}/api/cron/tick?key=api-key-de-test`);
    assert.equal(r2.status, 200);
  } finally { await t.close(); }
});

test(`[${DRIVER}] prueba a dispositivo propio no cuenta en métricas`, async () => {
  const t = await startTestApp();
  try {
    const a = await subscribe(t.base, { origen: 'admin-prueba' });
    const s = await adminLogin(t.base);
    const pid = await crearPieza(s);
    const me = await s.call('POST', '/me/device', { endpoint: a.sub.endpoint });
    const r = await s.call('POST', `/pieces/${pid}/test`, { subscriberId: me.body.id });
    assert.equal(r.body.result, 'sent');
    assert.equal(t.calls.length, 1);
    assert.equal((await s.call('GET', '/dashboard')).body.sends.sent, 0);
  } finally { await t.close(); }
});

test(`[${DRIVER}] API de integración: etiquetar por teléfono y enviar campaña`, async () => {
  const t = await startTestApp();
  try {
    await subscribe(t.base, { modelo: '208', tel: '+54 9 11 5555-0000' });
    await subscribe(t.base, { modelo: '2008' });
    const h = { Authorization: 'Bearer api-key-de-test', 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${t.base}/api/subscribers/tag`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const tg = await (await fetch(`${t.base}/api/subscribers/tag`, { method: 'POST', headers: h, body: JSON.stringify({ phone: '011 15 5555 0000', add: ['presupuesto-enviado'] }) })).json();
    assert.equal(tg.matched, 1);
    const dry = await (await fetch(`${t.base}/api/campaigns/send`, { method: 'POST', headers: h, body: JSON.stringify({ piece: { title: 'Hola', url: 'https://www.peugeotgiama.com.ar/' }, filters: { tags: ['presupuesto-enviado'] }, dry_run: true }) })).json();
    assert.equal(dry.count, 1);
    const sent = await fetch(`${t.base}/api/campaigns/send`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'API test', piece: { title: 'Hola', url: 'https://www.peugeotgiama.com.ar/' }, filters: { tags: ['presupuesto-enviado'] } }) });
    assert.equal(sent.status, 202);
    const { campaign_id } = await sent.json();
    await t.sender.processCampaign(campaign_id);
    const st = await (await fetch(`${t.base}/api/campaigns/${campaign_id}`, { headers: h })).json();
    assert.equal(st.status, 'finalizada'); assert.equal(st.stats.sent, 1);
  } finally { await t.close(); }
});

test(`[${DRIVER}] subida de imágenes a la base, validación de tipo y tamaño`, async () => {
  const t = await startTestApp({ overrides: { maxUploadBytes: 2000 } });
  try {
    const s = await adminLogin(t.base);
    const png = Buffer.from('89504e470d0a1a0a0000000d494844520000040000000200080600000000000000', 'hex');
    const up = await fetch(`${t.base}/admin/api/uploads`, { method: 'POST', headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf, 'Content-Type': 'image/png' }, body: png });
    assert.equal(up.status, 201);
    const j = await up.json();
    assert.equal(j.width, 1024); assert.equal(j.height, 512);
    const img = await fetch(`${t.base}${j.url}`);
    assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
    const fake = await fetch(`${t.base}/admin/api/uploads`, { method: 'POST', headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf, 'Content-Type': 'image/png' }, body: Buffer.from('esto no es un png de verdad') });
    assert.equal(fake.status, 400);
    const big = await fetch(`${t.base}/admin/api/uploads`, { method: 'POST', headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf, 'Content-Type': 'image/png' }, body: Buffer.concat([png, Buffer.alloc(5000)]) });
    assert.equal(big.status, 413);
    const svg = await fetch(`${t.base}/admin/api/uploads`, { method: 'POST', headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf, 'Content-Type': 'image/svg+xml' }, body: '<svg/>' });
    assert.equal(svg.status, 400);
  } finally { await t.close(); }
});

test(`[${DRIVER}] export / import JSON de suscriptores para migrar`, async () => {
  const t1 = await startTestApp();
  const t2 = await startTestApp();
  try {
    await subscribe(t1.base, { modelo: '208', tags: ['vip'] });
    await subscribe(t1.base, { modelo: '2008' });
    const s1 = await adminLogin(t1.base);
    const exp = (await s1.call('GET', '/export.json')).body;
    assert.equal(exp.subscribers.length, 2);
    const s2 = await adminLogin(t2.base);
    const imp = await s2.call('POST', '/import.json', exp);
    assert.equal(imp.body.inserted, 2);
    assert.ok(imp.body.warning, 'avisa que la clave VAPID es distinta');
    const again = await s2.call('POST', '/import.json', exp);
    assert.equal(again.body.updated, 2);
    assert.equal((await t2.db.get("SELECT COUNT(*) AS n FROM subscriber_tags WHERE tag = 'vip'")).n, 1);
  } finally { await t1.close(); await t2.close(); }
});

test(`[${DRIVER}] automatizaciones: bienvenida al suscribirse y recontacto a N días`, async () => {
  const t = await startTestApp();
  try {
    const s = await adminLogin(t.base);
    const pid = await crearPieza(s);
    const autos = (await s.call('GET', '/automations')).body;
    const welcome = autos.find((a) => a.type === 'welcome');
    const recon = autos.find((a) => a.type === 'recontact');
    await s.call('PUT', `/automations/${welcome.id}`, { enabled: true, piece_id: pid });
    await subscribe(t.base, { modelo: '208' });
    for (let i = 0; i < 20 && t.calls.length < 1; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.calls.length, 1, 'bienvenida enviada');
    await s.call('PUT', `/automations/${recon.id}`, { enabled: true, piece_id: pid, days: 3, filters: { modelo: ['208'] } });
    // suscriptor que cumple 3 días justo después de activar la regla
    await t.db.run('UPDATE automations SET enabled_at = ? WHERE id = ?', new Date(Date.now() - 2 * 86400e3).toISOString(), recon.id);
    await t.db.run('UPDATE subscribers SET created_at = ?', new Date(Date.now() - 3.5 * 86400e3).toISOString());
    await t.sender.tick();
    assert.equal(t.calls.length, 2, 'recontacto enviado');
    await t.sender.tick();
    assert.equal(t.calls.length, 2, 'no se repite');
  } finally { await t.close(); }
});

test(`[${DRIVER}] supresión borra suscriptor, etiquetas y envíos`, async () => {
  const t = await startTestApp();
  try {
    await subscribe(t.base, { modelo: '208' });
    const s = await adminLogin(t.base);
    const id = (await t.db.get('SELECT id FROM subscribers')).id;
    const r = await s.call('DELETE', `/subscribers/${id}`);
    assert.equal(r.body.deleted, 1);
    assert.equal((await t.db.get('SELECT COUNT(*) AS n FROM subscriber_tags')).n, 0);
  } finally { await t.close(); }
});


test(`[${DRIVER}] el CSRF de /login es el de la sesión final y sirve para el próximo POST`, async () => {
  const t = await startTestApp();
  try {
    // Primera sesión
    const a = await adminLogin(t.base);
    assert.equal(a.res.status, 200);
    const me1 = await fetch(`${t.base}/admin/api/me`, { headers: { Cookie: a.cookie } });
    const me1b = await me1.json();
    assert.equal(me1b.csrf, a.csrf, 'GET /me debe devolver el mismo CSRF que /login');
    const ok = await a.call('POST', '/segments', { name: 'con-csrf-login', filters: {} });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));

    // Relogin: nueva sesión; el CSRF anterior ya no vale; el nuevo coincide con /me y funciona
    const b = await adminLogin(t.base);
    assert.notEqual(b.csrf, a.csrf);
    const me2 = await (await fetch(`${t.base}/admin/api/me`, { headers: { Cookie: b.cookie } })).json();
    assert.equal(me2.csrf, b.csrf);
    const stale = await fetch(`${t.base}/admin/api/segments`, {
      method: 'POST',
      headers: { Cookie: b.cookie, 'X-CSRF-Token': a.csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'viejo', filters: {} }),
    });
    assert.equal(stale.status, 403);
    const staleBody = await stale.json();
    assert.match(staleBody.error || '', /CSRF/i);
    // la cookie vieja ya no autentica (una sesión activa por admin)
    assert.equal((await fetch(`${t.base}/admin/api/me`, { headers: { Cookie: a.cookie } })).status, 401);
    const fresh = await b.call('POST', '/segments', { name: 'con-csrf-nuevo', filters: {} });
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
  } finally { await t.close(); }
});
