'use strict';
const { loadDotEnv, getConfig } = require('./config');
loadDotEnv();
const { createApp } = require('./app');

async function main() {
  const cfg = getConfig();
  const { app, sender, db } = await createApp({ cfg });
  const server = app.listen(cfg.port, cfg.host, () => {
    console.log(`[webpush] escuchando en ${cfg.host}:${cfg.port} · BASE_URL=${cfg.baseUrl} · base: ${db.driver}${db.remote ? '' : ` (${cfg.dbFile})`}`);
    if (!cfg.baseUrl.startsWith('https://') && !/localhost|127\.0\.0\.1/.test(cfg.baseUrl)) {
      console.warn('[webpush] ATENCIÓN: WebPush exige HTTPS en producción (localhost sirve solo para pruebas).');
    }
  });
  // Al arrancar (o despertar) procesa lo atrasado y sigue revisando cada SCHEDULER_INTERVAL_MS mientras esté despierto
  sender.start();

  function shutdown(sig) {
    console.log(`[webpush] ${sig}: cerrando...`);
    sender.stop();
    server.close(() => { try { db.close(); } catch { /* ya cerrada */ } process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => { console.error('[webpush] no pudo arrancar:', e.message); process.exit(1); });
