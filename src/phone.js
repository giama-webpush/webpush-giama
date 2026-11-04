'use strict';
// Normalización de teléfonos argentinos y derivación de área / zona.
// Número nacional argentino = código de área (2 a 4 dígitos, sin 0) + abonado = 10 dígitos.
// Se aceptan formas como: +54 9 11 5555-1234, 011 15 5555 1234, 1155551234, 0351 15 555 1234.
const crypto = require('node:crypto');

// Códigos de área principales (no exhaustivo). zona: AMBA (011) o Interior.
const AREAS = {
  '11': ['AMBA', 'CABA y GBA'],
  '220': ['Interior', 'Buenos Aires (Merlo)'], '221': ['Interior', 'Buenos Aires (La Plata)'], '223': ['Interior', 'Buenos Aires (Mar del Plata)'],
  '230': ['Interior', 'Buenos Aires (Pilar)'], '236': ['Interior', 'Buenos Aires (Junín)'], '237': ['Interior', 'Buenos Aires (Moreno)'],
  '249': ['Interior', 'Buenos Aires (Tandil)'], '260': ['Interior', 'Mendoza (San Rafael)'], '261': ['Interior', 'Mendoza'],
  '263': ['Interior', 'Mendoza (San Martín)'], '264': ['Interior', 'San Juan'], '266': ['Interior', 'San Luis'],
  '280': ['Interior', 'Chubut (Trelew)'], '291': ['Interior', 'Buenos Aires (Bahía Blanca)'], '294': ['Interior', 'Río Negro (Bariloche)'],
  '297': ['Interior', 'Chubut (Comodoro Rivadavia)'], '298': ['Interior', 'Río Negro (General Roca)'], '299': ['Interior', 'Neuquén'],
  '336': ['Interior', 'Buenos Aires (San Nicolás)'], '341': ['Interior', 'Santa Fe (Rosario)'], '342': ['Interior', 'Santa Fe'],
  '343': ['Interior', 'Entre Ríos (Paraná)'], '345': ['Interior', 'Entre Ríos (Concordia)'], '348': ['Interior', 'Buenos Aires (Escobar)'],
  '351': ['Interior', 'Córdoba'], '353': ['Interior', 'Córdoba (Villa María)'], '358': ['Interior', 'Córdoba (Río Cuarto)'],
  '362': ['Interior', 'Chaco (Resistencia)'], '364': ['Interior', 'Chaco (Sáenz Peña)'], '370': ['Interior', 'Formosa'],
  '376': ['Interior', 'Misiones (Posadas)'], '379': ['Interior', 'Corrientes'], '380': ['Interior', 'La Rioja'],
  '381': ['Interior', 'Tucumán'], '383': ['Interior', 'Catamarca'], '385': ['Interior', 'Santiago del Estero'],
  '387': ['Interior', 'Salta'], '388': ['Interior', 'Jujuy'],
  '2202': ['Interior', 'Buenos Aires (González Catán)'], '2254': ['Interior', 'Buenos Aires (Pinamar)'], '2255': ['Interior', 'Buenos Aires (Villa Gesell)'],
  '2262': ['Interior', 'Buenos Aires (Necochea)'], '2284': ['Interior', 'Buenos Aires (Olavarría)'], '2314': ['Interior', 'Buenos Aires (Bolívar)'],
  '2320': ['Interior', 'Buenos Aires (José C. Paz)'], '2324': ['Interior', 'Buenos Aires (Mercedes)'], '2346': ['Interior', 'Buenos Aires (Chivilcoy)'],
  '2392': ['Interior', 'Buenos Aires (Trenque Lauquen)'], '2477': ['Interior', 'Buenos Aires (Pergamino)'], '2901': ['Interior', 'Tierra del Fuego (Ushuaia)'],
  '2920': ['Interior', 'Río Negro (Viedma)'], '2954': ['Interior', 'La Pampa (Santa Rosa)'], '2966': ['Interior', 'Santa Cruz (Río Gallegos)'],
  '2965': ['Interior', 'Chubut (Puerto Madryn)'], '3404': ['Interior', 'Santa Fe (San Carlos)'], '3446': ['Interior', 'Entre Ríos (Gualeguaychú)'],
  '3456': ['Interior', 'Entre Ríos (Chajarí)'], '3482': ['Interior', 'Santa Fe (Reconquista)'], '3492': ['Interior', 'Santa Fe (Rafaela)'],
  '3543': ['Interior', 'Córdoba (Villa Carlos Paz)'], '3564': ['Interior', 'Córdoba (San Francisco)'], '3571': ['Interior', 'Córdoba (Río Tercero)'],
  '3584': ['Interior', 'Córdoba (Bell Ville)'], '3755': ['Interior', 'Misiones (Oberá)'], '3757': ['Interior', 'Misiones (Puerto Iguazú)'],
  '3794': ['Interior', 'Corrientes (Goya)'], '3865': ['Interior', 'Tucumán (Concepción)'], '3876': ['Interior', 'Salta (Tartagal)'],
};

function normalizeArPhone(input) {
  if (input == null) return null;
  let d = String(input).replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('54') && d.length >= 12) {
    d = d.slice(2);
    if (d.startsWith('9') && d.length === 11) d = d.slice(1);
  }
  if (d.startsWith('0')) d = d.slice(1);
  // 8 dígitos sin área (o 15 + 8): se asume AMBA, marcado como asumido
  let assumed = false;
  if (d.length === 10 && d.startsWith('15')) { d = '11' + d.slice(2); assumed = true; }
  else if (d.length === 8) { d = '11' + d; assumed = true; }

  let area = null;
  for (const len of [4, 3, 2]) {
    const pre = d.slice(0, len);
    if (AREAS[pre]) {
      let rest = d.slice(len);
      if (rest.startsWith('15') && len + rest.length - 2 === 10) rest = rest.slice(2);
      if (len + rest.length === 10) { area = pre; d = pre + rest; break; }
    }
  }
  if (d.length !== 10) return { valid: false, input: String(input) };
  const info = area ? AREAS[area] : null;
  if (!area) {
    // Área no está en la tabla: se guarda sin área exacta.
    area = null;
  }
  return {
    valid: true,
    national: d,
    e164: '+549' + d,
    area,                                   // ej. '11', '351'
    prefix: area ? '0' + area : null,       // ej. '011', '0351'
    zone: d.startsWith('11') ? 'AMBA' : 'Interior',
    region: info ? info[1] : 'Sin identificar',
    assumedArea: assumed,
  };
}

function hashPhone(e164, secret) {
  if (!secret) throw new Error('PHONE_HASH_SECRET no configurado');
  return crypto.createHmac('sha256', secret).update(e164).digest('hex');
}

function keyFrom(secret) { return crypto.createHash('sha256').update(String(secret)).digest(); }

function encryptPhone(e164, secret) {
  if (!secret) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([c.update(e164, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function decryptPhone(payload, secret) {
  if (!payload || !secret) return null;
  try {
    const [iv, tag, enc] = payload.split('.').map((x) => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch { return null; }
}

module.exports = { normalizeArPhone, hashPhone, encryptPhone, decryptPhone, AREAS };
