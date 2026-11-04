'use strict';
// Claves VAPID y secreto de hash de teléfono.
// Prioridad: variables de entorno. Si faltan, se generan una vez y se guardan en la tabla settings
// (claves internas que empiezan con "_", nunca expuestas por la API ni impresas en logs),
// para que `npm start` funcione sin pasos extra incluso en hostings sin disco persistente.
const crypto = require('node:crypto');
const webpush = require('web-push');
const { getSetting, setSetting } = require('./db');

async function loadOrCreateSecrets(db, cfg, logger = console) {
  const out = { vapidSource: 'variables de entorno' };
  if (cfg.vapidPublicKey && cfg.vapidPrivateKey) {
    out.vapidPublicKey = cfg.vapidPublicKey; out.vapidPrivateKey = cfg.vapidPrivateKey;
  } else {
    let pub = await getSetting(db, '_vapid_public'); let priv = await getSetting(db, '_vapid_private');
    if (!pub || !priv) {
      const k = webpush.generateVAPIDKeys();
      pub = k.publicKey; priv = k.privateKey;
      await setSetting(db, '_vapid_public', pub); await setSetting(db, '_vapid_private', priv);
      logger.warn('[vapid] No hay VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY en el entorno: se generaron y guardaron en la base. Para producción, definilas como variables de entorno (npm run vapid).');
    }
    out.vapidPublicKey = pub; out.vapidPrivateKey = priv; out.vapidSource = 'base de datos (generadas automáticamente)';
  }
  if (cfg.phoneHashSecret) out.phoneHashSecret = cfg.phoneHashSecret;
  else {
    let s = await getSetting(db, '_phone_hash_secret');
    if (!s) { s = crypto.randomBytes(32).toString('base64url'); await setSetting(db, '_phone_hash_secret', s); }
    out.phoneHashSecret = s;
  }
  return out;
}

module.exports = { loadOrCreateSecrets };
