'use strict';
// QR PNG para el presupuesto (Pilot) y para cualquier link de la landing.
// Solo genera códigos a URLs de este servicio (/s), para no prestar el endpoint a terceros.
const QRCode = require('qrcode');

const LANDING_PARAMS = [
  'marca', 'modelo', 'tel', 'asesor', 'origen', 'campana',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'tags', 'cotiz', 'cotizacion',
];

function allowedHosts(cfg) {
  const set = new Set(['webpush-giama.netlify.app', 'localhost', '127.0.0.1']);
  try { set.add(new URL(cfg.baseUrl).hostname.toLowerCase()); } catch { /* ignore */ }
  return set;
}

function allowedLandingUrl(cfg, raw) {
  if (raw == null || String(raw).trim() === '') return null;
  let u;
  try { u = new URL(String(raw), cfg.baseUrl); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!allowedHosts(cfg).has(u.hostname.toLowerCase())) return null;
  const p = u.pathname;
  if (p !== '/s' && p !== '/s/' && p !== '/') return null;
  return u.toString();
}

function landingFromQuery(cfg, query = {}) {
  if (query.u) {
    const allowed = allowedLandingUrl(cfg, query.u);
    if (!allowed) {
      const err = new Error('El QR solo se genera para la landing de este sitio (/s)');
      err.status = 400;
      throw err;
    }
    return allowed;
  }
  const u = new URL('/s', cfg.baseUrl);
  let any = false;
  for (const k of LANDING_PARAMS) {
    const v = query[k];
    if (v == null || String(v).trim() === '') continue;
    u.searchParams.set(k, String(v).slice(0, 120));
    any = true;
  }
  if (!any) {
    const err = new Error('Falta el destino del QR: pasá u= o los parámetros de la landing');
    err.status = 400;
    throw err;
  }
  return u.toString();
}

function qrSize(query = {}) {
  const n = Number(query.size || query.s || 240);
  if (!Number.isFinite(n)) return 240;
  return Math.max(128, Math.min(512, Math.round(n)));
}

async function qrPngBuffer(text, size) {
  return QRCode.toBuffer(text, {
    type: 'png',
    width: size,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}

module.exports = { allowedLandingUrl, landingFromQuery, qrSize, qrPngBuffer, LANDING_PARAMS };
