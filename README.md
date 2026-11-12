# WebPush Giama — generador y administrador de avisos push

App web propia (Node.js, sin servicios pagos) para:

- **Suscribir** gente a notificaciones push desde una landing mobile first (`/s`), solo con opt-in explícito.
- **Etiquetar** automáticamente a cada suscriptor (marca, modelo, prefijo 011/AMBA vs. Interior, dispositivo, sistema, navegador, origen, campaña, asesor, UTM, fecha/franja horaria, idioma) y también a mano.
- **Administrar** público, segmentos, piezas (avisos) y campañas desde un panel (`/admin`), con métricas reales de envío, entrega y clic.

> Identidad visual por defecto: Peugeot Giama. Todo es reemplazable (ver *Marca y piezas*).

---

## 1. Arranque rápido (local)

Requisitos: **Node.js 22.13 o superior**.

```bash
npm install
cp .env.example .env          # completá ADMIN_PASSWORD (8+ caracteres) y ADMIN_KEY
npm run vapid                 # genera las claves VAPID y las escribe en .env (no imprime la privada)
npm start                     # crea el esquema solo; abre http://localhost:3000
```

- Landing: `http://localhost:3000/s`
- Panel: `http://localhost:3000/admin` (usuario `ADMIN_USER`, por defecto `admin`, contraseña `ADMIN_PASSWORD`)
- Salud: `http://localhost:3000/health` → `{"ok":true,"service":"webpush",...}`

Si no definís las claves VAPID, la app las genera la primera vez y las guarda **en la base**. Funciona, pero es mejor fijarlas en variables de entorno: si se pierden o cambian, **todas las suscripciones dejan de servir**.

Datos de ejemplo (opcional, para ver el panel con contenido):

```bash
npm run seed            # 80 suscriptores FICTICIOS (endpoints https://ejemplo.invalid), etiqueta "datos-de-ejemplo"
npm run seed -- --borrar   # borra todo lo de ejemplo
```

El seed se niega a correr con `NODE_ENV=production` salvo `--force`. Nunca lo uses en la base real.

Otros comandos: `npm run dev` (recarga al guardar), `npm test`, `npm run test:node-sqlite`, `npm run lint`.

### HTTPS

Web Push **exige HTTPS** (salvo `localhost` para pruebas). En producción necesitás un dominio o subdominio con certificado, por ejemplo `avisos.tudominio.com.ar` o el `*.onrender.com` que da Render. Configurá `BASE_URL` con esa URL.

---

## 2. Variables de entorno

Todas están en [`.env.example`](.env.example). Las importantes:

| Variable | Para qué |
|---|---|
| `PORT` | Puerto HTTP (lo toma de la plataforma si lo define). |
| `BASE_URL` | URL pública https. |
| `ADMIN_PASSWORD` | Contraseña del primer admin (mín. 8). Sin ella el panel queda bloqueado. |
| `ADMIN_KEY` | API key para la API externa y `/api/cron/tick`. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Claves Web Push y contacto `mailto:`. |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Si están, la base es Turso (libSQL remoto). |
| `DB_PATH` | Archivo SQLite local (se usa si no hay Turso). |
| `PHONE_HASH_SECRET` | Secreto de la huella del teléfono. No cambiarlo después de tener datos. |
| `PHONE_ENC_KEY` | Opcional: guarda además el teléfono cifrado (AES-256-GCM) y lo muestra en el panel. |
| `BRAND_DIR` | Carpeta con logo/íconos propios que pisan los de `public/brand`. |
| `TRUST_PROXY` | `true` detrás de Render/Nginx/Cloudflare. |
| `MAX_UPLOAD_KB` | Tope de imagen subida (por defecto 700 KB). |

`UPLOADS_DIR` **no se usa**: las imágenes subidas se guardan dentro de la base (tabla `media`) para no depender del disco del hosting. También se puede usar una URL externa (https) en cada pieza.

En **Vercel** y **Netlify**, `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` son obligatorios (el filesystem no persiste). `TICK_BUDGET_MS` e `INLINE_SEND_MAX` aplican al envío por tandas. Detalle en las secciones de despliegue.

Los secretos van **solo** en `.env` o en el panel de variables del hosting. Nunca en el repositorio.

---

## 3. Base de datos

La app habla con la base a través de un adaptador asíncrono (`src/db.js`) con dos drivers:

