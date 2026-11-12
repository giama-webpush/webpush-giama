'use strict';
// Recupera el body y las cookies cuando la app corre detrás de serverless-http (Netlify).
// body-parser (express.json / raw / urlencoded) llama a onFinished.isFinished(req) y, con
// el IncomingMessage sintético de serverless-http (complete=true, socket.readable=false),
// cree que el pedido ya terminó y no lee el stream. El body queda como Buffer en req.body
// y el login (y el resto de los POST) ven un objeto vacío.
const querystring = require('node:querystring');

function contentType(req) {
  const raw = (req.headers && (req.headers['content-type'] || req.headers['Content-Type'])) || '';
  return String(raw).split(';')[0].trim().toLowerCase();
}

function asBuffer(value, base64) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, base64 ? 'base64' : 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function looksLikeJson(buf) {
  let i = 0;
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
  return buf[i] === 0x7b || buf[i] === 0x5b; // { o [
}

function parseRawBody(raw, ct, { base64 = false } = {}) {
  const buf = asBuffer(raw, base64);
  if (!buf) return { kind: 'empty', value: raw };
  const type = (ct || '').split(';')[0].trim().toLowerCase();

  if (type === 'application/json' || type === 'text/json' || type.endsWith('+json') || (!type && looksLikeJson(buf))) {
    if (!buf.length) return { kind: 'json', value: {} };
    try {
      return { kind: 'json', value: JSON.parse(buf.toString('utf8')) };
    } catch (e) {
      const err = new Error('JSON inválido');
      err.status = 400;
      err.type = 'entity.parse.failed';
      throw err;
    }
  }
  if (type === 'application/x-www-form-urlencoded') {
    return { kind: 'form', value: querystring.parse(buf.toString('utf8')) };
  }
  if (type.startsWith('image/') || type === 'application/octet-stream' || type.startsWith('application/pdf') || type.startsWith('multipart/')) {
    return { kind: 'binary', value: buf };
  }
  if (!type && buf.length) return { kind: 'binary', value: buf };
  return { kind: 'binary', value: buf };
}

// Middleware de Express: si req.body ya es Buffer/string (o JSON stringificado), lo parsea.
// Si req.body no está, deja que express.json lea el stream (local / Docker / Vercel).
function recoverServerlessBody(req, res, next) {
  const raw = req.body;
  if (raw == null || raw === '') return next();
  if (typeof raw === 'object' && !Buffer.isBuffer(raw) && !Array.isArray(raw) && !(raw instanceof Uint8Array)) return next();
  try {
    const out = parseRawBody(raw, contentType(req));
    req.body = out.value;
    return next();
  } catch (err) {
    return next(err);
  }
}

function clientIp(req, event) {
  const h = (req && req.headers) || {};
  const evh = (event && event.headers) || {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = h[k] || h[k.toLowerCase()] || evh[k] || evh[k.toLowerCase()];
      if (v) return String(Array.isArray(v) ? v[0] : v).split(',')[0].trim();
    }
    return '';
  };
  return pick('x-forwarded-for', 'x-nf-client-connection-ip', 'client-ip') || (event && event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp) || '';
}

// Hook `request` de serverless-http: path, IP y Content-Type si el body parece JSON.
function prepareServerlessRequest(req, event) {
  if (!req.ip) {
    const ip = clientIp(req, event);
    if (ip) req.ip = ip;
  }
  const ct = contentType(req);
  const raw = (event && event.body) || req.body;
  const buf = asBuffer(raw, !!(event && event.isBase64Encoded));
  if (!ct && buf && looksLikeJson(buf)) {
    req.headers = req.headers || {};
    req.headers['content-type'] = 'application/json; charset=utf-8';
  }
}

// Netlify a menudo solo aplica `headers` (no multiValueHeaders). El Set-Cookie de Express
// sale como array y serverless-http lo deja solo en multiValueHeaders, así que lo copiamos.
function normalizeLambdaResponse(res) {
  if (!res || typeof res !== 'object') return res;
  const headers = { ...(res.headers || {}) };
  const multiValueHeaders = { ...(res.multiValueHeaders || {}) };
  const from = (obj, name) => {
    const key = Object.keys(obj).find((k) => k.toLowerCase() === name);
    return key ? obj[key] : undefined;
  };
  let cookies = from(multiValueHeaders, 'set-cookie') || from(headers, 'set-cookie');
  if (cookies == null && Array.isArray(res.cookies)) cookies = res.cookies;
  if (cookies == null) return res;
  const list = (Array.isArray(cookies) ? cookies : [cookies]).map(String).filter(Boolean);
  if (!list.length) return res;
  multiValueHeaders['set-cookie'] = list;
  // Netlify acepta un string o un array en headers['set-cookie']
  headers['set-cookie'] = list.length === 1 ? list[0] : list;
  const out = { ...res, headers, multiValueHeaders };
  return out;
}

module.exports = {
  recoverServerlessBody,
  parseRawBody,
  prepareServerlessRequest,
  normalizeLambdaResponse,
  clientIp,
};
