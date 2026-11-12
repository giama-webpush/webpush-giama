'use strict';
// Cron de Netlify (plan gratis, todos los planes): cada 5 minutos llama al tick
// directo (sin HTTP ni ADMIN_KEY). El schedule está en netlify.toml y acá como respaldo.
// Solo corre solo en deploys publicados (no en Deploy Preview). Tope 30 s; el tick usa ~8 s y retoma.
const { createScheduledHandler } = require('../../src/handler');

exports.handler = createScheduledHandler();
exports.config = { schedule: '*/5 * * * *' };