- **libsql** (por defecto, `@libsql/client`): Turso remoto si hay `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`; si no, archivo local `file:` en `DB_PATH`.
- **node-sqlite** (`DB_DRIVER=node-sqlite`): el SQLite nativo de Node, solo archivo local.

Todas las consultas son SQL estándar de SQLite y corren igual en los dos. El esquema se crea solo al arrancar (`CREATE TABLE IF NOT EXISTS`). Detalle en [`docs/modelo-de-datos.md`](docs/modelo-de-datos.md).

**Importante:**

- Con archivo SQLite necesitás **disco persistente** (volumen Docker, disco de Render pago, VPS). Sin eso, cada reinicio borra todo.
- Con Turso no hace falta disco. Cada consulta es un viaje de red: el panel es algo más lento que con archivo local. Los envíos se arman con pocas consultas grandes para que no pese.
- Las cascadas (borrar suscriptor → sus envíos y etiquetas) se hacen en el código, sin depender de `foreign_keys`.
- La app corre como **una sola instancia**. No la escales horizontalmente (el lock de transacciones es por proceso).

### Backups

- **Archivo local:** copiá `DB_PATH` con la app parada, o en caliente con `sqlite3 webpush.db ".backup copia.db"`.
- **Turso:** `turso db shell <base> .dump > backup.sql`, o los backups/point-in-time de Turso.
- **Desde el panel:** *Público → Exportar JSON* (solo rol admin) baja suscriptores con claves de suscripción y etiquetas; *Importar JSON* los recupera en otra instalación. Las suscripciones importadas solo funcionan si se usan **las mismas claves VAPID**.
- *Exportar CSV* sirve para análisis (no incluye teléfonos ni claves).

---

## 4. Desplegar en Render (free) + Turso paso a paso

El plan free de Render **duerme el servicio tras ~15 min sin tráfico** y **su disco no persiste**. Por eso: base en Turso, imágenes en la base, y las campañas programadas no dependen de un cron en memoria.

