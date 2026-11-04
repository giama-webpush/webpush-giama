'use strict';
const { randomToken, sha256, safeEqual, verifyPassword, hashPassword } = require('./util');
const { nowIso } = require('./db');

const COOKIE = 'wp_sid';

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function ensureFirstAdmin(db, cfg, logger = console) {
  const n = (await db.get('SELECT COUNT(*) AS n FROM admins')).n;
  if (n > 0) return;
  if (!cfg.adminPassword || cfg.adminPassword.length < 8) {
    logger.warn('[auth] Falta ADMIN_PASSWORD (mínimo 8 caracteres): el panel /admin queda bloqueado hasta configurarlo.');
    return;
  }
  await db.run("INSERT INTO admins(username, pass_hash, role) VALUES(?, ?, 'admin')", cfg.adminUser, hashPassword(cfg.adminPassword));
  logger.log(`[auth] Usuario admin inicial creado: ${cfg.adminUser}`);
}

async function createSession(db, cfg, adminId) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + cfg.sessionHours * 3600e3).toISOString();
  await db.run('INSERT INTO sessions(token_hash, admin_id, csrf, expires_at) VALUES(?,?,?,?)', sha256(token), adminId, csrf, expires);
  await db.run('DELETE FROM sessions WHERE expires_at < ?', nowIso());
  return { token, csrf, expires };
}

function cookieHeader(cfg, token, maxAgeSec) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${cfg.cookieSecure ? '; Secure' : ''}`;
}

async function login(db, cfg, username, password) {
  const admin = await db.get('SELECT * FROM admins WHERE username = ?', String(username || ''));
  // Verifica igual con un hash falso para no revelar si el usuario existe por tiempos
  const ok = admin ? verifyPassword(password, admin.pass_hash) : (verifyPassword(password, hashPassword('x')), false);
  if (!ok) return null;
  await db.run('UPDATE admins SET last_login_at = ? WHERE id = ?', nowIso(), admin.id);
  return { admin, ...(await createSession(db, cfg, admin.id)) };
}

async function sessionFrom(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const s = await db.get('SELECT s.*, a.username, a.role FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?', sha256(token));
  if (!s || s.expires_at < nowIso()) return null;
  return s;
}

// Middleware: exige sesión; en métodos que modifican, exige token CSRF + mismo origen.
function requireAdmin(db, cfg) {
  return async (req, res, next) => {
    const s = await sessionFrom(db, req);
    if (!s) return res.status(401).json({ error: 'Sesión vencida o inexistente' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const h = req.get('x-csrf-token') || '';
      if (!safeEqual(h, s.csrf)) return res.status(403).json({ error: 'Token CSRF inválido' });
      const origin = req.get('origin');
      if (origin && !sameOrigin(origin, req, cfg)) return res.status(403).json({ error: 'Origen no permitido' });
    }
    req.admin = { id: s.admin_id, username: s.username, role: s.role, csrf: s.csrf };
    next();
  };
}

function sameOrigin(origin, req, cfg) {
  try {
    const o = new URL(origin);
    const host = req.get('host');
    return o.host === host || o.origin === new URL(cfg.baseUrl).origin;
  } catch { return false; }
}

function requireRole(role) {
  return (req, res, next) => (req.admin && (req.admin.role === 'admin' || req.admin.role === role) ? next() : res.status(403).json({ error: 'Necesitás rol admin' }));
}

function requireApiKey(cfg) {
  return (req, res, next) => {
    if (!cfg.apiKey) return res.status(503).json({ error: 'API deshabilitada: configurá ADMIN_KEY' });
    const auth = req.get('authorization') || '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7) : (req.get('x-api-key') || '');
    if (!key || !safeEqual(key, cfg.apiKey)) return res.status(401).json({ error: 'API key inválida' });
    next();
  };
}

module.exports = { COOKIE, parseCookies, ensureFirstAdmin, login, sessionFrom, requireAdmin, requireRole, requireApiKey, cookieHeader, sameOrigin };
