'use strict';
// Función serverless de Vercel: exporta el handler HTTP de Express.
// Las rutas las reescribe vercel.json hacia acá; Express recibe la URL original.
module.exports = require('../src/handler').defaultHandler();
