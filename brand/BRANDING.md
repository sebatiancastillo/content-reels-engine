# Branding Vikingsos — Carpintería

## Identidad

- **Marca:** Vikingos · Carpintería artesanal.
- **Colores** (definidos en `branding.json`):
  - `#C8A453` dorado madera (primario)
  - `#2B2118` marrón oscuro (secundario)
  - `#14100C` fondo carbón
  - `#F5EFE4` crema (texto)
  - `#8C6A34` ámbar (acento)

## Estructura de carpetas

| Carpeta | Qué va aquí |
|---|---|
| `logo/`              | `logo.png` con fondo transparente, formato vertical 9:16-friendly. |
| `fonts/`             | Tipografías de marca. Se registran en tiempo de ejecución via `node-canvas`. Las demo `Vikingos-*.ttf` son Arial renombrada: reempláza free por la tipografía oficial antes de producción. |
| `music/`             | Pistas de fondo sin copyright. Cualquier `.mp3`/`.wav` dentro se usa mezclada con el audio original a volumen bajo. |
| `references/`        | Capturas de reels de referencia (uso interno, solo referencia visual). |

## Reglas de uso

1. **El texto NUNCA** inventa contenido: cada overlay usa el campo exacto del guion del usuario (Hook, Dolor, Problema, Proceso, Resultado, CTA).
2. **El CTA** se toma literalmente del campo CTA. El motor no genera llamadas a la acción por su cuenta.
3. **No copiamos** plantillas ni assets de terceros (CapCut, etc.). El sistema de edición es propio y las reglas son explícitas en `templates/reel-default.json`.

## Fonts (producción)

Coloca aquí:
- `Vikingos-Regular.ttf` — cuerpo de texto.
- `Vikingos-Bold.ttf` — títulos y hooks.

El motor hace fallback a la fuente del sistema si la carpeta está vacía, pero para una salida consistente entre máquinas **es obligatorio** versionar las fuentes de marca aquí.