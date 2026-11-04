/* Service worker de avisos: muestra la notificación, registra entrega/cierre y abre el destino. */
'use strict';
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

function beacon(url) {
  if (!url) return Promise.resolve();
  return fetch(url, { method: 'POST', keepalive: true, mode: 'same-origin', credentials: 'omit' }).catch(function () {});
}

self.addEventListener('push', function (event) {
  var p = {};
  try { p = event.data ? event.data.json() : {}; } catch (e) { p = { title: 'Peugeot Giama', body: event.data ? event.data.text() : '' }; }
  var data = p.data || {};
  var opts = {
    body: p.body || '',
    icon: p.icon || '/brand/icon-192.png',
    badge: p.badge || '/brand/badge-96.png',
    image: p.image || undefined,
    tag: p.tag || undefined,
    requireInteraction: !!p.requireInteraction,
    actions: Array.isArray(p.actions) ? p.actions.slice(0, 2) : [],
    data: data,
  };
  event.waitUntil(Promise.all([
    self.registration.showNotification(p.title || 'Peugeot Giama', opts),
    beacon(data.delivered),
  ]));
});

self.addEventListener('notificationclick', function (event) {
  var n = event.notification; var data = n.data || {};
  n.close();
  var url = data.url || '/s';
  if (event.action && /^a(\d)$/.test(event.action)) {
    var i = Number(event.action.slice(1)) - 1;
    if (data.actionUrls && data.actionUrls[i]) url = data.actionUrls[i];
  }
  event.waitUntil(self.clients.openWindow(url));
});

self.addEventListener('notificationclose', function (event) {
  var data = event.notification.data || {};
  event.waitUntil(beacon(data.closed));
});

// El navegador renovó la suscripción: re-suscribir y avisar al servidor para conservar las etiquetas
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil((async function () {
    var cfg = await (await fetch('/api/public-config')).json();
    var pad = '='.repeat((4 - (cfg.vapidPublicKey.length % 4)) % 4);
    var raw = atob((cfg.vapidPublicKey + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var key = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) key[i] = raw.charCodeAt(i);
    var sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    var old = event.oldSubscription ? event.oldSubscription.endpoint : null;
    await fetch('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), oldEndpoint: old, meta: { origen: null } }) });
  })());
});
