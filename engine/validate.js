'use strict';

const fs = require('fs');
const { ffprobeMeta, run } = require('./utils');

const TOLERANCE_RATIO = 0.06; // ±6% sobre la duración esperada
const EPS = 0.15;

/**
 * Valida el archivo final:
 *   1. Existe y pesa (> 0 bytes).
 *   2. ffprobe devuelve streams válidos (duración, resolución, códec).
 *   3. El archivo es reproducible: ffmpeg lo decodifica completo sin errores
 *      (salida a null), que es la comprobación más fiable antes de entregarlo.
 */
async function validateOutput(file, { ffmpeg, ffprobe, expectedDuration, expected = { width: 1080, height: 1920 } } = {}) {
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(file)) {
    return { ok: false, errors: ['El archivo final no existe.'], warnings };
  }
  const size = fs.statSync(file).size;
  if (size === 0) {
    return { ok: false, errors: ['El archivo final está vacío (0 bytes).'], warnings };
  }

  let meta;
  try {
    meta = await ffprobeMeta(file, ffprobe);
  } catch (err) {
    return { ok: false, errors: [`ffprobe no pudo leer el archivo: ${err.message}`], warnings };
  }

  if (!meta.video) errors.push('No se encontró stream de video.');
  if (meta.video) {
    const width = meta.video.width;
    const height = meta.video.height;
    if (width !== expected.width || height !== expected.height) {
      errors.push(`Resolución inesperada: ${width}x${height} (esperado ${expected.width}x${expected.height}).`);
    } else {
      warnings.push(`${width}x${height} correcto.`);
    }
    if (meta.video.codec_name && meta.video.codec_name !== 'h264') {
      warnings.push(`Codec de video: ${meta.video.codec_name} (se recomendó h264).`);
    } else if (meta.video.codec_name) {
      warnings.push(`Codec de video: h264 correcto.`);
    }
  }

  const effective = expectedDuration || meta.duration;
  if (expectedDuration) {
    const lower = expectedDuration * (1 - TOLERANCE_RATIO) - EPS;
    const upper = expectedDuration * (1 + TOLERANCE_RATIO) + EPS;
    if (meta.duration < lower || meta.duration > upper) {
      errors.push(
        `Duración inesperada: ${meta.duration.toFixed(2)}s (se esperaba ~${expectedDuration}s, tolerancia ±${Math.round(TOLERANCE_RATIO * 100)}%).`
      );
    } else {
      warnings.push(`Duración ${meta.duration.toFixed(2)}s dentro de tolerancia (~${expectedDuration}s).`);
    }
  }

  if (!meta.hasAudio) warnings.push('El video no tiene pista de audio.');

  // prueba de reproducibilidad: decodificar completo
  try {
    const output = pathToNull();
    const probeArgs = ['-v', 'error', '-i', file, '-f', 'null', output];
    const { stderr } = await run(ffmpeg, probeArgs);
    if (stderr && stderr.trim()) {
      errors.push(`La decodificación completa reportó errores:\n${stderr.trim().split('\n').slice(0, 8).join('\n')}`);
    } else {
      warnings.push(`Decodificación completa correcta (${size > 1048576 ? (size / 1048576).toFixed(1) + ' MB' : size + ' bytes'}).`);
    }
  } catch (err) {
    errors.push(`El archivo no es reproducible (falló la decodificación completa): ${(err.stderr || err.message).trim().split('\n').slice(0, 8).join('\n')}`);
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    warnings,
    metadata: {
      duration: meta.duration,
      width: meta.video ? meta.video.width : null,
      height: meta.video ? meta.video.height : null,
      fps: meta.video ? Math.round(evalRate(meta.video.avg_frame_rate) * 100) / 100 : null,
      videoCodec: meta.video ? meta.video.codec_name : null,
      audioCodec: meta.audioCodec,
      size,
      hasAudio: meta.hasAudio,
      container: (meta.format && meta.format.format_name) || null,
    },
  };
}

function evalRate(rate) {
  if (!rate) return null;
  const [n, d = '1'] = String(rate).split('/');
  const v = parseFloat(n) / parseFloat(d);
  return Number.isFinite(v) ? v : null;
}

function pathToNull() {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

module.exports = { validateOutput };