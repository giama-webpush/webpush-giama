# API

Base: `BASE_URL`. JSON en `Content-Type: application/json`.

## API externa (con `ADMIN_KEY`)

Autenticación: `Authorization: Bearer <ADMIN_KEY>` o `X-API-Key: <ADMIN_KEY>`. Si `ADMIN_KEY` no está configurada, la API responde 503. Rate limit: 120/min por IP.

### `GET|POST /api/cron/tick`
Procesa lo pendiente: campañas programadas vencidas, reintentos y automatizaciones. Pensado para un ping externo cada 5 min. También acepta `?key=<ADMIN_KEY>`.
→ `{ "ok": true, "at": "...", ... }`

### `POST /api/subscribers/tag`
```json
{ "phone": "011 15 5555-1234", "add": ["presupuesto-enviado"], "remove": ["frio"] }
```
A quién aplica (uno de estos campos):
- `phone`: se normaliza y se compara por huella.
- `subscriber_ids`: `[1, 2]`.
- `manage_token`.
- `filters`: ver [modelo-de-datos.md](modelo-de-datos.md#filtros-segmentos-campañas-api).

Límite: máx. 20 etiquetas en `add` y 20 en `remove`.
→ `{ "ok": true, "matched": 1 }`

### `POST /api/campaigns/send`
```json
{
  "name": "Promo 208 AMBA",
  "piece_id": 3,
  "filters": { "modelo": ["208"], "zona": ["AMBA"] },
  "scheduled_at": "2026-11-10T10:00:00-03:00",
  "ttl": 86400, "urgency": "normal", "freq_cap_hours": 24,
  "dry_run": false
}
```
- **Pieza:** `piece_id`, o una pieza en línea: `"piece": { "title", "body", "url", "image", "icon", "actions": [{ "title", "url" }] }`.
- **Destino:**
  - `segment_id`, `filters`, `phone` o `subscriber_ids`.
  - Con `phone` o `subscriber_ids` solo se incluyen suscriptores activos.
- **Envío:**
  - Sin `scheduled_at` sale ya. Con `scheduled_at`, usá ISO con zona horaria.
  - `dry_run: true` solo cuenta y no crea nada.
- **Respuestas:**
  - Normal: `202 { "ok": true, "campaign_id": 12, "estimated": 140, "scheduled_at": null }`.
  - Con `dry_run`: `{ "ok": true, "dry_run": true, "count": 140, "description": "..." }`.

### `GET /api/campaigns/:id`
Estado y métricas: destinatarios, enviados, entregados, clics, fallidos, vencidos.

## Endpoints públicos

| Método y ruta | Uso |
|---|---|
| `GET /s` | Landing de suscripción (acepta `marca`, `modelo`, `origen`, `campana`, `asesor`, `tel`, `utm_*`). |
| `GET /privacidad`, `GET /baja` | Política (borrador) y baja. |
| `GET /sw.js`, `GET /manifest.webmanifest` | Service worker y PWA (iOS). |
| `GET /api/public-config` | Textos, logo y clave VAPID **pública**. |
| `POST /api/subscribe` | `{ subscription, meta, oldEndpoint? }`. Idempotente por endpoint, valida el formato, rate limit 20/min por IP. Devuelve `manage_token`. |
| `POST /api/unsubscribe` | `{ endpoint }` o `{ manage_token }`. |
| `POST /api/status` | `{ endpoint }` → `{ subscribed }`. |
| `GET /r/:token[?a=1|2]` | Registra el clic (cuerpo o botón) y redirige con UTM. |
| `POST /t/d/:token`, `POST /t/c/:token` | Beacons de entrega y cierre (los manda el service worker). |
| `GET /media/:token.:ext` | Imágenes subidas. |
| `GET /health` | `{ ok, service, time }` sin datos sensibles. |

## API del panel (`/admin/api/*`)

Es la que usa la SPA del panel:

- **Autenticación:** cookie de sesión `wp_sid` más el header `X-CSRF-Token` (se obtiene en `GET /admin/api/me`) en todo lo que no sea GET. También se valida `Origin`.
- **Rutas principales:**
  - Sesión: `login`, `logout`, `me`.
  - Tablero y opciones de filtro: `dashboard`, `facets`.
  - Suscriptores: `subscribers` (lista, detalle, `tags`, baja, DELETE), `segments/count`, `export.csv`, `export.json` / `import.json` (solo admin).
  - Contenido y envíos: `segments`, `pieces` (+ `archive`, `duplicate`, `preview`, `test`), `uploads`, `campaigns` (+ `cancel`, `duplicate`, `test`, `sends.csv`).
  - Configuración: `automations`, `settings`, `admins`, `me/password`, `audit`.

No está pensada como API pública: para integraciones usá la API con `ADMIN_KEY`.
