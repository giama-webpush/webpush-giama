(function () {
  'use strict';
  var el = document.getElementById('estado');
  function msg(t, c) { el.className = 'estado ' + c; el.textContent = t; }
  document.getElementById('btn').addEventListener('click', async function () {
    this.disabled = true;
    try {
      var token = new URLSearchParams(location.search).get('t') || '';
      try { token = token || localStorage.getItem('wp_manage') || ''; } catch (e) { /* */ }
      var sub = null;
      if ('serviceWorker' in navigator) { var reg = await navigator.serviceWorker.getRegistration('/'); sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null; }
      if (!sub && !token) { msg('No encontramos una suscripción activa en este navegador. Si seguís recibiendo avisos, desactivalos desde la configuración del navegador.', 'warn'); return; }
      await fetch('/api/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub ? { endpoint: sub.endpoint } : { token: token }) });
      if (sub) await sub.unsubscribe();
      msg('Listo, ya te diste de baja. No vas a recibir más avisos en este dispositivo.', 'ok');
    } catch (e) { msg('No pudimos completar la baja. Probá de nuevo o desactivá las notificaciones desde el navegador.', 'err'); }
    finally { this.disabled = false; }
  });
})();
