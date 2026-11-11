# Convertidor de Audio Online

Aplicación web 100% client-side para convertir archivos de audio (y extraer audio de vídeo).

## Características

- Conversión en el navegador con **FFmpeg.wasm** (sin subidas a servidor)
- Formatos: MP3, WAV, FLAC, M4A, OGG, AAC, Opus, AIFF, AMR, MP2
- Drag & drop + selección múltiple
- Barra de calidad con color
- Opciones avanzadas (sample rate, canales, invertir)
- Página **Acerca de** con explicación, stack y privacidad
- Footer con enlaces a Blog, Aitor Hub y Contacto

## Cómo usar

1. Abre `index.html` en un servidor local (necesario por las restricciones de CORS/WASM):
 
```bash
# Con Python
python -m http.server 8080

# O con npx
npx serve .
```

2. Visita `http://localhost:8080`

> Nota: Abrir el archivo directamente con `file://` puede fallar al cargar FFmpeg.wasm. Siempre usa un servidor HTTP local o despliega en Pages/Vercel/Netlify.

## Estructura

```
audio-converter/
├── index.html          # Página principal (conversor)
├── acerca-de.html      # Página Acerca de
├── css/styles.css      # Estilos personalizados
├── js/app.js           # Lógica de conversión
└── README.md
```

## Despliegue

Puedes subir la carpeta completa a:
- Cloudflare Pages
- Vercel
- Netlify
- GitHub Pages

No requiere backend ni variables de entorno.

## Autor

Aitor Sánchez Gutiérrez  
© 2026 - Todos los derechos reservados.
