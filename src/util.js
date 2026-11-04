'use strict';
const crypto = require('node:crypto');

function randomToken(bytes = 24) { return crypto.randomBytes(bytes).toString('base64url'); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// Hash de contraseña con scrypt (incluido en Node)
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, s, h] = stored.split('$');
  const hash = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(h, 'base64'));
}

// Rate limit en memoria por clave (ventana fija). Suficiente para un único servidor.
function rateLimiter({ windowMs, max, keyFn }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const key = (keyFn ? keyFn(req) : req.ip) || 'x';
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset < now) { e = { n: 0, reset: now + windowMs }; hits.set(key, e); }
    e.n += 1;
    if (e.n > max) {
      res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ error: 'Demasiados pedidos, probá en un rato.' });
    }
    next();
  };
}

// Limpia texto corto de entrada
function clean(v, max = 120) {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}
function cleanUpper(v, max = 60) { const s = clean(v, max); return s ? s.toUpperCase() : null; }

function normTag(t) {
  const s = clean(t, 60);
  if (!s) return null;
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9:_\-. ]/g, '').replace(/\s+/g, '-');
}

// Partes de fecha/hora en una zona horaria
function zonedParts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), weekday: wd };
}

function daypart(h) { return h < 6 ? 'madrugada' : h < 12 ? 'mañana' : h < 19 ? 'tarde' : 'noche'; }

// Convierte "YYYY-MM-DDTHH:mm" interpretado en timeZone a Date UTC.
function zonedLocalToUtc(local, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(local || ''));
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(...p.date.split('-').map((x, j) => (j === 1 ? Number(x) - 1 : Number(x))), p.hour, p.minute);
    guess += Date.UTC(y, mo - 1, d, h, mi) - asUtc;
  }
  return new Date(guess);
}

function isHttpUrl(u, { allowRelative = false } = {}) {
  if (!u) return false;
  if (allowRelative && /^\/(?!\/)/.test(u)) return true;
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:'; } catch { return false; }
}

function csvEscape(v) {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // evita inyección de fórmulas en Excel
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = { randomToken, sha256, safeEqual, hashPassword, verifyPassword, rateLimiter, clean, cleanUpper, normTag, zonedParts, daypart, zonedLocalToUtc, isHttpUrl, csvEscape };
