'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeArPhone, hashPhone, encryptPhone, decryptPhone } = require('../src/phone');

test('normaliza teléfonos argentinos (saca +54, 9, 0 y 15)', () => {
  const casos = {
    '+54 9 11 5555-1234': ['1155551234', '11', 'AMBA'],
    '011 15 5555 1234': ['1155551234', '11', 'AMBA'],
    '1155551234': ['1155551234', '11', 'AMBA'],
    '5491155551234': ['1155551234', '11', 'AMBA'],
    '0351 15 555 1234': ['3515551234', '351', 'Interior'],
    '+54 9 341 555-1234': ['3415551234', '341', 'Interior'],
    '0221 456-7890': ['2214567890', '221', 'Interior'],
    '02954 45-6789': ['2954456789', '2954', 'Interior'],
    '(0261) 15-455-1234': ['2614551234', '261', 'Interior'],
  };
  for (const [input, [nat, area, zona]] of Object.entries(casos)) {
    const r = normalizeArPhone(input);
    assert.equal(r.valid, true, input);
    assert.equal(r.national, nat, input);
    assert.equal(r.area, area, input);
    assert.equal(r.zone, zona, input);
    assert.equal(r.e164, '+549' + nat);
    assert.equal(r.prefix, '0' + area);
  }
});

test('8 dígitos o 15 + 8 dígitos: asume AMBA y lo marca', () => {
  const r = normalizeArPhone('15 5555 1234');
  assert.equal(r.national, '1155551234');
  assert.equal(r.assumedArea, true);
  assert.equal(normalizeArPhone('5555-1234').zone, 'AMBA');
});

test('rechaza números inválidos', () => {
  assert.equal(normalizeArPhone('123').valid, false);
  assert.equal(normalizeArPhone('abc'), null);
  assert.equal(normalizeArPhone(''), null);
  assert.equal(normalizeArPhone('11 5555 12345678').valid, false);
});

test('hash estable y cifrado reversible', () => {
  assert.equal(hashPhone('+5491155551234', 's'), hashPhone('+5491155551234', 's'));
  assert.notEqual(hashPhone('+5491155551234', 's'), hashPhone('+5491155551234', 'otro'));
  const enc = encryptPhone('+5491155551234', 'clave');
  assert.notEqual(enc, '+5491155551234');
  assert.equal(decryptPhone(enc, 'clave'), '+5491155551234');
  assert.equal(decryptPhone(enc, 'mal'), null);
});
