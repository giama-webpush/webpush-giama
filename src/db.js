'use strict';
// Capa de acceso a datos asíncrona con dos drivers intercambiables:
//  - libsql (por defecto): @libsql/client. Si hay TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) usa Turso;
//    si no, un archivo local SQLite en DB_PATH (url file:).
//  - node-sqlite: node:sqlite integrado (DB_DRIVER=node-sqlite), sin dependencias nativas.
// La app usa solo: get, all, run, exec, batch, tx, close. Todo SQL es SQLite estándar.
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',          -- active | unsubscribed | dead
  manage_token TEXT NOT NULL UNIQUE,              -- para darse de baja sin login
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  unsubscribed_at TEXT,
  last_push_at TEXT,
  device_type TEXT, os TEXT, browser TEXT,
  lang TEXT, timezone TEXT,
  marca TEXT, modelo TEXT, origen TEXT, campana TEXT, asesor TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
  phone_area TEXT, phone_zone TEXT, phone_region TEXT,
  phone_hash TEXT, phone_enc TEXT,
  sub_local_date TEXT, sub_hour INTEGER, sub_weekday INTEGER, sub_daypart TEXT,
  landing_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_sub_status ON subscribers(status);
CREATE INDEX IF NOT EXISTS idx_sub_marca_modelo ON subscribers(marca, modelo);
CREATE INDEX IF NOT EXISTS idx_sub_zone ON subscribers(phone_zone, phone_area);
CREATE INDEX IF NOT EXISTS idx_sub_created ON subscribers(created_at);
CREATE INDEX IF NOT EXISTS idx_sub_phone_hash ON subscribers(phone_hash);

