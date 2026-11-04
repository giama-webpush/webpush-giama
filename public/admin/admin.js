/* Panel de administración WebPush (vanilla JS, sin dependencias externas). */
(function () {
  'use strict';
  var S = { csrf: null, user: null, facets: null, filters: {}, page: 1, selected: new Set(), tz: 'America/Argentina/Buenos_Aires' };
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(n) { return Number(n || 0).toLocaleString('es-AR'); }
  function pct(a, b) { return b ? (100 * a / b).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + ' %' : '—'; }
  function fecha(iso) { if (!iso) return '—'; try { return new Date(iso).toLocaleString('es-AR', { timeZone: S.tz, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso; } }
  function toast(t) { var el = $('#toast'); el.textContent = t; el.classList.remove('oculto'); clearTimeout(toast._t); toast._t = setTimeout(function () { el.classList.add('oculto'); }, 3200); }

  async function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (opts.body && !(opts.body instanceof Blob) && typeof opts.body !== 'string') { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.body); }
    if (opts.method && opts.method !== 'GET' && S.csrf) headers['X-CSRF-Token'] = S.csrf;
    var res = await fetch('/admin/api' + path, Object.assign({}, opts, { headers: headers, credentials: 'same-origin' }));
    var data = null;
    var ct = res.headers.get('content-type') || '';
    if (ct.indexOf('json') >= 0) data = await res.json();
    if (res.status === 401 && path !== '/login' && path !== '/me') { mostrarLogin(); throw new Error('Sesión vencida'); }
    if (!res.ok) throw new Error((data && data.error) || ('Error ' + res.status));
    return data;
  }

  // ---------- Sesión ----------
  function mostrarLogin(msg) {
    $('#app').classList.add('oculto'); $('#login').classList.remove('oculto');
    var m = $('#login-msg');
    if (msg) { m.textContent = msg; m.classList.remove('oculto'); } else m.classList.add('oculto');
  }
  async function iniciar() {
    try {
      var me = await api('/me');
      S.csrf = me.csrf; S.user = me.user; S.tz = me.timezone || S.tz;
      $('#who').textContent = me.user.username + ' · ' + me.user.role;
      if (me.logoUrl) $('#side-logo').src = me.logoUrl;
      $('#login').classList.add('oculto'); $('#app').classList.remove('oculto');
      ruta();
    } catch (e) {
      mostrarLogin(e && /bloqueado/.test(e.message) ? e.message : null);
    }
  }
  $('#form-login').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var f = new FormData(ev.target);
    try {
      var r = await api('/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
      S.csrf = r.csrf; ev.target.password.value = '';
      iniciar();
    } catch (e) { mostrarLogin(e.message); }
  });
  $('#btn-logout').addEventListener('click', async function () { try { await api('/logout', { method: 'POST' }); } catch (e) { /* */ } S.csrf = null; mostrarLogin(); });

  // ---------- Router ----------
  var VISTAS = {};
  function ruta() {
    var h = (location.hash || '#/dashboard').slice(2).split('/');
    var v = VISTAS[h[0]] ? h[0] : 'dashboard';
    $$('#nav a').forEach(function (a) { a.classList.toggle('activo', a.dataset.v === v); });
    var view = $('#view');
    view.onclick = null; view.onchange = null;
    view.innerHTML = '<div class="vacio">Cargando…</div>';
    Promise.resolve(VISTAS[v](view, h.slice(1))).catch(function (e) { view.innerHTML = '<div class="alerta err">' + esc(e.message) + '</div>'; });
  }
  window.addEventListener('hashchange', function () { if (S.csrf) ruta(); });

  function modal(html) { $('#modal-card').innerHTML = html; $('#modal').classList.remove('oculto'); return $('#modal-card'); }
  function cerrarModal() { $('#modal').classList.add('oculto'); $('#modal-card').innerHTML = ''; }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') cerrarModal(); });
  $('#modal').addEventListener('click', function (e) { if (e.target.id === 'modal' || e.target.dataset.cerrar !== undefined) cerrarModal(); });

  // ---------- Gráficos simples ----------
  function barras(list) {
    if (!list || !list.length) return '<div class="vacio">Sin datos todavía</div>';
    var max = Math.max.apply(null, list.map(function (x) { return x.n; }));
    return '<div class="barras">' + list.map(function (x) {
      return '<div class="barra"><span class="t" title="' + esc(x.k) + '">' + esc(x.k) + '</span><span class="b"><i style="width:' + (max ? (100 * x.n / max) : 0) + '%"></i></span><span class="n">' + num(x.n) + '</span></div>';
    }).join('') + '</div>';
  }
  function serie(series, keys, colores) {
    var tot = series.reduce(function (a, s) { return a + keys.reduce(function (b, k) { return b + s[k]; }, 0); }, 0);
    if (!tot) return '<div class="vacio">Sin datos en el período</div>';
    var W = 700, H = 170, pad = 22;
    var max = Math.max(1, Math.max.apply(null, series.map(function (s) { return Math.max.apply(null, keys.map(function (k) { return s[k]; })); })));
    var bw = (W - pad) / series.length;
    var out = '<svg viewBox="0 0 ' + W + ' ' + (H + 18) + '" preserveAspectRatio="none" role="img">';
    out += '<line x1="' + pad + '" y1="' + H + '" x2="' + W + '" y2="' + H + '" stroke="#E7E7E7"/>';
    out += '<text x="0" y="10" font-size="10" fill="#606060">' + max + '</text>';
    series.forEach(function (s, i) {
      keys.forEach(function (k, j) {
        var h = (H - 6) * s[k] / max; var w = Math.max(1, bw / keys.length - 1.5);
        out += '<rect x="' + (pad + i * bw + j * (w + 1)) + '" y="' + (H - h) + '" width="' + w + '" height="' + h + '" fill="' + colores[j] + '"><title>' + s.d + ' · ' + k + ': ' + s[k] + '</title></rect>';
      });
      if (i % Math.ceil(series.length / 7) === 0) out += '<text x="' + (pad + i * bw) + '" y="' + (H + 14) + '" font-size="10" fill="#606060">' + s.d.slice(5).split('-').reverse().join('/') + '</text>';
    });
    return out + '</svg><div class="leyenda">' + keys.map(function (k, j) { return '<span><i style="background:' + colores[j] + '"></i>' + k + '</span>'; }).join('') + '</div>';
  }
  function kpi(l, v, cls) { return '<div class="kpi ' + (cls || '') + '"><div class="l">' + l + '</div><div class="v">' + v + '</div></div>'; }
  // Desplegables de filtros: uno abierto a la vez y se cierran al tocar afuera
  document.addEventListener('click', function (e) { $$('details.multi[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); }); });
  document.addEventListener('click', function (e) { var tr = e.target.closest('tr[data-href]'); if (tr && !e.target.closest('input,button,a')) location.hash = tr.dataset.href; });

  // ---------- Tablero ----------
  VISTAS.dashboard = async function (view) {
    var d = await api('/dashboard?days=30');
    var t = d.totals, s = d.sends;
    var titulos = { marca: 'Por marca', modelo: 'Por modelo', zona: 'Por zona (teléfono)', area: 'Por código de área', device: 'Por dispositivo', os: 'Por sistema operativo', browser: 'Por navegador', origen: 'Por origen', asesor: 'Por asesor' };
    view.innerHTML = '<h1 class="titulo">Tablero</h1><p class="sub">Datos reales de la base. Últimos ' + d.days + ' días en los gráficos diarios.</p>' +
      '<div class="grid g4 kpis">' +
      kpi('Suscriptores activos', num(t.active), 'azul') + kpi('Bajas', num(t.unsubscribed)) + kpi('Vencidas (404/410)', num(t.dead)) + kpi('Total histórico', num(t.total)) +
      kpi('Avisos enviados', num(s.sent), 'azul') + kpi('Entregados (confirmados)', num(s.delivered) + ' <small>' + pct(s.delivered, s.sent) + '</small>') + kpi('Clics', num(s.clicked)) + kpi('CTR (clics / enviados)', s.ctr == null ? '—' : pct(s.clicked, s.sent)) +
      '</div><div class="grid g2" style="margin-top:14px">' +
      '<div class="panel chart"><h2>Altas y bajas por día</h2>' + serie(d.series, ['altas', 'bajas'], ['#0074E8', '#ADAEB2']) + '</div>' +
      '<div class="panel chart"><h2>Envíos y clics por día</h2>' + serie(d.series, ['envios', 'clics'], ['#000000', '#0074E8']) + '</div>' +
      '</div><div class="grid g3" style="margin-top:14px">' +
      Object.keys(titulos).map(function (k) { return '<div class="panel"><h2>' + titulos[k] + '</h2>' + barras(d.by[k]) + '</div>'; }).join('') + '</div>' +
      '<div class="panel" style="margin-top:14px"><h2>Últimas campañas</h2>' + (d.recent.length ? '<div class="tabla-wrap"><table><tr><th>Campaña</th><th>Estado</th><th>Destinatarios</th><th>Enviados</th><th>Clics</th><th>CTR</th></tr>' +
        d.recent.map(function (c) { return '<tr class="click" data-href="#/campanas/' + c.id + '"><td>' + esc(c.name) + '</td><td><span class="estado-b ' + c.status + '">' + c.status + '</span></td><td>' + num(c.total_targeted) + '</td><td>' + num(c.sent) + '</td><td>' + num(c.clicked) + '</td><td>' + pct(c.clicked, c.sent) + '</td></tr>'; }).join('') + '</table></div>' : '<div class="vacio">Todavía no hay campañas</div>') + '</div>';
  };

  // ---------- Público ----------
  var CAMPOS = [['marca', 'Marca'], ['modelo', 'Modelo'], ['zona', 'Zona'], ['area', 'Cód. área'], ['region', 'Región'], ['device', 'Dispositivo'], ['os', 'Sistema'], ['browser', 'Navegador'], ['origen', 'Origen'], ['campana', 'Campaña'], ['asesor', 'Asesor'], ['daypart', 'Franja alta'], ['tags', 'Etiquetas']];

  function multiSelect(key, label, opciones, sel) {
    sel = sel || [];
    var resumen = sel.length ? sel.join(', ') : 'Todos';
    return '<details class="multi" data-key="' + key + '"><summary><b>' + label + '</b>' + esc(resumen) + '</summary><div class="opciones">' +
      (opciones.length ? opciones.map(function (o) { return '<label><input type="checkbox" value="' + esc(o.v) + '"' + (sel.indexOf(String(o.v)) >= 0 ? ' checked' : '') + '> ' + esc(o.v) + ' <span style="color:#ADAEB2">(' + o.n + ')</span></label>'; }).join('') : '<div class="vacio">Sin valores</div>') + '</div></details>';
  }

  function leerFiltros(root) {
    var f = {};
    $$('details.multi', root).forEach(function (d) {
      var vals = $$('input:checked', d).map(function (i) { return i.value; });
      if (vals.length) f[d.dataset.key] = vals;
    });
    var g = function (n) { var el = $('[name="' + n + '"]', root); return el ? el.value : ''; };
    if (g('status') && g('status') !== 'active') f.status = g('status');
    if (g('desde')) f.desde = g('desde');
    if (g('hasta')) f.hasta = g('hasta');
    if (g('has_phone')) f.has_phone = g('has_phone') === 'si';
    if (g('q')) f.q = g('q');
    if (g('tags_mode') === 'all') f.tags_mode = 'all';
    return f;
  }

  function filtrosHtml(f, facets, opts) {
    opts = opts || {};
    return '<div class="filtros">' + CAMPOS.map(function (c) { return multiSelect(c[0], c[1], facets[c[0]] || [], (f[c[0]] || []).map(String)); }).join('') +
      '<label>Coincidir etiquetas<select name="tags_mode"><option value="any">Alguna</option><option value="all"' + (f.tags_mode === 'all' ? ' selected' : '') + '>Todas</option></select></label>' +
      '<label>Alta desde<input type="date" name="desde" value="' + esc(f.desde || '') + '"></label>' +
      '<label>Alta hasta<input type="date" name="hasta" value="' + esc(f.hasta || '') + '"></label>' +
      '<label>Teléfono<select name="has_phone"><option value="">Indistinto</option><option value="si"' + (f.has_phone === true ? ' selected' : '') + '>Con teléfono</option><option value="no"' + (f.has_phone === false ? ' selected' : '') + '>Sin teléfono</option></select></label>' +
      (opts.status === false ? '' : '<label>Estado<select name="status"><option value="active">Activos</option><option value="unsubscribed"' + (f.status === 'unsubscribed' ? ' selected' : '') + '>Bajas</option><option value="dead"' + (f.status === 'dead' ? ' selected' : '') + '>Vencidas</option><option value="all"' + (f.status === 'all' ? ' selected' : '') + '>Todos</option></select></label>') +
      '<label>Buscar<input name="q" placeholder="modelo, asesor, etiqueta, #id" value="' + esc(f.q || '') + '"></label></div>';
  }

  function actualizarResumen(root) {
    $$('details.multi', root).forEach(function (d) {
      var vals = $$('input:checked', d).map(function (i) { return i.value; });
      var sm = $('summary', d); var b = $('b', sm).outerHTML;
      sm.innerHTML = b + esc(vals.length ? vals.join(', ') : 'Todos');
    });
  }

  VISTAS.publico = async function (view) {
    S.facets = await api('/facets');
    var segs = await api('/segments');
    view.innerHTML = '<div class="fila entre"><div><h1 class="titulo">Público</h1><p class="sub">Filtros combinables: entre campos se suman (Y); dentro de un campo vale cualquiera de los valores (O).</p></div><span class="contador" id="cont">…</span></div>' +
      '<div class="grid" style="grid-template-columns: minmax(0,1fr) 260px">' +
      '<div class="panel" id="pf">' + filtrosHtml(S.filters, S.facets) +
      '<div class="fila" style="margin-top:12px"><button class="btn btn-negro btn-chico" data-a="guardar-seg">Guardar como segmento</button><button class="btn btn-borde btn-chico" data-a="tags-masivo">Etiquetar…</button><button class="btn btn-borde btn-chico" data-a="csv">Exportar CSV</button><button class="btn btn-texto btn-chico" data-a="limpiar">Limpiar filtros</button></div></div>' +
      '<div class="panel"><h2>Segmentos guardados</h2>' + (segs.length ? segs.map(function (s) { return '<div class="seg-item"><a href="#" data-seg="' + s.id + '"><b data-seg="' + s.id + '">' + esc(s.name) + '</b></a><span class="tag azul">' + num(s.count) + '</span><button class="btn btn-texto btn-chico" data-delseg="' + s.id + '" title="Borrar segmento">Borrar</button><div class="seg-desc">' + esc(s.description) + '</div></div>'; }).join('') : '<div class="vacio">Todavía no hay segmentos</div>') + '</div>' +
      '</div><div class="panel" style="margin-top:14px"><div id="tabla"></div></div>';
    var pf = $('#pf');
    var deb;
    pf.addEventListener('change', function () { clearTimeout(deb); deb = setTimeout(function () { S.filters = leerFiltros(pf); S.page = 1; refrescar(); actualizarResumen(pf); }, 200); });
    pf.addEventListener('input', function (e) { if (e.target.name === 'q') { clearTimeout(deb); deb = setTimeout(function () { S.filters = leerFiltros(pf); S.page = 1; refrescar(); }, 400); } });
    view.onclick = async function (e) {
      var d = e.target.dataset; var a = d.a;
      try {
        if (d.seg) { e.preventDefault(); var sg = segs.find(function (x) { return String(x.id) === d.seg; }); S.filters = sg.filters; ruta(); return; }
        if (d.delseg) { if (confirm('¿Borrar el segmento?')) { await api('/segments/' + d.delseg, { method: 'DELETE' }); ruta(); } return; }
        if (a === 'limpiar') { S.filters = {}; ruta(); }
        if (a === 'csv') { location.href = '/admin/api/export.csv?filters=' + encodeURIComponent(JSON.stringify(S.filters)); }
        if (a === 'guardar-seg') {
          var name = prompt('Nombre del segmento (ej. "208 AMBA mobile")');
          if (name) { await api('/segments', { method: 'POST', body: { name: name, filters: S.filters } }); toast('Segmento guardado'); ruta(); }
        }
        if (a === 'tags-masivo') abrirTagsMasivo();
        if (d.pag) { S.page = Number(d.pag); refrescar(); }
      } catch (err) { alert(err.message); }
    };
    refrescar();
  };

  async function refrescar() {
    var d = await api('/subscribers?page=' + S.page + '&limit=50&filters=' + encodeURIComponent(JSON.stringify(S.filters)));
    $('#cont').textContent = num(d.total) + ' suscriptores';
    var el = $('#tabla');
    if (!d.rows.length) { el.innerHTML = '<div class="vacio">No hay suscriptores con estos filtros.</div>'; return; }
    var pags = Math.ceil(d.total / d.limit);
    el.innerHTML = '<div class="fila entre" style="margin-bottom:8px"><span style="color:#606060">' + esc(d.description) + '</span><label style="display:inline-flex;flex-direction:row;gap:6px;font-weight:400"><input type="checkbox" id="sel-todo" style="width:auto"> Seleccionar página</label></div>' +
      '<div class="tabla-wrap"><table><tr><th></th><th>#</th><th>Estado</th><th>Alta</th><th>Marca / modelo</th><th>Zona</th><th>Dispositivo</th><th>Origen / campaña</th><th>Asesor</th><th>Etiquetas manuales</th></tr>' +
      d.rows.map(function (r) {
        var manual = r.tags.filter(function (t) { return t.indexOf(':') < 0; });
        return '<tr class="click" data-sub="' + r.id + '"><td><input type="checkbox" class="sel" value="' + r.id + '" style="width:auto"' + (S.selected.has(r.id) ? ' checked' : '') + '></td><td>' + r.id + '</td><td><span class="estado-b ' + r.status + '">' + ({ active: 'activo', unsubscribed: 'baja', dead: 'vencida' }[r.status] || r.status) + '</span></td><td>' + fecha(r.created_at) + '</td><td>' + esc([r.marca, r.modelo].filter(Boolean).join(' ') || '—') + '</td><td>' + esc(r.phone_zone ? r.phone_zone + (r.phone_area ? ' (0' + r.phone_area + ')' : '') : '—') + '</td><td>' + esc(r.device_type + ' · ' + r.os + ' · ' + r.browser) + '</td><td>' + esc([r.origen, r.campana].filter(Boolean).join(' / ') || '—') + '</td><td>' + esc(r.asesor || '—') + '</td><td>' + manual.map(function (t) { return '<span class="tag azul">' + esc(t) + '</span>'; }).join('') + '</td></tr>';
      }).join('') + '</table></div>' +
      '<div class="fila" style="margin-top:10px">' + (S.page > 1 ? '<button class="btn btn-borde btn-chico" data-pag="' + (S.page - 1) + '">Anterior</button>' : '') + '<span>Página ' + S.page + ' de ' + pags + '</span>' + (S.page < pags ? '<button class="btn btn-borde btn-chico" data-pag="' + (S.page + 1) + '">Siguiente</button>' : '') + '<span style="margin-left:auto;color:#606060" id="nsel">' + S.selected.size + ' seleccionados</span></div>';
    $('#sel-todo').addEventListener('change', function (e) { $$('.sel', el).forEach(function (c) { c.checked = e.target.checked; var id = Number(c.value); if (c.checked) S.selected.add(id); else S.selected.delete(id); }); $('#nsel').textContent = S.selected.size + ' seleccionados'; });
    el.onchange = function (e) { if (e.target.classList.contains('sel')) { var id = Number(e.target.value); if (e.target.checked) S.selected.add(id); else S.selected.delete(id); $('#nsel').textContent = S.selected.size + ' seleccionados'; } };
    el.onclick = function (e) { var tr = e.target.closest('tr[data-sub]'); if (tr && !e.target.closest('input')) verSuscriptor(Number(tr.dataset.sub)); };
  }

  function abrirTagsMasivo() {
    var usarSel = S.selected.size > 0;
    var card = modal('<h2>Editar etiquetas en lote</h2><p>Se aplica a <b>' + (usarSel ? S.selected.size + ' suscriptores seleccionados' : 'todos los que cumplen los filtros actuales') + '</b>.</p>' +
      '<label>Agregar etiquetas (separadas por coma)<input id="t-add" placeholder="ej. interesado-financiacion, evento-noviembre"></label><br>' +
      '<label>Quitar etiquetas (separadas por coma)<input id="t-rem"></label>' +
      '<div class="fila" style="margin-top:14px"><button class="btn btn-primario" id="t-ok">Aplicar</button><button class="btn btn-texto" data-cerrar>Cancelar</button></div>');
    $('#t-ok', card).addEventListener('click', async function () {
      var sp = function (s) { return s.split(',').map(function (x) { return x.trim(); }).filter(Boolean); };
      var body = { add: sp($('#t-add').value), remove: sp($('#t-rem').value) };
      if (usarSel) body.ids = Array.from(S.selected); else body.filters = S.filters;
      try { var r = await api('/subscribers/tags', { method: 'POST', body: body }); cerrarModal(); toast('Etiquetas actualizadas en ' + r.affected + ' suscriptores'); S.selected.clear(); ruta(); } catch (e) { alert(e.message); }
    });
  }

  async function verSuscriptor(id) {
    var s = await api('/subscribers/' + id);
    var testId = localStorage.getItem('wp_test_sub');
    var datos = [['Alta', fecha(s.created_at) + ' (' + (s.sub_daypart || '') + ')'], ['Marca / modelo', [s.marca, s.modelo].filter(Boolean).join(' ') || '—'], ['Zona / área', (s.phone_zone || '—') + (s.phone_area ? ' · 0' + s.phone_area : '') + (s.phone_region ? ' · ' + s.phone_region : '')], ['Teléfono', s.phone ? s.phone : (s.has_phone ? 'Guardado como huella (no visible)' : 'No vino en el link')], ['Dispositivo', s.device_type + ' · ' + s.os + ' · ' + s.browser], ['Idioma / zona horaria', (s.lang || '—') + ' · ' + (s.timezone || '—')], ['Origen / campaña', (s.origen || '—') + ' / ' + (s.campana || '—')], ['Asesor', s.asesor || '—'], ['UTM', [s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term].filter(Boolean).join(' · ') || '—'], ['Último aviso', fecha(s.last_push_at)]];
    var card = modal('<div class="fila entre"><h2>Suscriptor #' + s.id + '</h2><span class="estado-b ' + s.status + '">' + s.status + '</span></div>' +
      '<dl class="datos">' + datos.map(function (x) { return '<dt>' + x[0] + '</dt><dd>' + esc(x[1]) + '</dd>'; }).join('') + '</dl>' +
      '<div class="drawer-sec"><h3>Etiquetas</h3>' + (s.tags.map(function (t) { return '<span class="tag' + (t.indexOf(':') < 0 ? ' azul' : '') + '">' + esc(t) + '</span>'; }).join('') || '—') +
      '<div class="fila" style="margin-top:8px"><input id="s-tag" placeholder="agregar etiqueta" style="max-width:220px"><button class="btn btn-borde btn-chico" id="s-tag-ok">Agregar</button></div></div>' +
      '<div class="drawer-sec"><h3>Últimos avisos</h3>' + (s.sends.length ? '<div class="tabla-wrap"><table><tr><th>Campaña</th><th>Estado</th><th>Enviado</th><th>Entregado</th><th>Clic</th></tr>' + s.sends.map(function (x) { return '<tr><td>' + esc(x.campaign) + (x.is_test ? ' <span class="tag">prueba</span>' : '') + '</td><td>' + esc(x.status) + (x.http_status ? ' (' + x.http_status + ')' : '') + '</td><td>' + fecha(x.sent_at) + '</td><td>' + fecha(x.delivered_at) + '</td><td>' + fecha(x.clicked_at) + '</td></tr>'; }).join('') + '</table></div>' : '<div class="vacio">Sin avisos</div>') + '</div>' +
      '<div class="fila" style="margin-top:16px"><button class="btn btn-negro btn-chico" id="s-test">' + (String(testId) === String(s.id) ? 'Es tu dispositivo de prueba' : 'Usar como dispositivo de prueba') + '</button>' +
      (s.status === 'active' ? '<button class="btn btn-borde btn-chico" id="s-baja">Dar de baja</button>' : '') +
      (S.user.role === 'admin' ? '<button class="btn btn-peligro btn-chico" id="s-del">Borrar datos (supresión)</button>' : '') + '<button class="btn btn-texto" data-cerrar>Cerrar</button></div>');
    $('#s-tag-ok', card).addEventListener('click', async function () { var v = $('#s-tag', card).value.trim(); if (!v) return; await api('/subscribers/tags', { method: 'POST', body: { ids: [s.id], add: [v] } }); verSuscriptor(s.id); });
    $('#s-test', card).addEventListener('click', function () { localStorage.setItem('wp_test_sub', s.id); toast('Las pruebas se van a enviar al suscriptor #' + s.id); verSuscriptor(s.id); });
    if ($('#s-baja', card)) $('#s-baja', card).addEventListener('click', async function () { if (confirm('¿Dar de baja a este suscriptor?')) { await api('/subscribers/' + s.id + '/unsubscribe', { method: 'POST' }); cerrarModal(); refrescar(); } });
    if ($('#s-del', card)) $('#s-del', card).addEventListener('click', async function () { if (confirm('Se borran todos sus datos y su historial de avisos. ¿Seguro?')) { await api('/subscribers/' + s.id, { method: 'DELETE' }); cerrarModal(); refrescar(); } });
  }

  // ---------- Piezas ----------
  function previewHtml(p, siteName, soloAndroid) {
    var sample = { marca: 'Peugeot', modelo: '208', asesor: 'Laura', zona: 'AMBA', region: 'CABA y GBA' };
    var rv = function (t) { return String(t || '').replace(/\{\{\s*(\w+)\s*(?:\|([^}]*))?\}\}/g, function (m, k, def) { return sample[k.toLowerCase()] || (def || '').trim(); }); };
    var t = esc(rv(p.title) || 'Título del aviso'); var b = esc(rv(p.body) || 'Texto del aviso');
    var ico = esc(p.icon || '/brand/icon-192.png'); var img = p.image ? '<img class="pv-img" src="' + esc(p.image) + '" alt="">' : '';
    var acts = (p.actions || []).filter(function (a) { return a && a.title; });
    var actsHtml = acts.length ? '<div class="pv-acts">' + acts.map(function (a) { return '<span>' + esc(rv(a.title)) + '</span>'; }).join('') + '</div>' : '';
    var dom = esc(location.host);
    var android = '<div><div class="pv-titulo">Android (Chrome)</div><div class="pv-android"><div class="n"><div class="cab"><img src="/brand/badge-96.png" style="background:#0074E8" alt=""> Chrome · ' + dom + ' · ahora</div><div class="pv-row"><div class="tx"><div class="pv-t">' + t + '</div><div class="pv-b">' + b + '</div></div><img class="ico" src="' + ico + '" alt=""></div>' + img + actsHtml + '</div></div></div>';
    if (soloAndroid) return android;
    return android +
      '<div><div class="pv-titulo">iPhone (app en pantalla de inicio, iOS 16.4+)</div><div class="pv-ios"><div class="n"><div class="cab"><span>' + esc(siteName || 'Peugeot Giama') + '</span><span>ahora</span></div><div class="pv-row"><img class="ico" src="' + ico + '" alt=""><div class="tx"><div class="pv-t">' + t + '</div><div class="pv-b">' + b + '</div></div></div></div></div><div style="font-size:11px;color:#606060;margin-top:4px">iOS no muestra la imagen grande ni los botones.</div></div>' +
      '<div><div class="pv-titulo">Escritorio (Windows / macOS)</div><div class="pv-desk"><div class="n"><div class="cab">Google Chrome · ' + dom + '</div><div class="pv-row"><img class="ico" src="' + ico + '" alt="" style="border-radius:6px"><div class="tx"><div class="pv-t">' + t + '</div><div class="pv-b">' + b + '</div></div></div>' + img + actsHtml + '</div></div></div>';
  }

  async function enviarPrueba(path) {
    var id = localStorage.getItem('wp_test_sub');
    if (!id) { alert('Primero elegí tu dispositivo de prueba: en Configuración tocá "Suscribir este navegador como prueba", o en Público abrí un suscriptor y "Usar como dispositivo de prueba".'); return null; }
    var r = await api(path, { method: 'POST', body: { subscriberId: Number(id) } });
    if (r.result === 'sent') toast('Prueba enviada al suscriptor #' + id);
    else alert('La prueba no se entregó: ' + r.result + (r.http_status ? ' (HTTP ' + r.http_status + ')' : '') + (r.error ? ' · ' + r.error : ''));
    return r;
  }

  VISTAS.piezas = async function (view, args) {
    if (args[0]) return editorPieza(view, args[0]);
    var ps = await api('/pieces');
    view.innerHTML = '<div class="fila entre"><div><h1 class="titulo">Piezas</h1><p class="sub">Biblioteca de avisos reutilizables. Variables: {{marca}}, {{modelo}}, {{asesor}}, {{zona}}, con valor por defecto: {{modelo|tu Peugeot}}.</p></div><a class="btn btn-primario" href="#/piezas/nueva">Nueva pieza</a></div>' +
      (ps.length ? '<div class="piezas-grid">' + ps.map(function (p) {
        return '<div class="pieza-card"><div class="img" style="background-image:url(\'' + esc(p.image || '/brand/pieza-ejemplo-1024x512.png') + '\')"></div><div class="cuerpo"><b>' + esc(p.title) + '</b><div style="font-size:13px;color:#3B3938;margin-top:4px">' + esc(p.body) + '</div><div style="font-size:11.5px;color:#606060;margin-top:6px">' + esc(p.name) + ' · usada en ' + p.used + ' campaña(s)</div></div>' +
          '<div class="acciones"><a class="btn btn-borde btn-chico" href="#/piezas/' + p.id + '">Editar</a><button class="btn btn-borde btn-chico" data-dup="' + p.id + '">Duplicar</button><button class="btn btn-borde btn-chico" data-test="' + p.id + '">Enviar prueba</button><button class="btn btn-texto btn-chico" data-arch="' + p.id + '">Archivar</button></div></div>';
      }).join('') + '</div>' : '<div class="vacio">Todavía no hay piezas. Creá la primera con "Nueva pieza".</div>');
    view.onclick = async function (e) {
      var d = e.target.dataset;
      try {
        if (d.dup) { await api('/pieces/' + d.dup + '/duplicate', { method: 'POST' }); ruta(); }
        if (d.arch && confirm('¿Archivar la pieza?')) { await api('/pieces/' + d.arch + '/archive', { method: 'POST', body: { archived: true } }); ruta(); }
        if (d.test) await enviarPrueba('/pieces/' + d.test + '/test');
      } catch (err) { alert(err.message); }
    };
  };

  async function editorPieza(view, id) {
    var p = id === 'nueva' ? { name: '', title: '', body: '', url: 'https://www.peugeotgiama.com.ar/', image: '', icon: '', actions: [], utm_auto: 1 } : await api('/pieces/' + id);
    var cfg = await api('/settings');
    var chk = function (n, on, txt) { return '<label style="flex-direction:row;display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" name="' + n + '" style="width:auto"' + (on ? ' checked' : '') + '> ' + txt + '</label>'; };
    view.innerHTML = '<h1 class="titulo">' + (id === 'nueva' ? 'Nueva pieza' : 'Editar pieza') + '</h1><p class="sub">Imagen grande recomendada: 1024 x 512 px (2:1), hasta 700 KB. Ícono: 192 x 192 px.</p>' +
      '<div class="editor"><form class="panel grid" id="fp">' +
      '<label>Nombre interno<input name="name" required maxlength="80" value="' + esc(p.name) + '" placeholder="ej. Bonificación 208 noviembre"></label>' +
      '<label>Título (se ven ~50 caracteres)<input name="title" required maxlength="120" value="' + esc(p.title) + '"></label>' +
      '<div class="vars"><button type="button" class="btn btn-borde btn-chico" data-var="{{modelo|tu Peugeot}}">+ modelo</button><button type="button" class="btn btn-borde btn-chico" data-var="{{marca}}">+ marca</button><button type="button" class="btn btn-borde btn-chico" data-var="{{asesor|tu asesor}}">+ asesor</button></div>' +
      '<label>Texto (se ven ~120 caracteres)<textarea name="body" maxlength="400">' + esc(p.body) + '</textarea></label>' +
      '<label>URL de destino (al tocar el aviso)<input name="url" required value="' + esc(p.url) + '"></label>' +
      chk('utm_auto', p.utm_auto, 'Agregar UTM automáticas (utm_source=webpush, utm_medium=push, utm_campaign=campaña, utm_content=pieza-N)') +
      '<div class="grid g2"><label>Imagen grande<input name="image" value="' + esc(p.image || '') + '" placeholder="/media/... o https://..."></label><label>Subir imagen<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-up="image"></label></div>' +
      '<div class="grid g2"><label>Ícono (vacío = ícono del sitio)<input name="icon" value="' + esc(p.icon || '') + '"></label><label>Subir ícono<input type="file" accept="image/png,image/jpeg,image/webp" data-up="icon"></label></div>' +
      '<div id="img-aviso"></div>' +
      [0, 1].map(function (i) { var a = (p.actions || [])[i] || {}; return '<div class="grid g2"><label>Botón ' + (i + 1) + ' (opcional)<input name="a' + i + 't" maxlength="40" value="' + esc(a.title || '') + '" placeholder="ej. Ver promo"></label><label>URL del botón ' + (i + 1) + '<input name="a' + i + 'u" value="' + esc(a.url || '') + '"></label></div>'; }).join('') +
      chk('require_interaction', p.require_interaction, 'Mantener visible hasta que la persona la toque (escritorio)') +
      '<div id="fp-msg"></div><div class="fila"><button class="btn btn-primario" type="submit">Guardar</button>' + (id !== 'nueva' ? '<button class="btn btn-borde" type="button" id="fp-test">Guardar y enviar prueba</button>' : '') + '<a class="btn btn-texto" href="#/piezas">Volver</a></div>' +
      '</form><div class="previews" id="pv"></div></div>';
    var form = $('#fp');
    var ultimo = form.title;
    function leer() {
      var f = new FormData(form);
      var acts = [0, 1].map(function (i) { return { title: (f.get('a' + i + 't') || '').trim(), url: (f.get('a' + i + 'u') || '').trim() }; }).filter(function (a) { return a.title; });
      return { name: f.get('name'), title: f.get('title'), body: f.get('body'), url: f.get('url'), image: f.get('image') || null, icon: f.get('icon') || null, actions: acts, utm_auto: !!f.get('utm_auto'), require_interaction: !!f.get('require_interaction') };
    }
    function pintar() { $('#pv').innerHTML = previewHtml(leer(), cfg.settings.site_name); }
    form.addEventListener('input', pintar); pintar();
    form.addEventListener('focusin', function (e) { if (e.target.name === 'title' || e.target.name === 'body') ultimo = e.target; });
    form.addEventListener('click', function (e) {
      var v = e.target.dataset.var; if (!v) return;
      ultimo.value += (ultimo.value && !/\s$/.test(ultimo.value) ? ' ' : '') + v; pintar();
    });
    form.addEventListener('change', async function (e) {
      var campo = e.target.dataset.up; if (!campo || !e.target.files[0]) return;
      var file = e.target.files[0];
      try {
        var r = await api('/uploads', { method: 'POST', body: file, headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name).slice(0, 100) } });
        form[campo].value = r.url; pintar();
        var av = '';
        if (campo === 'image' && r.width && r.height && Math.abs(r.width / r.height - 2) > 0.15) av = '<div class="alerta">La imagen mide ' + r.width + ' x ' + r.height + ' px. Para que no se recorte usá proporción 2:1 (1024 x 512).</div>';
        $('#img-aviso').innerHTML = av || '<div class="alerta ok">Imagen subida (' + Math.round(r.bytes / 1024) + ' KB' + (r.width ? ', ' + r.width + ' x ' + r.height + ' px' : '') + ').</div>';
      } catch (err) { $('#img-aviso').innerHTML = '<div class="alerta err">' + esc(err.message) + '</div>'; }
    });
    async function guardar() {
      var body = leer();
      if (id === 'nueva') { var r = await api('/pieces', { method: 'POST', body: body }); return r.id; }
      await api('/pieces/' + id, { method: 'PUT', body: body }); return id;
    }
    form.addEventListener('submit', async function (e) { e.preventDefault(); try { await guardar(); toast('Pieza guardada'); location.hash = '#/piezas'; } catch (err) { $('#fp-msg').innerHTML = '<div class="alerta err">' + esc(err.message) + '</div>'; } });
    if ($('#fp-test')) $('#fp-test').addEventListener('click', async function () { try { await guardar(); await enviarPrueba('/pieces/' + id + '/test'); } catch (err) { $('#fp-msg').innerHTML = '<div class="alerta err">' + esc(err.message) + '</div>'; } });
  }

  // ---------- Campañas ----------
  var ESTADOS = { borrador: 'Borrador', programada: 'Programada', enviando: 'Enviando', finalizada: 'Finalizada', cancelada: 'Cancelada' };
  VISTAS.campanas = async function (view, args) {
    if (args[0] === 'nueva' || (args[0] && args[1] === 'editar')) return formCampana(view, args[0] === 'nueva' ? null : args[0]);
    if (args[0]) return reporteCampana(view, args[0]);
    var cs = await api('/campaigns');
    view.innerHTML = '<div class="fila entre"><div><h1 class="titulo">Campañas</h1><p class="sub">Pieza + público + cuándo. Se envía en lotes con reintentos; las suscripciones vencidas (404/410) se desactivan solas.</p></div><a class="btn btn-primario" href="#/campanas/nueva">Nueva campaña</a></div>' +
      (cs.length ? '<div class="tabla-wrap"><table><tr><th>#</th><th>Campaña</th><th>Estado</th><th>Cuándo</th><th>Público</th><th>Enviados</th><th>Entregados</th><th>Clics</th><th>CTR</th><th></th></tr>' + cs.map(function (c) {
        var st = c.stats || {};
        var cuando = c.status === 'programada' && c.scheduled_at ? 'Programada ' + fecha(c.scheduled_at) : c.started_at ? fecha(c.started_at) : '—';
        return '<tr class="click" data-href="#/campanas/' + c.id + '"><td>' + c.id + '</td><td><b>' + esc(c.name) + '</b><div style="font-size:12px;color:#606060">' + esc(c.piece_name) + (c.kind === 'api' ? ' · vía API' : '') + '</div></td><td><span class="estado-b ' + c.status + '">' + (ESTADOS[c.status] || c.status) + '</span></td><td>' + cuando + '</td><td style="max-width:240px;font-size:12px">' + esc(c.segment_name ? 'Segmento: ' + c.segment_name : c.description) + (c.estimated != null ? '<div><b>' + num(c.estimated) + '</b> hoy</div>' : '<div><b>' + num(c.total_targeted) + '</b> destinatarios</div>') + '</td><td>' + num(st.sent) + '</td><td>' + num(st.delivered) + '</td><td>' + num(st.clicked) + '</td><td>' + pct(st.clicked, st.sent) + '</td><td><div class="fila" style="gap:4px">' +
          (['borrador', 'programada'].indexOf(c.status) >= 0 ? '<a class="btn btn-borde btn-chico" href="#/campanas/' + c.id + '/editar">Editar</a>' : '') +
          '<button class="btn btn-borde btn-chico" data-dupc="' + c.id + '">Duplicar</button>' +
          (['borrador', 'programada', 'enviando'].indexOf(c.status) >= 0 ? '<button class="btn btn-peligro btn-chico" data-cancel="' + c.id + '">Cancelar</button>' : '') + '</div></td></tr>';
      }).join('') + '</table></div>' : '<div class="vacio">Todavía no hay campañas.</div>');
    view.onclick = async function (e) {
      var d = e.target.dataset;
      try {
        if (d.dupc) { var r = await api('/campaigns/' + d.dupc + '/duplicate', { method: 'POST' }); location.hash = '#/campanas/' + r.id + '/editar'; }
        if (d.cancel && confirm('¿Cancelar la campaña? Los avisos que falten no se envían.')) { await api('/campaigns/' + d.cancel + '/cancel', { method: 'POST' }); ruta(); }
      } catch (err) { alert(err.message); }
    };
    if (cs.some(function (c) { return c.status === 'enviando'; })) setTimeout(function () { if (location.hash === '#/campanas') ruta(); }, 4000);
  };

  function localInput(iso) {
    var d = iso ? new Date(iso) : new Date(Date.now() + 3600e3);
    var o = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: S.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).forEach(function (x) { o[x.type] = x.value; });
    return o.year + '-' + o.month + '-' + o.day + 'T' + o.hour + ':' + o.minute;
  }

  async function formCampana(view, id) {
    var res = await Promise.all([api('/pieces'), api('/segments'), id ? api('/campaigns/' + id) : null, api('/facets'), api('/settings')]);
    var ps = res[0], segs = res[1], c = res[2] || { name: '', ttl: 86400, urgency: 'normal', freq_cap_hours: 24, filters: {} }, facets = res[3], cfg = res[4];
    if (!ps.length) { view.innerHTML = '<div class="alerta">Primero creá una pieza en <a href="#/piezas/nueva">Piezas</a>.</div>'; return; }
    var opt = function (v, t, sel) { return '<option value="' + v + '"' + (String(sel) === String(v) ? ' selected' : '') + '>' + t + '</option>'; };
    view.innerHTML = '<h1 class="titulo">' + (id ? 'Editar campaña' : 'Nueva campaña') + '</h1><p class="sub">Horario de Argentina (' + S.tz + ').</p>' +
      '<form id="fc" class="grid editor"><div class="panel grid">' +
      '<label>Nombre<input name="name" required value="' + esc(c.name) + '" placeholder="ej. Promo 208 noviembre AMBA"></label>' +
      '<label>Pieza<select name="piece_id">' + ps.map(function (p) { return opt(p.id, esc(p.name + ' — ' + p.title), c.piece_id); }).join('') + '</select></label>' +
      '<label>Público<select name="segment_id"><option value="">Filtrar acá abajo (si no elegís nada: todos los activos)</option>' + segs.map(function (s) { return opt(s.id, esc(s.name) + ' (' + num(s.count) + ')', c.segment_id); }).join('') + '</select></label>' +
      '<div id="fc-filtros">' + filtrosHtml(c.segment_id ? {} : (c.filters || {}), facets, { status: false }) + '</div>' +
      '<div class="grid g3"><label>Vigencia (TTL)<select name="ttl">' + [[3600, '1 hora'], [14400, '4 horas'], [86400, '1 día'], [259200, '3 días'], [604800, '7 días'], [2419200, '28 días']].map(function (x) { return opt(x[0], x[1], c.ttl); }).join('') + '</select></label>' +
      '<label>Urgencia<select name="urgency">' + [['very-low', 'Muy baja'], ['low', 'Baja'], ['normal', 'Normal'], ['high', 'Alta']].map(function (x) { return opt(x[0], x[1], c.urgency); }).join('') + '</select></label>' +
      '<label>Límite de frecuencia<select name="freq_cap_hours">' + [[0, 'Sin límite'], [12, 'Máx. 1 cada 12 h'], [24, 'Máx. 1 por día'], [48, 'Máx. 1 cada 2 días'], [72, 'Máx. 1 cada 3 días'], [168, 'Máx. 1 por semana']].map(function (x) { return opt(x[0], x[1], c.freq_cap_hours); }).join('') + '</select></label></div>' +
      '<div class="grid g3"><label>Cuándo<select name="mode"><option value="draft">Guardar borrador</option><option value="now">Enviar ahora</option><option value="schedule"' + (c.status === 'programada' && c.scheduled_at ? ' selected' : '') + '>Programar</option></select></label><label id="fc-cuando">Fecha y hora (Argentina)<input type="datetime-local" name="scheduled_local" value="' + localInput(c.scheduled_at) + '"></label></div>' +
      '<div id="fc-msg"></div><div class="fila"><button class="btn btn-primario" type="submit">Guardar</button>' + (id ? '<button type="button" class="btn btn-borde" id="fc-test">Enviar prueba a mi dispositivo</button>' : '') + '<a class="btn btn-texto" href="#/campanas">Volver</a></div></div>' +
      '<div class="panel previews"><h2 style="margin:0">Alcance estimado</h2><div class="kpi azul"><div class="l">Suscriptores activos que cumplen</div><div class="v" id="fc-count">…</div></div><p id="fc-desc" style="font-size:12.5px;color:#606060;margin:0"></p><div id="fc-pv"></div></div></form>';
    var form = $('#fc');
    function filtros() { var f = form.segment_id.value ? (segs.find(function (s) { return String(s.id) === form.segment_id.value; }) || {}).filters : leerFiltros($('#fc-filtros')); f = Object.assign({}, f || {}); delete f.status; return f; }
    var deb;
    async function contar() {
      if (!document.body.contains(form)) return 0;
      $('#fc-filtros').style.opacity = form.segment_id.value ? 0.4 : 1;
      $('#fc-cuando').style.display = form.mode.value === 'schedule' ? '' : 'none';
      var r = await api('/segments/count', { method: 'POST', body: { filters: filtros() } });
      $('#fc-count').textContent = num(r.count); $('#fc-desc').textContent = r.description;
      var p = ps.find(function (x) { return String(x.id) === form.piece_id.value; });
      $('#fc-pv').innerHTML = p ? previewHtml(p, cfg.settings.site_name, true) : '';
      actualizarResumen($('#fc-filtros'));
      return r.count;
    }
    form.addEventListener('change', function () { clearTimeout(deb); deb = setTimeout(contar, 150); });
    contar();
    function cuerpo() {
      var f = new FormData(form);
      return { name: f.get('name'), piece_id: Number(f.get('piece_id')), segment_id: f.get('segment_id') ? Number(f.get('segment_id')) : null, filters: filtros(), ttl: Number(f.get('ttl')), urgency: f.get('urgency'), freq_cap_hours: Number(f.get('freq_cap_hours')), mode: f.get('mode'), scheduled_local: f.get('scheduled_local') };
    }
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var b = cuerpo();
      try {
        if (b.mode === 'now') { var n = await contar(); if (!confirm('Se va a enviar AHORA a ' + num(n) + ' suscriptores (menos los que superen el límite de frecuencia). ¿Confirmás?')) return; }
        var r = id ? await api('/campaigns/' + id, { method: 'PUT', body: b }) : await api('/campaigns', { method: 'POST', body: b });
        toast(b.mode === 'now' ? 'Campaña en envío' : b.mode === 'schedule' ? 'Campaña programada' : 'Borrador guardado');
        location.hash = '#/campanas/' + (id || r.id);
      } catch (err) { $('#fc-msg').innerHTML = '<div class="alerta err">' + esc(err.message) + '</div>'; }
    });
    if ($('#fc-test')) $('#fc-test').addEventListener('click', function () { enviarPrueba('/campaigns/' + id + '/test').catch(function (e) { alert(e.message); }); });
  }

  async function reporteCampana(view, id) {
    var c = await api('/campaigns/' + id);
    var st = c.stats || {};
    var embudo = [['Destinatarios', c.total_targeted], ['Enviados', st.sent], ['Entregados', st.delivered], ['Clics', st.clicked]];
    var max = Math.max(1, c.total_targeted || 0, st.sent || 0);
    var tabla = function (rows) { return rows.length ? '<table><tr><th>Valor</th><th>Enviados</th><th>Clics</th><th>CTR</th></tr>' + rows.map(function (r) { return '<tr><td>' + esc(r.k) + '</td><td>' + num(r.sent) + '</td><td>' + num(r.clicked) + '</td><td>' + pct(r.clicked, r.sent) + '</td></tr>'; }).join('') + '</table>' : '<div class="vacio">Sin envíos</div>'; };
    view.innerHTML = '<div class="fila entre"><div><h1 class="titulo">' + esc(c.name) + '</h1><p class="sub"><span class="estado-b ' + c.status + '">' + (ESTADOS[c.status] || c.status) + '</span> · Pieza: ' + esc(c.piece_name) + ' · ' + esc(c.description) + '</p></div><div class="fila">' +
      (['borrador', 'programada'].indexOf(c.status) >= 0 ? '<a class="btn btn-borde btn-chico" href="#/campanas/' + c.id + '/editar">Editar</a>' : '') +
      '<button class="btn btn-borde btn-chico" id="rc-test">Enviar prueba</button><a class="btn btn-borde btn-chico" href="/admin/api/campaigns/' + c.id + '/sends.csv">Exportar envíos CSV</a>' +
      (['borrador', 'programada', 'enviando'].indexOf(c.status) >= 0 ? '<button class="btn btn-peligro btn-chico" id="rc-cancel">Cancelar</button>' : '') + '</div></div>' +
      '<div class="grid g4 kpis">' + kpi('Destinatarios', num(c.total_targeted), 'azul') + kpi('Enviados', num(st.sent)) + kpi('Entregados', num(st.delivered) + ' <small>' + pct(st.delivered, st.sent) + '</small>') + kpi('CTR', pct(st.clicked, st.sent)) + '</div>' +
      '<div class="grid g2" style="margin-top:14px"><div class="panel embudo"><h2>Embudo</h2><div class="barras">' + embudo.map(function (x) { return '<div class="barra"><span class="t">' + x[0] + '</span><span class="b"><i style="width:' + (100 * (x[1] || 0) / max) + '%"></i></span><span class="n">' + num(x[1]) + '</span></div>'; }).join('') + '</div>' +
      '<dl class="datos" style="margin-top:14px"><dt>Creada</dt><dd>' + fecha(c.created_at) + '</dd><dt>Programada</dt><dd>' + fecha(c.scheduled_at) + '</dd><dt>Inicio / fin</dt><dd>' + fecha(c.started_at) + ' / ' + fecha(c.finished_at) + '</dd><dt>En cola</dt><dd>' + num(st.queued) + '</dd><dt>Fallidos</dt><dd>' + num(st.failed) + '</dd><dt>Vencidas (404/410)</dt><dd>' + num(st.dead) + '</dd><dt>Omitidos por frecuencia</dt><dd>' + num(c.skipped_freq) + '</dd><dt>Cerradas sin clic</dt><dd>' + num(st.closed) + '</dd><dt>TTL / urgencia</dt><dd>' + c.ttl + ' s / ' + c.urgency + '</dd></dl></div>' +
      '<div class="panel"><h2>Clics por botón</h2>' + (c.actions.length ? barras(c.actions.map(function (a) { return { k: a.a === '0' ? 'Aviso (cuerpo)' : 'Botón ' + a.a, n: a.n }; })) : '<div class="vacio">Sin clics todavía</div>') +
      '<h2 style="margin-top:16px">Errores</h2>' + (c.errors.length ? '<table><tr><th>HTTP</th><th>Detalle</th><th>Cant.</th></tr>' + c.errors.map(function (e) { return '<tr><td>' + (e.http_status || '—') + '</td><td style="font-size:12px">' + esc(e.error) + '</td><td>' + e.n + '</td></tr>'; }).join('') + '</table>' : '<div class="vacio">Sin errores</div>') + '</div></div>' +
      '<div class="grid g3" style="margin-top:14px"><div class="panel"><h2>Por modelo</h2>' + tabla(c.by.modelo) + '</div><div class="panel"><h2>Por zona</h2>' + tabla(c.by.zona) + '</div><div class="panel"><h2>Por dispositivo</h2>' + tabla(c.by.device_type) + '</div></div>' +
      '<div class="panel" style="margin-top:14px"><h2>Pruebas enviadas</h2>' + (c.tests.length ? '<table><tr><th>Suscriptor</th><th>Estado</th><th>Enviado</th><th>Entregado</th><th>Clic</th></tr>' + c.tests.map(function (t) { return '<tr><td>#' + t.subscriber_id + '</td><td>' + esc(t.status) + (t.http_status ? ' (' + t.http_status + ')' : '') + (t.error ? ' · ' + esc(t.error) : '') + '</td><td>' + fecha(t.sent_at) + '</td><td>' + fecha(t.delivered_at) + '</td><td>' + fecha(t.clicked_at) + '</td></tr>'; }).join('') + '</table>' : '<div class="vacio">Sin pruebas</div>') + '</div>';
    $('#rc-test').addEventListener('click', function () { enviarPrueba('/campaigns/' + c.id + '/test').then(function () { ruta(); }).catch(function (e) { alert(e.message); }); });
    if ($('#rc-cancel')) $('#rc-cancel').addEventListener('click', async function () { if (confirm('¿Cancelar la campaña?')) { await api('/campaigns/' + c.id + '/cancel', { method: 'POST' }); ruta(); } });
    if (c.status === 'enviando' || c.status === 'programada') setTimeout(function () { if (location.hash === '#/campanas/' + id) ruta(); }, 5000);
  }

  // ---------- Automatizaciones (opcional) ----------
  VISTAS.automatizaciones = async function (view) {
    var res = await Promise.all([api('/automations'), api('/pieces'), api('/segments')]);
    var autos = res[0], ps = res[1], segs = res[2];
    view.innerHTML = '<h1 class="titulo">Automatizaciones <span class="badge-op">OPCIONAL</span></h1><p class="sub">Envíos automáticos por regla. Vienen apagadas: activalas solo con la pieza revisada.</p>' +
      '<div class="grid g2">' + autos.map(function (a) {
        var st = a.stats || {};
        return '<form class="panel grid" data-auto="' + a.id + '"><div class="fila entre"><h2 style="margin:0">' + esc(a.name) + '</h2><label style="flex-direction:row;display:flex;gap:8px;align-items:center"><input type="checkbox" name="enabled" style="width:auto"' + (a.enabled ? ' checked' : '') + '> Activa</label></div>' +
          '<p style="margin:0;color:#606060;font-size:13px">' + (a.type === 'welcome' ? 'Se envía una sola vez apenas alguien se suscribe (o se vuelve a suscribir).' : 'Se envía una vez cuando pasan N días desde la suscripción. Solo alcanza a quienes cumplen los N días después de activarla: no le escribe de golpe a toda la base vieja.') + '</p>' +
          '<label>Pieza<select name="piece_id"><option value="">Elegí una pieza</option>' + ps.map(function (p) { return '<option value="' + p.id + '"' + (a.piece_id === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select></label>' +
          (a.type === 'recontact' ? '<label>Días desde la suscripción<input type="number" name="days" min="1" max="365" value="' + a.days + '"></label><label>Público (copiar filtros de un segmento)<select name="seg"><option value="">Actual: ' + esc(a.description) + '</option>' + segs.map(function (s) { return '<option value="' + s.id + '">' + esc(s.name) + '</option>'; }).join('') + '<option value="-1">Todos los activos</option></select></label>' : '') +
          '<div style="font-size:12.5px;color:#606060">Enviados: ' + num(st.sent) + ' · Clics: ' + num(st.clicked) + ' · En cola: ' + num(st.queued) + '</div>' +
          '<div><button class="btn btn-primario btn-chico" type="submit">Guardar</button></div></form>';
      }).join('') + '</div>';
    $$('form[data-auto]', view).forEach(function (f) {
      f.addEventListener('submit', async function (e) {
        e.preventDefault();
        var a = autos.find(function (x) { return String(x.id) === f.dataset.auto; });
        var body = { enabled: f.enabled.checked, piece_id: f.piece_id.value ? Number(f.piece_id.value) : null, days: f.days ? Number(f.days.value) : 0 };
        if (f.seg && f.seg.value) body.filters = f.seg.value === '-1' ? {} : (segs.find(function (s) { return String(s.id) === f.seg.value; }) || {}).filters; else body.filters = a.filters;
        try { await api('/automations/' + a.id, { method: 'PUT', body: body }); toast('Automatización guardada'); ruta(); } catch (err) { alert(err.message); }
      });
    });
  };

  // ---------- Links de suscripción ----------
  VISTAS.links = async function (view) {
    var cfg = await api('/settings');
    var campos = [['marca', 'Marca', 'PEUGEOT'], ['modelo', 'Modelo', '208'], ['tel', 'Teléfono del cliente (opcional)', '11 5555-1234'], ['asesor', 'Asesor', ''], ['origen', 'Origen', 'presupuesto'], ['campana', 'Campaña', ''], ['utm_source', 'utm_source', ''], ['utm_medium', 'utm_medium', ''], ['utm_campaign', 'utm_campaign', ''], ['tags', 'Etiquetas extra (coma)', '']];
    view.innerHTML = '<h1 class="titulo">Links de suscripción</h1><p class="sub">Armá el link para presupuestos, QR, redes o firmas. Cada parámetro queda como etiqueta del suscriptor.</p>' +
      '<form id="fl" class="panel grid g3">' + campos.map(function (x) { return '<label>' + x[1] + '<input name="' + x[0] + '" placeholder="' + esc(x[2]) + '"></label>'; }).join('') + '</form>' +
      '<div class="panel" style="margin-top:14px"><h2>Link</h2><div class="mono" id="fl-url"></div><div class="fila" style="margin-top:10px"><button class="btn btn-negro btn-chico" id="fl-copy">Copiar</button><a class="btn btn-borde btn-chico" id="fl-open" target="_blank" rel="noopener">Abrir</a></div>' +
      '<p style="font-size:12.5px;color:#606060">Ejemplo para Pilot Solution (cuando se integre): ' + esc(cfg.baseUrl) + '/s?marca=PEUGEOT&amp;modelo=*|SALE_PRODUCT_MODEL|*&amp;origen=presupuesto. El teléfono se normaliza (saca 0, 15 y +54 9) y se guarda como huella; la landing lo borra de la barra de direcciones.</p>' +
      (cfg.https ? '' : '<div class="alerta">BASE_URL no es HTTPS: sirve para probar en localhost, pero en producción WebPush exige HTTPS.</div>') + '</div>';
    var f = $('#fl');
    function armar() { var u = new URL(cfg.baseUrl + '/s'); new FormData(f).forEach(function (v, k) { if (String(v).trim()) u.searchParams.set(k, String(v).trim()); }); $('#fl-url').textContent = u.toString(); $('#fl-open').href = u.toString(); }
    f.addEventListener('input', armar); armar();
    $('#fl-copy').addEventListener('click', function () { navigator.clipboard.writeText($('#fl-url').textContent).then(function () { toast('Link copiado'); }); });
  };

  // ---------- Configuración ----------
  async function suscribirPrueba() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Este navegador no soporta WebPush');
    var perm = await Notification.requestPermission(); if (perm !== 'granted') throw new Error('Permiso de notificaciones no concedido');
    var reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' }); await navigator.serviceWorker.ready;
    var pc = await (await fetch('/api/public-config')).json();
    var k = pc.vapidPublicKey; var pad = '='.repeat((4 - k.length % 4) % 4); var raw = atob((k + pad).replace(/-/g, '+').replace(/_/g, '/')); var key = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) key[i] = raw.charCodeAt(i);
    var sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    var r = await fetch('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), meta: { origen: 'admin-prueba', tags: ['equipo-interno'], lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } }) });
    if (!r.ok) throw new Error('El servidor respondió ' + r.status);
    var me = await api('/me/device', { method: 'POST', body: { endpoint: sub.endpoint } });
    if (!me.id) throw new Error('No se encontró la suscripción');
    localStorage.setItem('wp_test_sub', me.id);
    return me.id;
  }

  VISTAS.config = async function (view) {
    var c = await api('/settings');
    var esAdmin = S.user.role === 'admin';
    var admins = esAdmin ? await api('/admins') : [];
    var st = c.settings;
    var campos = [['site_name', 'Nombre del sitio'], ['logo_url', 'Logo (URL)'], ['icon_url', 'Ícono de notificaciones (URL, 192x192)'], ['badge_url', 'Badge Android (URL, monocromo 96x96)'], ['optin_title', 'Título del opt-in'], ['optin_text', 'Texto del opt-in', 1], ['optin_button', 'Texto del botón'], ['consent_text', 'Texto de consentimiento', 1], ['success_text', 'Mensaje al suscribirse', 1], ['default_url', 'URL por defecto'], ['privacy_contact', 'Contacto de privacidad']];
    var badge = function (ok, si, no) { return ok ? '<span class="estado-b finalizada">' + si + '</span>' : '<span class="estado-b cancelada">' + no + '</span>'; };
    view.innerHTML = '<h1 class="titulo">Configuración</h1><p class="sub">Textos de la landing, identidad, claves y usuarios.</p>' +
      '<div class="grid g2"><form class="panel grid" id="fs"><h2>Sitio y textos del opt-in</h2>' + campos.map(function (x) { return '<label>' + x[1] + (x[2] ? '<textarea name="' + x[0] + '">' + esc(st[x[0]] || '') + '</textarea>' : '<input name="' + x[0] + '" value="' + esc(st[x[0]] || '') + '">') + '</label>'; }).join('') + (esAdmin ? '<div><button class="btn btn-primario" type="submit">Guardar</button></div>' : '<div class="alerta">Solo un admin puede cambiar la configuración.</div>') + '</form>' +
      '<div class="grid" style="align-content:start"><div class="panel"><h2>Servidor</h2><dl class="datos"><dt>Dominio (BASE_URL)</dt><dd>' + esc(c.baseUrl) + ' ' + badge(c.https, 'HTTPS', 'sin HTTPS') + '</dd><dt>Base de datos</dt><dd>' + esc(c.dbDriver) + '</dd><dt>Zona horaria</dt><dd>' + esc(c.timezone) + '</dd><dt>API de integración</dt><dd>' + badge(c.apiEnabled, 'activa (ADMIN_KEY)', 'falta ADMIN_KEY') + '</dd><dt>Teléfonos</dt><dd>' + (c.phoneEncryption ? 'Huella + cifrado reversible (PHONE_ENC_KEY)' : 'Solo huella irreversible') + '</dd><dt>Claves VAPID</dt><dd>' + esc(c.vapidSource) + '</dd><dt>VAPID_SUBJECT</dt><dd>' + esc(c.vapidSubject) + '</dd></dl>' +
      '<label style="margin-top:10px">Clave pública VAPID (la privada nunca se muestra)<textarea readonly class="mono" rows="3">' + esc(c.vapidPublicKey) + '</textarea></label></div>' +
      '<div class="panel"><h2>Dispositivo de prueba</h2><p style="font-size:13px;color:#606060;margin-top:0">Suscribí este navegador para recibir las pruebas de piezas y campañas. Queda con origen "admin-prueba" y etiqueta "equipo-interno".</p><div id="dev-msg"></div><div class="fila"><button class="btn btn-negro btn-chico" id="dev-sub">Suscribir este navegador como prueba</button><span id="dev-id" style="color:#606060"></span></div></div>' +
      (esAdmin ? '<div class="panel"><h2>Migrar suscriptores</h2><p style="font-size:13px;color:#606060;margin-top:0">Export / import JSON completo. Incluye las claves de cada suscripción: tratarlo como dato sensible. Para que sigan funcionando hay que usar las MISMAS claves VAPID en el hosting nuevo.</p><div class="fila"><a class="btn btn-borde btn-chico" href="/admin/api/export.json">Exportar JSON</a><label class="btn btn-borde btn-chico" style="display:inline-flex">Importar JSON<input type="file" id="imp" accept="application/json" class="oculto"></label></div><div id="imp-msg"></div></div>' : '') +
      '</div></div><div class="grid g2" style="margin-top:14px">' +
      (esAdmin ? '<div class="panel"><h2>Usuarios del panel</h2><table><tr><th>Usuario</th><th>Rol</th><th>Último ingreso</th><th></th></tr>' + admins.map(function (a) { return '<tr><td>' + esc(a.username) + '</td><td>' + a.role + '</td><td>' + fecha(a.last_login_at) + '</td><td><button class="btn btn-texto btn-chico" data-deladm="' + a.id + '">Borrar</button></td></tr>'; }).join('') + '</table>' +
        '<form id="fa" class="grid g3" style="margin-top:12px"><label>Usuario<input name="username" required></label><label>Contraseña (10+)<input name="password" type="password" required minlength="10" autocomplete="new-password"></label><label>Rol<select name="role"><option value="admin">admin</option><option value="editor">editor (sin usuarios ni configuración)</option></select></label><div><button class="btn btn-negro btn-chico" type="submit">Agregar usuario</button></div></form></div>' : '') +
      '<form class="panel grid" id="fpw"><h2>Cambiar mi contraseña</h2><label>Actual<input type="password" name="current" required autocomplete="current-password"></label><label>Nueva (10+)<input type="password" name="next" required minlength="10" autocomplete="new-password"></label><div><button class="btn btn-borde btn-chico" type="submit">Cambiar</button></div></form></div>';

    var fs = $('#fs');
    fs.addEventListener('submit', async function (e) { e.preventDefault(); var b = {}; new FormData(fs).forEach(function (v, k) { b[k] = v; }); try { await api('/settings', { method: 'PUT', body: b }); toast('Configuración guardada'); } catch (err) { alert(err.message); } });
    $('#fpw').addEventListener('submit', async function (e) { e.preventDefault(); var f = e.target; try { await api('/me/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } }); f.reset(); toast('Contraseña cambiada'); } catch (err) { alert(err.message); } });
    if ($('#fa')) $('#fa').addEventListener('submit', async function (e) { e.preventDefault(); var f = e.target; try { await api('/admins', { method: 'POST', body: { username: f.username.value, password: f.password.value, role: f.role.value } }); toast('Usuario creado'); ruta(); } catch (err) { alert(err.message); } });
    view.onclick = async function (e) { if (e.target.dataset.deladm && confirm('¿Borrar el usuario?')) { try { await api('/admins/' + e.target.dataset.deladm, { method: 'DELETE' }); ruta(); } catch (err) { alert(err.message); } } };
    if ($('#imp')) $('#imp').addEventListener('change', async function (e) {
      var file = e.target.files[0]; if (!file) return;
      try { var data = JSON.parse(await file.text()); var r = await api('/import.json', { method: 'POST', body: data }); $('#imp-msg').innerHTML = '<div class="alerta ok">Importados: ' + r.inserted + ' nuevos, ' + r.updated + ' actualizados, ' + r.skipped + ' omitidos.</div>' + (r.warning ? '<div class="alerta">' + esc(r.warning) + '</div>' : ''); } catch (err) { $('#imp-msg').innerHTML = '<div class="alerta err">' + esc(err.message) + '</div>'; }
    });
    var tid = localStorage.getItem('wp_test_sub');
    $('#dev-id').textContent = tid ? 'Actual: suscriptor #' + tid : 'Sin dispositivo de prueba';
    $('#dev-sub').addEventListener('click', async function () {
      try { var nid = await suscribirPrueba(); $('#dev-id').textContent = 'Actual: suscriptor #' + nid; $('#dev-msg').innerHTML = '<div class="alerta ok">Listo: este navegador es el suscriptor #' + nid + ' y recibe las pruebas.</div>'; }
      catch (err) { $('#dev-msg').innerHTML = '<div class="alerta err">' + esc(err.message) + '</div>'; }
    });
  };

  iniciar();
})();
