'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePolicy, isInSendWindow, freqCapSql } = require('../src/send-policy');

const TZ = 'America/Argentina/Buenos_Aires';
const policy = (extra = {}) => normalizePolicy({
  freq_cap_per_day: '1', freq_cap_per_week: '2',
  send_window_start: '9', send_window_end: '21', ...extra,
}, TZ);

test('isInSendWindow: de 9 a 21 hora de Buenos Aires', () => {
  const p = policy();
  assert.equal(isInSendWindow(p, new Date('2026-11-12T09:00:00-03:00')), true);
  assert.equal(isInSendWindow(p, new Date('2026-11-12T10:30:00-03:00')), true);
  assert.equal(isInSendWindow(p, new Date('2026-11-12T20:59:00-03:00')), true);
  assert.equal(isInSendWindow(p, new Date('2026-11-12T21:00:00-03:00')), false);
  assert.equal(isInSendWindow(p, new Date('2026-11-12T22:30:00-03:00')), false);
  assert.equal(isInSendWindow(p, new Date('2026-11-12T08:59:00-03:00')), false);
  assert.equal(isInSendWindow(p, new Date('2026-11-13T00:15:00-03:00')), false);
});

test('isInSendWindow: 0-24 o inicio=fin deja envíos todo el día', () => {
  assert.equal(isInSendWindow(policy({ send_window_start: '0', send_window_end: '24' }), new Date('2026-11-12T03:00:00-03:00')), true);
  assert.equal(isInSendWindow(policy({ send_window_start: '0', send_window_end: '0' }), new Date('2026-11-12T23:00:00-03:00')), true);
});

test('isInSendWindow: franja que cruza medianoche', () => {
  const p = policy({ send_window_start: '21', send_window_end: '9' });
  assert.equal(isInSendWindow(p, new Date('2026-11-12T21:00:00-03:00')), true);
  assert.equal(isInSendWindow(p, new Date('2026-11-13T00:30:00-03:00')), true);
  assert.equal(isInSendWindow(p, new Date('2026-11-13T08:59:00-03:00')), true);
  assert.equal(isInSendWindow(p, new Date('2026-11-13T09:00:00-03:00')), false);
  assert.equal(isInSendWindow(p, new Date('2026-11-12T20:00:00-03:00')), false);
});

test('freqCapSql incluye tope diario, semanal y el de la campaña', () => {
  const p = policy();
  const now = new Date('2026-11-12T15:00:00-03:00');
  const cap = freqCapSql(p, now, { campaignHours: 24 });
  assert.match(cap.sql, /last_push_at/);
  assert.equal(cap.params.length, 5); // campaign limit, day start, 1, week start, 2
  assert.equal(cap.params[1], '2026-11-12T03:00:00.000Z'); // 00:00 BA = 03:00 UTC (no DST in Nov 2026)
  assert.equal(cap.params[2], 1);
  assert.equal(cap.params[4], 2);
  const off = freqCapSql(normalizePolicy({ freq_cap_per_day: '0', freq_cap_per_week: '0', send_window_start: '9', send_window_end: '21' }, TZ), now, {});
  assert.equal(off.sql, '');
  assert.deepEqual(off.params, []);
});
