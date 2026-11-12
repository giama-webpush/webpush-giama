'use strict';
// Tope de frecuencia por suscriptor y franja horaria de envío (zona de la app, por defecto Buenos Aires).
const { zonedParts, zonedLocalToUtc } = require('./util');

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizePolicy(settings = {}, timezone = 'America/Argentina/Buenos_Aires') {
  return {
    timezone: timezone || 'America/Argentina/Buenos_Aires',
    perDay: clampInt(settings.freq_cap_per_day, 1, 0, 50),
    perWeek: clampInt(settings.freq_cap_per_week, 2, 0, 100),
    windowStart: clampInt(settings.send_window_start, 9, 0, 24),
    windowEnd: clampInt(settings.send_window_end, 21, 0, 24),
  };
}

function localMinutes(now, timezone) {
  const p = zonedParts(now, timezone);
  return p.hour * 60 + p.minute;
}

// Franja [inicio, fin) en hora local. Si inicio === fin, o 0–24, se envía todo el día.
// Si inicio > fin, la franja cruza medianoche.
function isInSendWindow(policy, now = new Date()) {
  const start = policy.windowStart * 60;
  const end = policy.windowEnd * 60;
  if (start === end || (policy.windowStart === 0 && policy.windowEnd === 24)) return true;
  const minutes = localMinutes(now, policy.timezone);
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function localDayStartIso(now, timezone) {
  const d = zonedParts(now, timezone).date;
  return zonedLocalToUtc(`${d}T00:00`, timezone).toISOString();
}

function weekStartIso(now = new Date()) {
  return new Date(now.getTime() - 7 * 86400e3).toISOString();
}

// Condiciones SQL para no seleccionar a quienes ya llegaron al tope (más el tope por campaña, si hay).
function freqCapSql(policy, now, { campaignHours = 0 } = {}) {
  const parts = [];
  const params = [];
  if (campaignHours > 0) {
    const limit = new Date(now.getTime() - campaignHours * 3600e3).toISOString();
    parts.push('(s.last_push_at IS NULL OR s.last_push_at < ?)');
    params.push(limit);
  }
  if (policy.perDay > 0) {
    parts.push(`(SELECT COUNT(*) FROM sends x WHERE x.subscriber_id = s.id AND IFNULL(x.is_test, 0) = 0 AND x.status = 'sent' AND x.sent_at >= ?) < ?`);
    params.push(localDayStartIso(now, policy.timezone), policy.perDay);
  }
  if (policy.perWeek > 0) {
    parts.push(`(SELECT COUNT(*) FROM sends x WHERE x.subscriber_id = s.id AND IFNULL(x.is_test, 0) = 0 AND x.status = 'sent' AND x.sent_at >= ?) < ?`);
    params.push(weekStartIso(now), policy.perWeek);
  }
  return { sql: parts.join(' AND '), params };
}

module.exports = {
  normalizePolicy, isInSendWindow, localDayStartIso, weekStartIso, freqCapSql, clampInt,
};