CREATE TABLE IF NOT EXISTS subscriber_tags (
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (subscriber_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON subscriber_tags(tag);

CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  filters TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS pieces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  image TEXT, icon TEXT,
  url TEXT NOT NULL,
  actions TEXT NOT NULL DEFAULT '[]',              -- [{title, url}] máx 2
  utm_auto INTEGER NOT NULL DEFAULT 1,
  require_interaction INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'manual',             -- manual | auto | api
  piece_id INTEGER NOT NULL REFERENCES pieces(id),
  segment_id INTEGER REFERENCES segments(id) ON DELETE SET NULL,
  filters TEXT NOT NULL DEFAULT '{}',              -- copia de filtros al lanzar
  status TEXT NOT NULL DEFAULT 'borrador',         -- borrador | programada | enviando | finalizada | cancelada | automatica
  scheduled_at TEXT,                               -- UTC ISO
  started_at TEXT, finished_at TEXT,
  ttl INTEGER NOT NULL DEFAULT 86400,
  urgency TEXT NOT NULL DEFAULT 'normal',          -- very-low | low | normal | high
  freq_cap_hours INTEGER NOT NULL DEFAULT 0,
  total_targeted INTEGER NOT NULL DEFAULT 0,
  skipped_freq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_campaign_status ON campaigns(status, scheduled_at);

CREATE TABLE IF NOT EXISTS sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  is_test INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',           -- queued | sent | failed | dead | cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  http_status INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT, delivered_at TEXT, clicked_at TEXT, click_action TEXT, closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sends_campaign ON sends(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_sends_sub ON sends(subscriber_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sends_unique ON sends(campaign_id, subscriber_id) WHERE is_test = 0;

CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                              -- welcome | recontact
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  piece_id INTEGER REFERENCES pieces(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  days INTEGER NOT NULL DEFAULT 0,
  filters TEXT NOT NULL DEFAULT '{}',
  enabled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Imágenes subidas desde el panel (en la base para no depender del disco del hosting)
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  name TEXT,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER, height INTEGER,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor TEXT, action TEXT, detail TEXT
);
`;

function normArgs(args) {
  return args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a));
}

// Mutex simple para serializar transacciones dentro del proceso
function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}

function fixRow(row) {
  if (!row) return row;
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v instanceof ArrayBuffer) row[k] = Buffer.from(v);
    else if (typeof v === 'bigint') row[k] = Number(v);
  }
  return row;
}

function libsqlAdapter({ url, authToken }) {
  const { createClient } = require('@libsql/client');
  const client = createClient({ url, authToken: authToken || undefined, intMode: 'number' });
  const lock = createLock();
  const toObj = (rs) => rs.rows.map((r) => fixRow(Object.fromEntries(rs.columns.map((c, i) => [c, r[i]]))));
  const wrap = (exec) => ({
    async get(sql, ...args) { return toObj(await exec({ sql, args: normArgs(args) }))[0]; },
    async all(sql, ...args) { return toObj(await exec({ sql, args: normArgs(args) })); },
    async run(sql, ...args) { const rs = await exec({ sql, args: normArgs(args) }); return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid) }; },
  });
  // Reintento ante SQLITE_BUSY (archivo local con transacción abierta en otra conexión)
  const execRetry = async (st) => {
    for (let i = 0; ; i++) {
      try { return await client.execute(st); } catch (e) {
        if (i < 20 && /SQLITE_BUSY|database is locked/i.test(String(e && (e.code || e.message)))) { await new Promise((r) => setTimeout(r, 25 * (i + 1))); continue; }
        throw e;
      }
    }
  };
  const base = wrap(execRetry);
  return {
    driver: url.startsWith('file:') ? 'libsql-archivo' : 'libsql-turso',
    remote: !url.startsWith('file:'),
    ...base,
    async exec(sql) { await client.executeMultiple(sql); },
    async batch(stmts) { await client.batch(stmts.map(([sql, args = []]) => ({ sql, args: normArgs(args) })), 'write'); },
    tx(fn) {
      return lock(async () => {
        const t = await client.transaction('write');
        try { const r = await fn(wrap((st) => t.execute(st))); await t.commit(); return r; } catch (e) { try { await t.rollback(); } catch { /* ya cerrada */ } throw e; } finally { t.close(); }
      });
    },
    close() { client.close(); },
  };
}

function nodeSqliteAdapter(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  const lock = createLock();
  let inTx = false;
  const raw = {
    get: (sql, args) => fixRow(db.prepare(sql).get(...normArgs(args))),
    all: (sql, args) => db.prepare(sql).all(...normArgs(args)).map(fixRow),
    run: (sql, args) => { const r = db.prepare(sql).run(...normArgs(args)); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
  };
  // Fuera de una transacción, esperar a que termine la que esté abierta
  const guard = (f) => (inTx ? lock(f) : Promise.resolve().then(f));
  const txApi = { get: async (s, ...a) => raw.get(s, a), all: async (s, ...a) => raw.all(s, a), run: async (s, ...a) => raw.run(s, a) };
  return {
    driver: 'node-sqlite', remote: false,
    get: (s, ...a) => guard(() => raw.get(s, a)),
    all: (s, ...a) => guard(() => raw.all(s, a)),
    run: (s, ...a) => guard(() => raw.run(s, a)),
    async exec(sql) { await guard(() => db.exec(sql)); },
    batch(stmts) { return lock(() => { db.exec('BEGIN'); try { for (const [s, a = []] of stmts) raw.run(s, a); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }); },
    tx(fn) {
      return lock(async () => {
        inTx = true; db.exec('BEGIN IMMEDIATE');
        try { const r = await fn(txApi); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { inTx = false; }
      });
    },
    close() { db.close(); },
  };
}

/**
 * Abre la base y crea/actualiza el esquema.
 * opts: { tursoUrl, tursoToken, file, driver }
 */
async function openDb(opts = {}) {
  const driver = opts.driver || process.env.DB_DRIVER || 'libsql';
  let db;
  if (opts.tursoUrl) {
    db = libsqlAdapter({ url: opts.tursoUrl, authToken: opts.tursoToken });
  } else {
    const file = opts.file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    db = driver === 'node-sqlite' ? nodeSqliteAdapter(file) : libsqlAdapter({ url: file === ':memory:' ? ':memory:' : `file:${file}` });
    try { await db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;'); } catch { /* no crítico */ }
  }
  await db.exec(SCHEMA);
  return db;
}

function nowIso() { return new Date().toISOString(); }

async function getSetting(db, key, def = null) {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : def;
}
async function setSetting(db, key, value) {
  await db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value == null ? null : String(value));
}
async function getSettings(db, keys) {
  const rows = await db.all(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`, ...keys);
  const out = Object.fromEntries(keys.map((k) => [k, null]));
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function audit(db, actor, action, detail) {
  try { await db.run('INSERT INTO audit_log(actor, action, detail) VALUES(?,?,?)', actor || null, action, detail ? JSON.stringify(detail).slice(0, 2000) : null); } catch { /* el log no debe romper la operación */ }
}

module.exports = { openDb, nowIso, getSetting, setSetting, getSettings, audit, SCHEMA };
