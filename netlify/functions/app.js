'use strict';
// Función HTTP de Netlify: Express detrás de serverless-http.
// Las rutas las reescribe netlify.toml hacia acá (/* → /.netlify/functions/app/:splat).
const serverless = require('serverless-http');
const { createHandler, defaultHandler } = require('../../src/handler');
const { prepareServerlessRequest, normalizeLambdaResponse } = require('../../src/serverless');

const PREFIXES = ['/.netlify/functions/app.js', '/.netlify/functions/app'];

function wrapApp(app) {
  return serverless(app, {
    binary: ['image/*', 'application/octet-stream', 'font/*', 'application/pdf'],
    request(req, event) {
      const url = req.url || '/';
      const pathOnly = url.split('?')[0];
      const qs = url.includes('?') ? url.slice(url.indexOf('?')) : '';
      for (const p of PREFIXES) {
        if (pathOnly === p || pathOnly.startsWith(`${p}/`)) {
          req.url = (pathOnly.slice(p.length) || '/') + qs;
          break;
        }
      }
      prepareServerlessRequest(req, event);
    },
  });
}

function createNetlifyFunction(opts = {}) {
  const h = opts.handler || (opts.cfg || opts.overrides || opts.db || opts.sendNotification || opts.logger
    ? createHandler(opts)
    : defaultHandler());
  let lambda;
  const fn = async function netlifyHandler(event, context) {
    if (context && typeof context.callbackWaitsForEmptyEventLoop === 'boolean') context.callbackWaitsForEmptyEventLoop = false;
    const { app } = await h.ensure();
    if (!lambda) lambda = wrapApp(app);
    const res = await lambda(event, context);
    return normalizeLambdaResponse(res);
  };
  fn.ensure = h.ensure;
  fn.reset = () => { h.reset(); lambda = null; };
  return fn;
}

exports.handler = createNetlifyFunction();
exports.createNetlifyFunction = createNetlifyFunction;