1. **Turso** (https://turso.tech, plan gratis):
   ```bash
   turso db create webpush-giama
   turso db show webpush-giama --url        # → TURSO_DATABASE_URL (libsql://...)
   turso db tokens create webpush-giama     # → TURSO_AUTH_TOKEN
   ```
2. **Claves VAPID** en tu máquina: `npm run vapid -- --print`. Guardalas en un gestor de contraseñas.
3. **Repo**: subí este proyecto a GitHub/GitLab (el `.gitignore` ya excluye `.env`, `node_modules` y bases).
4. **Render → New → Blueprint** y elegí el repo. Lee `render.yaml` y te pide los valores `sync: false`:
   `BASE_URL`, `ADMIN_PASSWORD`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`. `ADMIN_KEY` y `PHONE_HASH_SECRET` se generan solos; copiá `ADMIN_KEY` desde *Environment*.
5. Deploy. Verificá `https://<tu-servicio>.onrender.com/health`.
6. **Ping externo cada 5 minutos** (cron-job.org, UptimeRobot, GitHub Actions, etc.):
   ```
   GET https://<tu-servicio>.onrender.com/api/cron/tick
   Header: Authorization: Bearer <ADMIN_KEY>      (o X-API-Key: <ADMIN_KEY>)
   ```
   Si el servicio de ping no permite headers: `.../api/cron/tick?key=<ADMIN_KEY>` (queda la key en los logs del proveedor; preferí el header).

   El tick procesa campañas programadas vencidas, reintentos y automatizaciones. Además, **cualquier visita** (landing, panel, clic) despierta el servidor y procesa lo pendiente. Ojo: el ping cada 5 min también mantiene el servicio despierto y consume horas del plan free (alcanzan para un servicio 24/7, pero revisá los límites vigentes de Render).
7. Dominio propio (opcional): en Render *Settings → Custom Domain*, apuntá un CNAME y actualizá `BASE_URL`.

Precisión del horario: una campaña programada sale como mucho ~5 min después (intervalo del ping).

---


## 5. Despliegue en Vercel (plan Hobby, gratis, sin tarjeta)

Vercel no deja un proceso corriendo: cada pedido arranca (o reutiliza) una función con un tope de **10 segundos** en el plan Hobby, y el disco es **efímero**. Por eso:

- La base **tiene que ser Turso**. Si falta `TURSO_DATABASE_URL` o `TURSO_AUTH_TOKEN`, la app no arranca (mensaje claro en los logs).
- No hay `setInterval` ni programador en memoria. Las campañas programadas y los envíos grandes se procesan **por tandas** en cada llamada a `/api/cron/tick` (y, de yapa, en las visitas). Cada tanda termina holgada dentro de esos 10 s; el resto queda en la base y se retoma en el próximo ping.
- Una campaña chica (hasta `INLINE_SEND_MAX`, por defecto 40 suscriptores) se puede enviar en el mismo pedido. Una grande queda encolada.
- `BASE_URL` tiene que ser la URL pública `https://...` (links de clic, íconos e imágenes). Si falta, se usa `https://$VERCEL_URL` como respaldo, pero en producción definila vos (un deploy de preview tiene otra URL).

### Variables a cargar en Vercel

En *Project → Settings → Environment Variables* (Production, y Preview si querés probar):

| Variable | Obligatoria | Notas |
|---|---|---|
| `BASE_URL` | sí (prod) | Ej. `https://avisos.tudominio.com.ar` o `https://webpush-giama.vercel.app` |
| `NODE_ENV` | sí | `production` |
| `ADMIN_PASSWORD` | sí | Mínimo 8 caracteres. Usuario `admin` si no definís `ADMIN_USER`. |
| `ADMIN_KEY` | sí | API key para `/api/*` y el ping de `/api/cron/tick`. |
| `VAPID_PUBLIC_KEY` | sí | Generadas una sola vez con `npm run vapid -- --print`. |
| `VAPID_PRIVATE_KEY` | sí | **No las cambies nunca** después de tener suscriptores: si cambian, todas las suscripciones dejan de funcionar. |
| `VAPID_SUBJECT` | sí | `mailto:alguien@tudominio.com.ar` |
| `TURSO_DATABASE_URL` | sí | `libsql://...turso.io` |
| `TURSO_AUTH_TOKEN` | sí | Token de Turso |
| `PHONE_HASH_SECRET` | sí | No cambiarlo después de tener datos. |
| `ADMIN_USER` | no | Por defecto `admin`. |
| `PHONE_ENC_KEY` | no | Si la definís, el panel puede mostrar el teléfono (queda cifrado). |
| `APP_TIMEZONE` | no | Por defecto `America/Argentina/Buenos_Aires`. |
| `MAX_UPLOAD_KB` | no | Por defecto 700. |
| `TICK_BUDGET_MS` | no | Presupuesto de cada tick (por defecto 8000 en Vercel). |
| `INLINE_SEND_MAX` | no | Tope para envío en línea (por defecto 40). |
| `SEND_BATCH_SIZE` / `SEND_CONCURRENCY` | no | Por defecto 40 y 8 en Vercel. |

`VERCEL=1` y `TRUST_PROXY` los resuelve la propia plataforma (el proxy se activa solo). No hace falta `DB_PATH` ni `PORT`.

### Paso a paso

1. Creá la base en Turso (igual que en la sección de Render) y guardá URL y token.
2. En tu máquina: `npm run vapid -- --print` y guardá las claves en un gestor de contraseñas (no las pegues en tickets ni chats).
3. Subí este repo a GitHub (por ejemplo `https://github.com/giama-webpush/webpush-giama`). El `.gitignore` ya excluye `.env`, `node_modules` y bases.
4. En [vercel.com](https://vercel.com) → *Add New → Project* → importá el repo. Framework preset: **Other** (ya está `framework: null` en `vercel.json`).
5. Cargá las variables de la tabla. Deploy.
6. Cuando tengas la URL, poné `BASE_URL=https://<tu-proyecto>.vercel.app` (o tu dominio) y redesplegá si hace falta.
7. Verificá `https://<tu-dominio>/health` y el panel en `/admin`.
8. **Ping externo cada 5 minutos** a `/api/cron/tick` (el cron propio de Vercel en Hobby es una vez por día, no alcanza). Dos opciones gratis:

   **cron-job.org** (u otro ping): `POST` (o `GET`) `https://<tu-dominio>/api/cron/tick` cada 5 min, header `Authorization: Bearer <ADMIN_KEY>`. Si el servicio no permite headers: `...?key=<ADMIN_KEY>` (la clave queda en sus logs; preferí el header).

   **GitHub Actions** en este mismo repo: ya está el workflow [`.github/workflows/webpush-tick.yml`](.github/workflows/webpush-tick.yml). En el repo (`Settings → Secrets and variables → Actions`) creá:
   - `WEBPUSH_TICK_URL` = `https://<tu-dominio>/api/cron/tick`
   - `ADMIN_KEY` = la misma clave que en Vercel  
   En un repo público el `schedule` de GitHub a veces se atrasá un poco (no es exacto al minuto). También se puede disparar a mano (*Actions → webpush-tick → Run workflow*).

**Importante:** no cambies las claves VAPID una vez que haya suscriptores.

Para probar el handler en local alcanza `npm start` (o los tests que importan `api/index.js`). `vercel dev` exige iniciar sesión en Vercel; si lo usás, `VERCEL_ENV=development` permite SQLite local. Local, Docker y Render siguen igual: `npm start` o la imagen, con programador en memoria mientras el proceso esté despierto. El ping no molesta si también lo usás ahí.


## 6. Despliegue en Netlify (plan Free)

Netlify Functions corre cada pedido en una función (tope ~26–60 s en sincrónicas; **30 s** en las programadas). El disco es **efímero**, así que:

- La base **tiene que ser Turso**. Si falta `TURSO_DATABASE_URL` o `TURSO_AUTH_TOKEN`, la app no arranca (salvo `netlify dev` / `NETLIFY_DEV`, que pueden usar SQLite local).
- No hay programador en memoria. Las campañas se procesan por tandas (~8 s) y se retoman en el próximo tick.
- El plan **Free incluye Scheduled Functions** (está en todos los planes). Esta app trae `netlify/functions/tick-scheduled.js` con cron `*/5 * * * *` (UTC) que llama al tick **en directo**, sin HTTP ni `ADMIN_KEY`. Reemplaza el ping externo en este hosting.
- El cron **solo corre solo en el deploy publicado** (producción). En Deploy Preview hay que dispararlo a mano desde *Functions → tick-scheduled → Run now*.
- `BASE_URL` es la URL pública `https://...`. Si falta, se usa `process.env.URL` (la que Netlify define sola).

Un ping cada 5 min, 8 s a 1 GB, consume del orden de ~10 créditos/mes de los 300 del plan Free (más el tráfico normal de la landing y el panel). Si se acaban los créditos, el sitio se pausa hasta el mes siguiente.

### Variables a cargar en Netlify

En *Site configuration → Environment variables* (o *Project configuration → Environment variables*), para *Production*:

| Variable | Obligatoria | Notas |
|---|---|---|
| `BASE_URL` | sí (prod) | Ej. `https://webpush-giama.netlify.app` o tu dominio |
| `NODE_ENV` | sí | `production` |
| `ADMIN_PASSWORD` | sí | Mínimo 8 caracteres. Usuario `admin` si no definís `ADMIN_USER`. |
| `ADMIN_KEY` | sí | Sigue sirviendo para la API (`/api/subscribers/tag`, `/api/campaigns/send`) y para un ping de respaldo a `/api/cron/tick`. El cron interno no la usa. |
| `VAPID_PUBLIC_KEY` | sí | Generadas una sola vez con `npm run vapid -- --print`. |
| `VAPID_PRIVATE_KEY` | sí | **No las cambies nunca** después de tener suscriptores. |
| `VAPID_SUBJECT` | sí | `mailto:alguien@tudominio.com.ar` |
| `TURSO_DATABASE_URL` | sí | `libsql://...turso.io` |
| `TURSO_AUTH_TOKEN` | sí | Token de Turso |
| `PHONE_HASH_SECRET` | sí | No cambiarlo después de tener datos. |
| `ADMIN_USER` | no | Por defecto `admin`. |
| `PHONE_ENC_KEY` | no | Si la definís, el panel puede mostrar el teléfono (queda cifrado). |
| `APP_TIMEZONE` | no | Por defecto `America/Argentina/Buenos_Aires`. |
| `MAX_UPLOAD_KB` | no | Por defecto 700. |
| `TICK_BUDGET_MS` | no | Por defecto 8000 en serverless. |
| `INLINE_SEND_MAX` | no | Por defecto 40. |
| `SEND_BATCH_SIZE` / `SEND_CONCURRENCY` | no | Por defecto 40 y 8 en serverless. |

`NETLIFY`, `URL` y `TRUST_PROXY` los resuelve la plataforma. No hace falta `DB_PATH` ni `PORT`.

### Paso a paso

1. Creá la base en Turso y guardá URL y token.
2. En tu máquina: `npm run vapid -- --print` y guardá las claves en un gestor de contraseñas (no las pegues en tickets ni chats).
3. El repo (por ejemplo `https://github.com/giama-webpush/webpush-giama`) ya trae `netlify.toml`.
4. En [app.netlify.com](https://app.netlify.com) → *Add new site → Import an existing project* → GitHub → elegí `giama-webpush/webpush-giama`.
5. La config de build se lee sola del `netlify.toml` (comando de build inocuo, *publish* `public`, *functions* `netlify/functions`, Node 22, esbuild con `@libsql/client` externo y `public/**` incluido). No hace falta un framework.
6. Cargá las variables de la tabla **antes** del primer deploy (o redesplegá después).
7. Deploy. Verificá `https://<sitio>.netlify.app/health`, la landing `/s` y el panel `/admin`.
8. En *Functions* tiene que aparecer `tick-scheduled` con el badge *Scheduled* y la próxima ejecución. Podés pulsar *Run now* para probar. No hace falta cron-job.org ni GitHub Actions en Netlify; esos quedan como respaldo o para Vercel/Render.

**Importante:** no cambies las claves VAPID una vez que haya suscriptores.

Para probar el handler en local, `npx netlify functions:serve --offline` (no pide login) o `npm start`. `netlify dev` sí puede pedir cuenta.

## 7. Docker / VPS

```bash
docker build -t webpush-giama .
docker run -d --name webpush -p 3000:3000 --env-file .env -v webpush-data:/data webpush-giama
```

La imagen usa `DB_PATH=/data/webpush.db`: el volumen `/data` es obligatorio si no usás Turso. Trae `HEALTHCHECK` contra `/health`. Detrás de Nginx/Caddy con https poné `TRUST_PROXY=true`.

Sin Docker: `npm ci --omit=dev && npm start` con un gestor tipo systemd o pm2. El servidor ya corre su propio programador mientras está despierto, así que en un VPS el ping no hace falta (no molesta).

---

## 8. Cómo se usa

### Links de suscripción
En *Links de suscripción* armás URLs como:

```
https://avisos.tudominio.com.ar/s?marca=PEUGEOT&modelo=2008&origen=presupuesto&asesor=Juan%20Perez&tel=1155551234&utm_source=presupuesto
```

Parámetros: `marca`, `modelo`, `origen`, `campana`, `asesor`, `tel`, `utm_*`. Todo es opcional. El `tel` se borra de la barra de direcciones al cargar; se guarda como huella (HMAC) y se deriva el área (`011` → AMBA, resto → Interior + provincia). Ese link se puede pegar en un presupuesto, un QR del salón, Instagram, etc.

### Etiquetas automáticas
Al suscribirse se agregan `marca:`, `modelo:`, `zona:`, `prefijo:0xx`, `dispositivo:`, `so:`, `origen:` además de los campos filtrables (navegador, campaña, asesor, franja horaria, idioma, UTM). Podés sumar etiquetas manuales en el panel (en lote) o por API.

### Público y segmentos
Filtros combinables (Y entre campos, O dentro de un campo), conteo en vivo, segmentos guardados, etiquetado masivo, CSV y JSON.

### Piezas
Título, texto, imagen grande (ideal 1024×512), ícono, URL, hasta 2 botones, variables `{{marca}}`, `{{modelo}}`, `{{asesor}}` con valor por defecto (`{{modelo|tu Peugeot}}`), UTM automáticos y vista previa Android/iOS/escritorio.

### Campañas
Envío ahora o programado (hora Argentina), tope de frecuencia, TTL, urgencia, envío por lotes con reintentos, baja automática de suscripciones vencidas (404/410), cancelar, duplicar, prueba a un suscriptor, reporte con entregas, clics por botón y desglose por modelo/zona/dispositivo.

### Automatizaciones (opcionales, vienen apagadas)
- **Bienvenida:** aviso al suscribirse.
- **Recontacto:** aviso a los N días.

### iPhone
iOS solo recibe push desde la web **instalada en pantalla de inicio** (iOS/iPadOS 16.4+). La landing lo detecta y muestra las instrucciones. En Android y escritorio funciona en Chrome, Edge, Firefox, Samsung Internet y Opera.

---

## 9. Marca y piezas

Los archivos de marca están en `public/brand/` (íconos simples generados a partir del logo, fáciles de reemplazar):

| Archivo | Tamaño |
|---|---|
| `logo.png` | horizontal, fondo transparente |
| `icon-192.png`, `icon-512.png` | ícono de la app / notificación |
| `icon-maskable-512.png` | ícono Android con margen de seguridad (zona útil 80 %) |
| `apple-touch-icon.png` | 180×180 |
| `badge-96.png` | monocromo blanco sobre transparente (barra de Android) |
| `favicon.png` | 32/48 px |
| `pieza-ejemplo-1024x512.png` | ejemplo de imagen de pieza |

Para usar los definitivos sin tocar el código: dejalos con esos nombres en una carpeta y apuntá `BRAND_DIR` a ella (por ejemplo `BRAND_DIR=/workspace/webpush-app-assets`). Lo que esté ahí tiene prioridad sobre `public/brand`. Las imágenes de piezas (1024×512, JPG/PNG/WebP, hasta `MAX_UPLOAD_KB`) se suben desde *Piezas*. El logo y textos de la landing también se cambian en *Configuración*.

---

## 10. Privacidad y seguridad

- Solo opt-in: el navegador pide permiso únicamente cuando la persona toca **Quiero recibir las ofertas**. Texto de consentimiento y `/privacidad` editables. **La política de privacidad es un borrador: revisarla legalmente** (Ley 25.326, AAIP) antes de publicar.
- Baja en un toque desde la landing o `/baja`, y desde el navegador. Las bajas no reciben más avisos.
- El teléfono **no se guarda en claro** por defecto (solo huella HMAC + área). Con `PHONE_ENC_KEY` se guarda además cifrado.
- Panel: contraseña con scrypt, cookie de sesión `HttpOnly` + `SameSite=Strict` (+ `Secure` en producción), token CSRF y chequeo de `Origin`, roles `admin`/`editor`, registro de auditoría.
- Rate limit en suscripción, login y API. CSP sin JavaScript inline. `/health` no expone nada sensible. La clave VAPID privada nunca sale del servidor.

---

## 11. API

Autenticación: `Authorization: Bearer <ADMIN_KEY>` o `X-API-Key: <ADMIN_KEY>`. Detalle en [`docs/api.md`](docs/api.md).

```bash
# Etiquetar por teléfono (se compara por huella)
curl -X POST https://avisos.tudominio.com.ar/api/subscribers/tag \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"phone":"11 5555-1234","add":["presupuesto-enviado"],"remove":["frio"]}'

# Mandar una campaña a un segmento por filtros (dry_run:true solo cuenta)
curl -X POST https://avisos.tudominio.com.ar/api/campaigns/send \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Promo 208 AMBA","piece_id":3,"filters":{"modelo":["208"],"zona":["AMBA"]},"scheduled_at":"2026-11-10T10:00:00-03:00"}'
```

---

## 12. Estructura

```
src/            servidor (Express 5): config, db (adaptador), rutas, envío push, segmentos, teléfonos
public/         landing, service worker, panel (SPA sin build), marca
api/            handler serverless para Vercel
netlify/        Functions para Netlify (app HTTP + tick-scheduled cada 5 min)
scripts/        vapid.js, seed.js
test/           tests (node:test) con push simulado
docs/           modelo de datos, API, capturas
```

## 13. Limitaciones conocidas

- Probado de punta a punta con Chrome de escritorio (FCM). No probado aún en iPhone real, Safari macOS, Firefox ni Android físico.
- Turso remoto, Render y Vercel no se probaron con un deploy real desde acá. En Netlify se probó `netlify functions:serve --offline` (sin login): `/health`, `/s`, `/sw.js` y el ícono de marca respondieron bien. El cron programado en producción no se llegó a ver publicado.
- En Vercel Hobby cada función dura como máximo 10 s; en Netlify el tick programado tiene 30 s. Un envío grande se completa en varias tandas (cada 5 min).
- El cron interno de Netlify solo corre en el deploy de producción publicado (no en previews).
- El rate limit es por instancia en memoria: en serverless no se comparte entre invocaciones (es una red de contención, no un cupo global).
- Una sola instancia en local/Docker/Render. Para decenas de miles de suscriptores por campaña conviene un VPS con archivo local o subir `SEND_CONCURRENCY`.
- Las métricas de "entregado" dependen de que el service worker reporte; algunos navegadores lo limitan, así que es un mínimo.
