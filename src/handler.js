'use strict';
// Handler HTTP reutilizable (Vercel, Netlify y tests). No llama a app.listen ni arranca timers.
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

// Tick invocado por el cron de Netlify (o tests). No usa HTTP ni ADMIN_KEY: corre dentro de la función.
function createScheduledHandler(opts = {}) {
  const hasCustom = opts.handler || opts.cfg || opts.overrides || opts.db || opts.sendNotification || opts.logger;
  const h = opts.handler || (hasCustom ? createHandler(opts) : defaultHandler());
  const { nowIso } = require('./db');
  return async function scheduledTick(_event, context) {
    if (context && typeof context.callbackWaitsForEmptyEventLoop === 'boolean') context.callbackWaitsForEmptyEventLoop = false;
    const { sender, cfg } = await h.ensure();
    const out = await sender.tick({ budgetMs: (opts.budgetMs != null ? opts.budgetMs : cfg.tickBudgetMs) || 8000 });
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: true, at: nowIso(), source: 'schedule', ...out }),
    };
  };
}

// Punto de entrada lazy (se inicializa en el primer pedido / arranque en frío)
function defaultHandler() {
  loadDotEnv();
  return createHandler();
}

module.exports = { createHandler, defaultHandler, createScheduledHandler };
