'use strict';
// Filtros combinables de público -> SQL parametrizado.
// Entre campos distintos: Y (AND). Dentro de un mismo campo con varios valores: O (OR).

const LIST_FIELDS = {
  marca: 's.marca', modelo: 's.modelo', zona: 's.phone_zone', area: 's.phone_area', region: 's.phone_region',
  device: 's.device_type', os: 's.os', browser: 's.browser', origen: 's.origen', campana: 's.campana',
  asesor: 's.asesor', daypart: 's.sub_daypart', lang: 's.lang', utm_source: 's.utm_source', utm_campaign: 's.utm_campaign',
};

function toList(v) {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 100);
}

function normalizeFilters(f = {}) {
  const out = {};
  for (const k of Object.keys(LIST_FIELDS)) { const l = toList(f[k]); if (l.length) out[k] = l; }
  for (const k of ['tags', 'exclude_tags']) { const l = toList(f[k]).map((t) => t.toLowerCase()); if (l.length) out[k] = l; }
  if (f.tags_mode === 'all') out.tags_mode = 'all';
  if (f.status && ['active', 'unsubscribed', 'dead', 'all'].includes(f.status)) out.status = f.status;
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.desde || '')) out.desde = f.desde;
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.hasta || '')) out.hasta = f.hasta;
  if (f.has_phone === true || f.has_phone === 'true' || f.has_phone === '1') out.has_phone = true;
  if (f.has_phone === false || f.has_phone === 'false' || f.has_phone === '0') out.has_phone = false;
  if (f.q) out.q = String(f.q).slice(0, 80);
  if (f.ids) { const ids = toList(f.ids).map(Number).filter((n) => Number.isInteger(n) && n > 0); if (ids.length) out.ids = ids.slice(0, 5000); }
  return out;
}

function buildWhere(filters, { defaultStatus = 'active' } = {}) {
  const f = normalizeFilters(filters);
  const where = []; const params = [];
  const status = f.status || defaultStatus;
  if (status !== 'all') { where.push('s.status = ?'); params.push(status); }
  for (const [k, col] of Object.entries(LIST_FIELDS)) {
    if (!f[k]) continue;
    const vals = f[k];
    const parts = [];
    for (const v of vals) {
      if (v === '(vacío)') parts.push(`(${col} IS NULL OR ${col} = '')`);
      else { parts.push(`${col} = ? COLLATE NOCASE`); params.push(v); }
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  if (f.tags) {
    if (f.tags_mode === 'all') {
      for (const t of f.tags) { where.push('EXISTS (SELECT 1 FROM subscriber_tags t WHERE t.subscriber_id = s.id AND t.tag = ?)'); params.push(t); }
    } else {
      where.push(`EXISTS (SELECT 1 FROM subscriber_tags t WHERE t.subscriber_id = s.id AND t.tag IN (${f.tags.map(() => '?').join(',')}))`);
      params.push(...f.tags);
    }
  }
  if (f.exclude_tags) {
    where.push(`NOT EXISTS (SELECT 1 FROM subscriber_tags t WHERE t.subscriber_id = s.id AND t.tag IN (${f.exclude_tags.map(() => '?').join(',')}))`);
    params.push(...f.exclude_tags);
  }
  if (f.desde) { where.push('s.sub_local_date >= ?'); params.push(f.desde); }
  if (f.hasta) { where.push('s.sub_local_date <= ?'); params.push(f.hasta); }
  if (f.has_phone === true) where.push('s.phone_hash IS NOT NULL');
  if (f.has_phone === false) where.push('s.phone_hash IS NULL');
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, '')}%`;
    where.push('(s.marca LIKE ? OR s.modelo LIKE ? OR s.asesor LIKE ? OR s.campana LIKE ? OR s.origen LIKE ? OR s.phone_region LIKE ? OR CAST(s.id AS TEXT) = ? OR EXISTS (SELECT 1 FROM subscriber_tags t WHERE t.subscriber_id = s.id AND t.tag LIKE ?))');
    params.push(like, like, like, like, like, like, f.q, like);
  }
  if (f.ids) { where.push(`s.id IN (${f.ids.map(() => '?').join(',')})`); params.push(...f.ids); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params, filters: f };
}

async function countSegment(db, filters) {
  const w = buildWhere(filters);
  return (await db.get(`SELECT COUNT(*) AS n FROM subscribers s ${w.sql}`, ...w.params)).n;
}

function describeFilters(filters) {
  const f = normalizeFilters(filters);
  const labels = { marca: 'Marca', modelo: 'Modelo', zona: 'Zona', area: 'Área', region: 'Región', device: 'Dispositivo', os: 'SO', browser: 'Navegador', origen: 'Origen', campana: 'Campaña', asesor: 'Asesor', daypart: 'Franja', lang: 'Idioma', utm_source: 'utm_source', utm_campaign: 'utm_campaign' };
  const parts = [];
  for (const [k, l] of Object.entries(labels)) if (f[k]) parts.push(`${l}: ${f[k].join(' o ')}`);
  if (f.tags) parts.push(`Etiquetas (${f.tags_mode === 'all' ? 'todas' : 'alguna'}): ${f.tags.join(', ')}`);
  if (f.exclude_tags) parts.push(`Sin etiquetas: ${f.exclude_tags.join(', ')}`);
  if (f.desde || f.hasta) parts.push(`Alta: ${f.desde || '...'} a ${f.hasta || '...'}`);
  if (f.has_phone !== undefined) parts.push(f.has_phone ? 'Con teléfono' : 'Sin teléfono');
  if (f.q) parts.push(`Búsqueda: ${f.q}`);
  if (f.ids) parts.push(`${f.ids.length} suscriptores elegidos`);
  return parts.length ? parts.join(' · ') : 'Todos los suscriptores activos';
}

module.exports = { buildWhere, countSegment, normalizeFilters, describeFilters, LIST_FIELDS };
