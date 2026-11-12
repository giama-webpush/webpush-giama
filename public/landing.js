/* Landing de suscripción WebPush (sin dependencias). */
(function () {
  'use strict';
  var PARAMS = ['marca', 'modelo', 'tel', 'asesor', 'origen', 'campana', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'tags', 'cotiz', 'cotizacion'];
  var $ = function (id) { return document.getElementById(id); };
  var cfg = null;

  // 1) Leer parámetros del link y guardarlos (en iOS la app instalada abre sin parámetros)
  var qs = new URLSearchParams(location.search);
  var meta = {};
  try { meta = JSON.parse(localStorage.getItem('wp_meta') || '{}'); } catch (e) { meta = {}; }
  var vino = false;
  PARAMS.forEach(function (k) { var v = qs.get(k); if (v) { meta[k] = v.slice(0, 120); vino = true; } });
  if (vino) { try { localStorage.setItem('wp_meta', JSON.stringify(meta)); } catch (e) { /* modo privado */ } }
  // Sacar el teléfono de la barra de direcciones (no queda en historial ni capturas)
  if (qs.has('tel')) { qs.delete('tel'); history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : '')); }

  function titleCase(s) { return String(s).split(' ').map(function (w) { return w.length <= 3 || /\d/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }).join(' '); }

  function estado(tipo, html) {
    var el = $('estado');
    el.className = 'estado ' + tipo;
    el.innerHTML = html;
    el.classList.remove('oculto');
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function b64ToUint8(base64) {
    var pad = '='.repeat((4 - (base64.length % 4)) % 4);
    var raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  var ua = navigator.userAgent;
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
  var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  var soportado = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function pintarTextos() {
    if (cfg.logoUrl) $('logo').src = cfg.logoUrl;
    var modelo = meta.modelo ? titleCase(meta.modelo) : '';
    var marca = meta.marca ? titleCase(meta.marca) : '';
    $('eyebrow').textContent = modelo ? ('Tu ' + (marca ? marca + ' ' : '') + modelo) : (cfg.siteName || 'Peugeot Giama');
    $('titulo').textContent = cfg.optinTitle || 'Enterate primero de las ofertas';
    $('texto').textContent = cfg.optinText || '';
    $('btn-activar').textContent = cfg.optinButton || 'Quiero recibir las ofertas';
    $('consent').textContent = cfg.consentText || '';
    document.title = 'Avisos ' + (cfg.siteName || '');
  }

  function mostrarOk() {
    $('bloque-optin').classList.add('oculto');
    $('bloque-ok').classList.remove('oculto');
    estado('ok', esc(cfg.successText || 'Listo, ya estás suscripto. Solo te avisamos cuando hay algo que vale la pena.'));
  }

  function mostrarOptin() {
    $('bloque-optin').classList.remove('oculto');
    $('bloque-ok').classList.add('oculto');
  }

  function explicarBloqueo() {
    estado('warn', 'Las notificaciones están bloqueadas para este sitio. Para activarlas: tocá el candado o el ícono al lado de la dirección, entrá en <b>Permisos / Notificaciones</b> y elegí <b>Permitir</b>. Después volvé y tocá el botón de nuevo.');
  }

  async function registrarSW() {
    return navigator.serviceWorker.register('/sw.js', { scope: '/' });
  }

  async function activar() {
    var btn = $('btn-activar');
    btn.disabled = true;
    try {
      var permiso = await Notification.requestPermission();
      if (permiso !== 'granted') { if (permiso === 'denied') explicarBloqueo(); else estado('warn', 'Esta vez no se activaron las notificaciones. Cuando quieras, volvé a tocar el botón.'); return; }
      var reg = await registrarSW();
      await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(cfg.vapidPublicKey) });
      var body = Object.assign({}, meta, { lang: navigator.language, tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || ''), path: location.pathname });
      var res = await fetch('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), meta: body }) });
      if (!res.ok) throw new Error('El servidor respondió ' + res.status);
      var data = await res.json();
      try { localStorage.setItem('wp_manage', data.manageToken || ''); } catch (e) { /* sin storage */ }
      mostrarOk();
    } catch (err) {
      estado('err', 'No pudimos activar las notificaciones en este navegador. ' + esc(err && err.message ? err.message : ''));
    } finally { btn.disabled = false; }
  }

  async function baja() {
    try {
      var reg = await navigator.serviceWorker.getRegistration('/');
      var sub = reg && await reg.pushManager.getSubscription();
      var token = ''; try { token = localStorage.getItem('wp_manage') || ''; } catch (e) { /* */ }
      await fetch('/api/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub ? { endpoint: sub.endpoint } : { token: token }) });
      if (sub) await sub.unsubscribe();
      mostrarOptin();
      estado('ok', 'Listo, ya te diste de baja. No vas a recibir más avisos en este dispositivo.');
    } catch (e) { estado('err', 'No pudimos completar la baja. Probá de nuevo o desactivá las notificaciones desde la configuración del navegador.'); }
  }

  async function init() {
    try { cfg = await (await fetch('/api/public-config')).json(); } catch (e) { cfg = {}; }
    pintarTextos();
    $('btn-activar').addEventListener('click', activar);
    $('btn-baja').addEventListener('click', baja);

    // En iPhone/iPad el push web solo existe con la web instalada (iOS 16.4+), sin importar el navegador
    if (!soportado || (isIOS && !standalone)) {
      if (isIOS && !standalone) {
        $('btn-activar').classList.add('oculto');
        estado('warn', 'En iPhone las notificaciones funcionan desde la app instalada (iOS 16.4 o superior):<ol class="pasos"><li>Tocá <b>Compartir</b> (el cuadrado con la flecha).</li><li>Elegí <b>Agregar a pantalla de inicio</b>.</li><li>Abrí <b>Peugeot Giama</b> desde el ícono y tocá <b>Quiero recibir las ofertas</b>.</li></ol>');
      } else {
        $('btn-activar').disabled = true;
        estado('warn', 'Este navegador no permite notificaciones. Probá con Chrome, Edge, Firefox o Samsung Internet.');
      }
      return;
    }
    if (Notification.permission === 'denied') explicarBloqueo();
    try {
      var reg = await navigator.serviceWorker.getRegistration('/');
      var sub = reg && await reg.pushManager.getSubscription();
      if (sub && Notification.permission === 'granted') {
        var st = await (await fetch('/api/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) })).json();
        if (st.subscribed) {
          // Si vino un link nuevo con datos (otro modelo/asesor), actualizar etiquetas en silencio
          if (vino) fetch('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), meta: Object.assign({}, meta, { lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, path: location.pathname }) }) });
          mostrarOk();
        }
      }
    } catch (e) { /* seguir con el opt-in */ }
  }
  init();
})();
