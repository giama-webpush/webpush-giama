'use strict';
// Handler HTTP reutilizable (Vercel serverless y tests). No llama a app.listen ni arranca timers.
const { loadDotEnv, getConfig, assertStorage } = require('./config');
const { createApp } = require('./app');

function createHandler(opts = {}) {
  let boot = null;

  function ensure() {
    if (!boot) {
      boot = (async () => {
        const cfg = opts.cfg || getConfig(opts.overrides || {});
        assertStorage(cfg);
        return createApp({
          cfg,
          db: opts.db,
          sendNotification: opts.sendNotification,
          logger: opts.logger,
        });
      })();
    }
    return boot;
  }

  async function handler(req, res) {
    const { app } = await ensure();
    return app(req, res);
  }

  handler.ensure = ensure;
  handler.reset = () => { boot = null; };
  return handler;
}

// Punto de entrada de Vercel: un único handler lazy (se inicializa en el primer pedido / arranque en frío)
function defaultHandler() {
  loadDotEnv();
  return createHandler();
}

module.exports = { createHandler, defaultHandler };
