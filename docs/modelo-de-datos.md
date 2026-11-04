# Modelo de datos

SQLite / libSQL. El esquema completo está en `src/db.js` (`SCHEMA`) y se aplica solo al arrancar. Fechas en texto ISO 8601 UTC (`...Z`); la zona de negocio es `APP_TIMEZONE` (Argentina).

## Tablas

| Tabla | Qué guarda |
|---|---|
| `settings` | Clave/valor: textos de la landing, logo, URL por defecto. Claves internas con `_` (`_vapid_public`, `_vapid_private`, `_phone_hash_secret`) solo si no vienen por env; nunca se exponen por la API. |
| `admins` | Usuarios del panel (`username`, `pass_hash` scrypt, `role` admin/editor). |
| `sessions` | Sesiones del panel: hash del token de cookie, token CSRF, vencimiento. |
| `subscribers` | Una fila por suscripción push (endpoint único). Estado `active` / `unsubscribed` / `dead` (404/410). Datos de origen y dispositivo, área telefónica y huella. |
| `subscriber_tags` | Etiquetas (`subscriber_id`, `tag`). Automáticas `campo:valor` y manuales. |
| `segments` | Segmentos guardados: nombre + filtros JSON (se cuentan en vivo). |
| `pieces` | Avisos reutilizables: título, texto, imagen, ícono, URL, botones (JSON, máx. 2), UTM automático. |
| `campaigns` | Envíos de una pieza a un filtro. Estados `borrador`, `programada`, `enviando`, `finalizada`, `cancelada`, `automatica`. `kind`: manual / auto / api. TTL, urgencia, tope de frecuencia. |
| `sends` | Un envío por suscriptor y campaña (único salvo pruebas). Token para clic/entrega, estado `queued`/`sent`/`failed`/`dead`/`cancelled`, intentos, HTTP, fechas de envío, entrega, clic (y botón), cierre. |
| `automations` | Bienvenida y recontacto (N días), con pieza y campaña asociadas. |
| `media` | Imágenes subidas (BLOB, mime, tamaño, dimensiones). Se sirven en `/media/<token>.<ext>`. |
| `audit_log` | Quién hizo qué en el panel y en la API. |

## Suscriptor (`subscribers`)

- Push: `endpoint`, `p256dh`, `auth`.
- Baja sin login: `manage_token`.
- Dispositivo: `device_type` (mobile/tablet/desktop), `os`, `browser`, `lang`, `timezone`.
- Origen (del link): `marca`, `modelo`, `origen`, `campana`, `asesor`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `landing_path`.
- Teléfono: `phone_area` (ej. `11`, `351`), `phone_zone` (`AMBA` / `Interior`), `phone_region` (provincia), `phone_hash` (HMAC-SHA256 con `PHONE_HASH_SECRET`), `phone_enc` (solo con `PHONE_ENC_KEY`).
  - Normalización: se quitan `+54`, `9`, `0` y `15`; se valida el código de área contra la tabla de `src/phone.js`.
- Momento de alta en hora local: `sub_local_date`, `sub_hour`, `sub_weekday`, `sub_daypart` (madrugada/mañana/tarde/noche).

## Etiquetas automáticas

`marca:peugeot`, `modelo:208`, `zona:amba`, `prefijo:011`, `dispositivo:mobile`, `so:android`, `origen:presupuesto`. Se recalculan si la misma persona vuelve a entrar con otro link (la suscripción es idempotente por endpoint).

## Filtros (segmentos, campañas, API)

Objeto JSON. Las listas son "cualquiera de":

```json
{
  "marca": ["PEUGEOT"], "modelo": ["208","2008"], "zona": ["AMBA"], "area": ["11"], "region": ["Córdoba"],
  "device": ["mobile"], "os": ["Android"], "browser": ["Chrome"],
  "origen": ["presupuesto"], "campana": ["noviembre-2026"], "asesor": ["Juan Perez"],
  "daypart": ["noche"], "lang": ["es"], "utm_source": ["ig"], "utm_campaign": ["x"],
  "tags": ["interesado-financiacion"], "tags_mode": "any",
  "exclude_tags": ["no-molestar"],
  "status": "active", "desde": "2026-10-01", "hasta": "2026-11-30",
  "has_phone": true, "q": "texto libre", "ids": [1,2,3]
}
```

- `tags_mode`: `any` o `all`.
- `status`: `active` (por defecto), `unsubscribed`, `dead` o `all`.
- Entre campos distintos se combinan con Y.

## Borrados

Se hacen en cascada desde el código, porque `foreign_keys` puede no estar activo en libSQL remoto:

- Borrar un suscriptor borra sus etiquetas y envíos.
- Borrar una campaña borra sus envíos.
