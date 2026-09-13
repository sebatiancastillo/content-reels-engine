# Content Reels Engine — Vikingos

Motor local de creación semiautomática de Reels verticales (1080×1920) para la marca Vikingos (carpintería).
El usuario produce el guion, el motor se encarga del montaje técnico: normalización, textos de marca, transiciones, logo, música y exportación.

## Requisitos

- **Node.js** ≥ 18 (probado con v22)
- **FFmpeg** con `ffmpeg` y `ffprobe` accesibles. Si no está en el PATH, el motor lo busca en varias rutas comunes (winget, scoop, chocolatey, `FFMPEG_DIR`, manual).
  - Windows: `winget install Gyan.FFmpeg`
  - Linux/macOS: `sudo apt install ffmpeg` / `brew install ffmpeg`

## Instalación

```
npm install
```

## Ejecución

```
npm start        # o: npm run dev
```

Servidor en **http://localhost:3000**.

## Uso (frontend)

1. **Material** — crea un proyecto y arrastra los clips: `Videos`, `Fotos`, `Audio`.
   Los archivos se nombran `NN_seccion.ext` (p. ej. `01_hook.mp4`, `04_proceso.jpg`) para mapearlos a secciones del guion.
   Reordena con ↑/↓ (sección principal → antes).
2. **Guion** — escribe hook, dolor, problema, proceso, resultado y CTA. El motor **nunca inventa** estrategia: este texto es la fuente de verdad.
3. **Formato** — plataforma, estilo y duración objetivo.
4. **Generar** — dispara el pipeline: análisis de clips, normalización a 1080×1920@30fps, renderizado con textos de marca (PNG), transiciones, logo, música con duck, exportación y validación.
5. **Resultado** — reproducción del vídeo final, con botones *Editar*, *Regenerar* y *Hecho · guardado*.

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/projects` | Lista de proyectos (con thumbnail y duración) |
| POST | `/api/projects` | Crear proyecto `{ name }` |
| DELETE | `/api/projects/:id` | Eliminar proyecto (completo) |
| GET | `/api/projects/:id` | Estado completo del proyecto |
| POST | `/api/projects/:id/material` | Subir `files[]` (multipart; genera thumbs automáticamente) |
| GET | `/api/projects/:id/thumb/:file` | Thumbnail JPG de un clip |
| DELETE | `/api/projects/:id/material/:file` | Borrar material |
| POST | `/api/projects/:id/material/order` | Reordenar clips `{ order: ["video:01.mp4", …] }` |
| POST | `/api/projects/:id/script` | Guardar guion |
| POST | `/api/projects/:id/config` | Guardar formato |
| POST | `/api/projects/:id/render` | Disparar render (202; 409 si ya hay uno activo) |
| POST | `/api/projects/:id/render/cancel` | Cancelar el render en curso |
| GET | `/api/projects/:id/render/status` | Estado/progreso del render |
| GET | `/api/projects/:id/output` | Descargar el mp4 final (soporta Range/206) |

## Material de prueba

Genera 6 vídeos, 2 fotos y 1 WAV sintéticos y ejecuta el pipeline completo sobre `e2e-vikingos`:

```
npm run test:render
```

## Estructura

```
api/        rutas Express (proyectos, material, guion, render)
app/        frontend vanilla (HTML/CSS/JS)
engine/     pipeline: analyze, prepare, render, validate + utils
brand/      identidad: logo, fuentes, música, branding.json, BRANDING.md
templates/  plantilla de reels (secciones, pesos, transiciones, estilos)
scripts/    test end-to-end del motor
projects/<slug>/input/{videos,photos,audio}  material
projects/<slug>/script/   guion (fuente de verdad)
projects/<slug>/config/   estado, orden, render
projects/<slug>/output/   resultado .mp4
```

## Principios del motor

- El **guion del usuario** define contenido y CTA; la IA no decide estrategia.
- Textos generados como **PNG con node-canvas** (nunca `drawtext`).
- Todas las piezas se normalizan a MP4 1080×1920@30fps (YUV420P, AAC si falta audio).
- Progreso del render parseando `time=` del stderr de FFmpeg (sin WebSockets).
- FFmpeg se verifica al arrancar: error claro y temprano si falta.
- Errores de FFmpeg legibles (stderr completo) y validación del output al terminar.

## Límites y FASE 2

- El análisis de clips es por nombre/orden (prefijo `NN_seccion`); FASE 2 prevé `scdet` + `silencedetect`
  para detectar automáticamente escenas y silencios y proponer cortes (descrito en el código, sin implementar).
- Textos y logo de producción deben reemplazarse por assets reales en `brand/` (las fuentes incluidas son Arial renombrada como placeholder).

## Dependencias

- `express` ^4, `multer` ^2 (subida de archivos), `canvas` ^3 (node-canvas, nativo)
- FFmpeg 9.x instalado por winget (detección automática)