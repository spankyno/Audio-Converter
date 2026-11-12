# Convertidor de Audio Online

Aplicación web 100% client-side para convertir archivos de audio (y extraer audio de vídeo) con **FFmpeg.wasm**. Sin subidas a servidor.

## Características

- Conversión en el navegador (MP3, WAV, FLAC, M4A, OGG, AAC, Opus, WMA, AIFF, CAF, AMR, MP2, AC3)
- Drag & drop, selección múltiple, previsualización, cancelación
- Calidad/bitrate, frecuencia de muestreo, canales, normalización de volumen
- Edición de metadatos y opción de **eliminar metadatos originales**
- Descarga individual o ZIP

## Desarrollo

```bash
npm install            # solo para recompilar el CSS
npm run build:css      # genera css/styles.css (Tailwind compilado)
npx serve .            # o: python -m http.server 8080
```

`css/styles.css` ya está compilado y versionado: para **desplegar no hace falta ejecutar nada**, basta subir la carpeta.
Si añades clases de Tailwind en `index.html`, `acerca-de.html` o `js/app.js`, vuelve a ejecutar `npm run build:css`.

## Estructura

```
├── index.html / acerca-de.html
├── js/app.js            # lógica de conversión
├── js/theme.js          # tema claro/oscuro (sin scripts inline)
├── src/input.css        # origen del CSS (Tailwind + @font-face + estilos propios)
├── css/styles.css       # CSS compilado (no editar a mano)
├── vendor/              # FFmpeg (wrapper + núcleo JS) y JSZip, versionados y autoalojados
├── fonts/               # Inter (latin) autoalojada
├── _headers             # CSP y cabeceras de seguridad (Cloudflare Pages)
└── AUDITORIA-SEGURIDAD.md
```

## Seguridad (resumen)

- **CSP estricta** (`_headers`): sin `unsafe-inline` ni `unsafe-eval`; solo `'wasm-unsafe-eval'` para WebAssembly.
- Todo el código se sirve desde el mismo origen, salvo el `.wasm` de FFmpeg (32 MB; Cloudflare Pages limita a 25 MiB por archivo), que se descarga de jsDelivr y se **verifica con SHA-384** antes de ejecutarse.
- Para actualizar FFmpeg: sustituye los archivos de `vendor/`, cambia la URL y recalcula el hash en `js/app.js` (`CORE_WASM`):
  `curl -sL <url-del-wasm> | openssl dgst -sha384 -binary | openssl base64 -A`

Detalles completos en [`AUDITORIA-SEGURIDAD.md`](AUDITORIA-SEGURIDAD.md).

## Licencias de terceros

FFmpeg.wasm (`@ffmpeg/ffmpeg`, `@ffmpeg/core`), JSZip (MIT o GPL-3.0+), Inter (SIL OFL 1.1), Tailwind CSS (MIT, solo en build).
El núcleo de FFmpeg se compila con componentes GPL (p. ej. x264/x265): si redistribuyes el binario, revisa sus obligaciones de licencia.

## Autor

Aitor Sánchez Gutiérrez · © 2026
