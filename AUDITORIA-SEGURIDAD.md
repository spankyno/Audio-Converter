# Auditoría de seguridad — Convertidor de Audio

**Alcance:** código fuente del ZIP (`index.html`, `acerca-de.html`, `app.js`, `_headers`, CSS) y su despliegue en Cloudflare Pages (`audio-converter-car.pages.dev`).
**Método:** revisión manual de código + prueba E2E en Chromium aplicando las cabeceras reales (13 comprobaciones, todas superadas).
**Modelo de amenaza:** la promesa del producto es *"tus archivos nunca salen de tu dispositivo"*. Lo más grave es todo aquello que permita a un tercero ejecutar código en la página donde se manejan los archivos.

## Resumen

| # | Hallazgo | Severidad | Estado |
|---|----------|-----------|--------|
| 1 | Código remoto ejecutado sin verificación (Tailwind Play CDN, FFmpeg/worker desde jsDelivr vía `fetch` + `Blob`, sin SRI) | Alta | ✅ Corregido |
| 2 | Sin CSP ni cabeceras de seguridad (`_headers` apuntaba a `/ffmpeg/*`, ruta inexistente) | Alta | ✅ Corregido |
| 3 | Script de terceros (`tracker.js` en workers.dev) con acceso total al DOM junto a los archivos; no declarado en la política de privacidad | Alta | ⚠️ **Decisión tuya** |
| 4 | Google Fonts: cada visita envía la IP a Google (incompatible con el discurso de privacidad; riesgo RGPD) | Media | ✅ Corregido |
| 5 | Colisión de nombres en ZIP/descargas: `a.wav` + `a.mp3` → ambos `a.flac`, el segundo **pisaba silenciosamente** al primero. Nombres sin sanear (`..`, `\`, caracteres de control) | Media | ✅ Corregido |
| 6 | Sin límite de tamaño ni de nº de archivos → bloqueo/caída de la pestaña (DoS autoinfligido) | Media | ✅ Corregido |
| 7 | `ffmpeg.exec` devuelve código de salida y no lanza error: un fallo parcial se mostraba como "Listo" con archivo truncado | Media | ✅ Corregido |
| 8 | Extensión del archivo de usuario usada sin validar en la ruta del sistema de archivos virtual | Baja | ✅ Corregido |
| 9 | `escapeHtml` no escapaba `'`; todo el renderizado vía `innerHTML` (no explotable hoy, frágil ante cambios) | Baja | ✅ Mitigado |
| 10 | `localStorage` sin `try/catch` (falla con almacenamiento bloqueado) | Baja | ✅ Corregido |
| 11 | Fugas de `ObjectURL` (previsualizaciones y resultados) → memoria | Baja | ✅ Corregido |
| 12 | Duraciones indexadas por posición: condición de carrera al quitar archivos | Baja | ✅ Corregido |
| 13 | Metadatos originales (GPS, dispositivo…) se copiaban siempre al resultado | Baja (privacidad) | ✅ Opción añadida |
| 14 | Enlaces externos con `rel="noopener"` sin `noreferrer` | Info | ✅ Corregido |

## Detalle

### 1. Cadena de suministro (Alta) — corregido
`cdn.tailwindcss.com` es el build de *desarrollo* de Tailwind: sin versión fija, no admite SRI y exige `unsafe-eval`. Además `loadFFmpeg()` descargaba `worker.js`, `const.js` y `errors.js` como texto, les quitaba los `import` con una regex y los ejecutaba desde un `Blob`; el núcleo se importaba dinámicamente (imposible aplicar SRI). Si jsDelivr/unpkg o un mantenedor se vieran comprometidos, el atacante podría **leer los archivos del usuario**.

**Ahora:** Tailwind se compila en build (`css/styles.css`); `@ffmpeg/ffmpeg` 0.12.10, el núcleo JS 0.12.6 y JSZip 3.10.1 están en `/vendor` (mismo origen, versión fija). El `.wasm` (32 MB, no cabe en Pages: límite 25 MiB/archivo) sigue en jsDelivr pero se descarga, se **verifica con SHA-384** y solo entonces se ejecuta. Probado: un `.wasm` con 1 byte alterado es rechazado y no se convierte nada.

### 2. CSP y cabeceras (Alta) — corregido
`_headers` incluye ahora: CSP con `default-src 'none'`, sin `unsafe-inline`/`unsafe-eval` (solo `'wasm-unsafe-eval'`), `frame-ancestors 'none'` (anti-clickjacking), `base-uri`/`form-action`/`object-src` cerrados, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `COOP` y `HSTS`. Para cumplirla se eliminaron todos los `<script>` y `style=""` inline.
No se activa COOP/COEP *cross-origin isolation*: no hace falta (núcleo monohilo) y rompería el CDN y el tracker.

### 3. Tracker de terceros (Alta) — requiere tu decisión
`tracker.js` se carga en las dos páginas y, como cualquier script de la página, puede leer nombres de archivo, metadatos escritos e incluso el contenido de los archivos seleccionados. La CSP limita *a dónde* puede enviar datos, no *qué* puede leer. Además `acerca-de` promete privacidad sin mencionarlo, y en España una analítica con identificadores puede requerir consentimiento (RGPD/LSSI). No lo he tocado porque no sé qué recoge. Opciones, de más a menos segura:
1. Quitarlo de `index.html` y dejarlo solo en `acerca-de.html` (o en otras páginas sin archivos).
2. Sustituirlo por analítica sin script de terceros (p. ej. Cloudflare Web Analytics, que va en el borde).
3. Mantenerlo y declararlo en la política de privacidad; validar el `Origin` y limitar tasa en el worker (la `data-key` es pública por diseño).

### 4–13. Correcciones de código
Fuentes autoalojadas (Inter latin) · nombres únicos y saneados · límite de 500 MB/archivo y 50 archivos (`MAX_FILE_BYTES`, `MAX_FILES` en `app.js`) · comprobación del código de salida de FFmpeg · extensión restringida a `[a-z0-9]{1,5}` · metadatos limitados en longitud y sin caracteres de control · `localStorage` protegido · URLs de objeto revocadas · `WeakMap` para duraciones · opción **Eliminar metadatos originales** (`-map_metadata -1`).

## Mejoras funcionales incluidas
- **Precarga del motor** al añadir archivos (salvo "ahorro de datos"), con progreso real de la descarga.
- **Botón Cancelar** durante la conversión.
- Errores y archivos rechazados como aviso en pantalla (antes `alert()`), con el motivo por archivo.
- Progreso global real (antes solo avanzaba entre archivos).
- `loudnorm` ya no genera salidas a 192 kHz; 96 kHz se limita en MP3/MP2/AC3/WMA/AMR para evitar fallos del codificador.
- ZIP más rápido (`STORE` para audio ya comprimido) y sin releer blobs.
- Soltar un archivo fuera de la zona ya no abre el archivo y pierde el trabajo.
- Accesibilidad básica (etiquetas, `aria-pressed`, `role=progressbar`, `aria-live`, foco visible), `<noscript>`, favicon, `theme-color`.
- Eliminados `app.js` y `styles.css` duplicados de la raíz; añadidos `robots.txt`, `sitemap.xml` y `.well-known/security.txt`.

## Después de desplegar
1. Abre la consola (F12) y confirma que no aparecen violaciones de CSP. Si el tracker no envía datos, es la primera sospecha (ajusta `connect-src`/`script-src` en `_headers`). Si tienes activado Cloudflare Web Analytics, añade `https://static.cloudflareinsights.com` a `script-src` y `https://cloudflareinsights.com` a `connect-src`.
2. Comprueba cabeceras: `curl -sI https://audio-converter-car.pages.dev/ | grep -iE "content-security|x-frame|strict"`.
3. Verifica que el hash del `.wasm` coincide con el que sirve jsDelivr:
   `curl -sL https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm | openssl dgst -sha384 -binary | openssl base64 -A`
   → debe dar `SnAthyn82idS4YdVo46XOl86g1sUylqtN6BEYmPDFqzVO3Z3O/Xj1tVlyFqgyW4K`.

## Limitaciones de esta revisión
- Mi entorno no tiene acceso a jsDelivr ni a tu sitio: la prueba E2E sirvió el `.wasm` del paquete npm oficial en su lugar. El hash está calculado sobre ese paquete, de ahí el punto 3 de arriba.
- No he podido inspeccionar `tracker.js` ni el worker de `workers.dev`.
- Pendiente (no incluido): auditoría de accesibilidad completa, CI con tests, caché offline (Service Worker), y revisar las obligaciones de licencia del núcleo de FFmpeg (incluye componentes GPL).
