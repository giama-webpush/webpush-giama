'use strict';
// Cron de Netlify (plan Free, todos los planes): cada 5 minutos llama al tick
// en directo (sin HTTP ni ADMIN_KEY). El schedule está en netlify.toml y en exports.config.
// Solo corre solo en deploys publicados (no en Deploy Preview). Tope 30 s; el tick usa ~8 s y retoma.
//
// Exports: `handler` (Lambda v1 / tests), `default` (runtime v2 / "Run now" de Netlify)
// y `config.schedule`. Siempre se deja un console.log del resultado para verlo en Functions → Logs.
const { createScheduledHandler } = require('../../src/handler');

const scheduled = createScheduledHandler();

async function run(event, context) {
  const started = new Date().toISOString();
  console.log('[tick-scheduled] inicio', started);
  try {
    const res = await scheduled(event, context);
    const body = res && typeof res.body === 'string' ? res.body : JSON.stringify(res || {});
    console.log('[tick-scheduled] resultado', body);
    return res;
  } catch (err) {
    console.error('[tick-scheduled] error', err && (err.stack || err.message) || err);
    throw err;
  }
}

exports.handler = run;
exports.config = { schedule: '*/5 * * * *' };

// Runtime v2: "Run now" y el cron pueden invocar el default export con un Request de la plataforma
exports.default = async function tickScheduledV2(req, context) {
  const res = await run(req, context);
  if (typeof Response === 'function' && res && typeof res.statusCode === 'number') {
    return new Response(res.body || '', {
      status: res.statusCode,
      headers: res.headers || { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  return res;
};
