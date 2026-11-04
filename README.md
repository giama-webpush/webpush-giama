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

## 5. Docker / VPS

```bash
docker build -t webpush-giama .
docker run -d --name webpush -p 3000:3000 --env-file .env -v webpush-data:/data webpush-giama
```

La imagen usa `DB_PATH=/data/webpush.db`: el volumen `/data` es obligatorio si no usás Turso. Trae `HEALTHCHECK` contra `/health`. Detrás de Nginx/Caddy con https poné `TRUST_PROXY=true`.

Sin Docker: `npm ci --omit=dev && npm start` con un gestor tipo systemd o pm2. El servidor ya corre su propio programador mientras está despierto, así que en un VPS el ping no hace falta (no molesta).

---

## 6. Cómo se usa

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

## 7. Marca y piezas

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

## 8. Privacidad y seguridad

- Solo opt-in: el navegador pide permiso únicamente cuando la persona toca **Activar avisos**. Texto de consentimiento y `/privacidad` editables. **La política de privacidad es un borrador: revisarla legalmente** (Ley 25.326, AAIP) antes de publicar.
- Baja en un toque desde la landing o `/baja`, y desde el navegador. Las bajas no reciben más avisos.
- El teléfono **no se guarda en claro** por defecto (solo huella HMAC + área). Con `PHONE_ENC_KEY` se guarda además cifrado.
- Panel: contraseña con scrypt, cookie de sesión `HttpOnly` + `SameSite=Strict` (+ `Secure` en producción), token CSRF y chequeo de `Origin`, roles `admin`/`editor`, registro de auditoría.
- Rate limit en suscripción, login y API. CSP sin JavaScript inline. `/health` no expone nada sensible. La clave VAPID privada nunca sale del servidor.

---

## 9. API

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

## 10. Estructura

```
src/            servidor (Express 5): config, db (adaptador), rutas, envío push, segmentos, teléfonos
public/         landing, service worker, panel (SPA sin build), marca
scripts/        vapid.js, seed.js
test/           tests (node:test) con push simulado
docs/           modelo de datos, API, capturas
```

## 11. Limitaciones conocidas

- Probado de punta a punta con Chrome de escritorio (FCM). No probado aún en iPhone real, Safari macOS, Firefox ni Android físico.
- Turso remoto y Render no se probaron desde acá (sí el mismo driver libSQL en modo archivo).
- Una sola instancia. Para decenas de miles de suscriptores por campaña conviene un VPS con archivo local o subir `SEND_CONCURRENCY`.
- Las métricas de "entregado" dependen de que el service worker reporte; algunos navegadores lo limitan, así que es un mínimo.
