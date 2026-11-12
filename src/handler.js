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

// createApp / ensure() devuelven { app, db, sender, ctx } (cfg vive en ctx.cfg).
// Algunos tests inyectan { sender, cfg } directo. Unificamos las dos formas.
function contextFromBoot(boot) {
  if (!boot) throw new Error('El tick programado no pudo inicializar la app');
  const ctx = boot.ctx || boot;
  const sender = boot.sender || ctx.sender;
  const cfg = boot.cfg || ctx.cfg;
  if (!sender || typeof sender.tick !== 'function') {
    throw new Error('El tick programado no pudo obtener el sender');
  }
  if (!cfg) throw new Error('El tick programado no pudo obtener la config');
  return { sender, cfg, db: boot.db || ctx.db, ctx };
}

// Tick invocado por el cron de Netlify (o tests). Mismo arranque que /api/cron/tick
// (loadDotEnv + getConfig + assertStorage + createApp → db Turso/local y sender).
// No usa HTTP ni ADMIN_KEY: corre dentro de la función.
function createScheduledHandler(opts = {}) {
  const hasCustom = opts.handler || opts.cfg || opts.overrides || opts.db || opts.sendNotification || opts.logger;
  const h = opts.handler || (hasCustom ? createHandler(opts) : defaultHandler());
  const { nowIso } = require('./db');
  return async function scheduledTick(_event, context) {
    if (context && typeof context.callbackWaitsForEmptyEventLoop === 'boolean') context.callbackWaitsForEmptyEventLoop = false;
    const { sender } = contextFromBoot(await h.ensure());
    const tickOpts = opts.budgetMs != null ? { budgetMs: opts.budgetMs } : {};
    const out = await sender.tick(tickOpts);
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

module.exports = { createHandler, defaultHandler, createScheduledHandler, contextFromBoot };
