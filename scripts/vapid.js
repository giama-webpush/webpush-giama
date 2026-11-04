'use strict';
// Genera un par de claves VAPID. Uso:
//   npm run vapid            -> escribe VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en .env (si no existen) sin mostrar la privada
//   npm run vapid -- --print -> imprime ambas claves en pantalla (para copiarlas a las variables del hosting). No lo pegues en chats ni tickets.
const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');

const envFile = path.resolve(__dirname, '..', '.env');
const keys = webpush.generateVAPIDKeys();

if (process.argv.includes('--print')) {
  console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
  console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
  console.log('\nGuardalas en las variables de entorno del hosting. Si cambiás las claves, las suscripciones existentes dejan de funcionar.');
  process.exit(0);
}

let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
if (/^VAPID_PRIVATE_KEY=.+$/m.test(content)) {
  console.log('.env ya tiene VAPID_PRIVATE_KEY: no se modifica (cambiar las claves invalida a los suscriptores existentes).');
  process.exit(0);
}
const set = (k, v) => { content = new RegExp(`^${k}=.*$`, 'm').test(content) ? content.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${content}${content && !content.endsWith('\n') ? '\n' : ''}${k}=${v}\n`; };
set('VAPID_PUBLIC_KEY', keys.publicKey);
set('VAPID_PRIVATE_KEY', keys.privateKey);
fs.writeFileSync(envFile, content, { mode: 0o600 });
console.log('Claves VAPID guardadas en .env (la privada no se muestra).');
console.log(`Clave pública: ${keys.publicKey}`);
