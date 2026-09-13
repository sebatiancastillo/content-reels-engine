'use strict';

const path = require('path');
const { ffprobeMeta, projectDir, projectInputDir, ensureDir, throwIfCancelled } = require('./utils');

const W = 1080;
const H = 1920;
const FPS = 30;

/**
 * Normaliza cada clip para que la concatenación siempre funcione:
 *   - Mismo tamaño 1080x1920 (scale + pad con color de marca).
 *   - Mismo fps (30) y formato de píxel (yuv420p).
 *   - Pista de audio AAC 44.1kHz estéreo SIEMPRE (silenciosa si no la tiene),
 *     así `concat` puede incluir audio sin ramas.
 *   - Códec H.264 (libx264).
 */

/**
 * @param {object} opts
 * @param {string} opts.ffmpeg       binario ffmpeg
 * @param {string} opts.inputPath    ruta absoluta al archivo original
 * @param {string} opts.outputPath   ruta absoluta del mp4 normalizado
 * @param {'video'|'photo'} opts.kind
 * @param {number} opts.duration     duración objetivo en segundos
 * @param {boolean} opts.hasAudio    solo relevante para video
 * @param {string} [opts.background] color de pad de marca (hex sin #)
 */
async function prepareClip({ ffmpeg, ffprobe, inputPath, outputPath, kind, duration, hasAudio = false, background = '14100C' }) {
  ensureDir(path.dirname(outputPath));

  const vf = [
    'fps=' + FPS,
    `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x${background.replace('#', '')}`,
    'setsar=1',
    'format=yuv420p',
  ].join(',');

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];

  const hasRealAudio = hasAudio;
  const needNull = !hasRealAudio;

  if (kind === 'photo') {
    args.push('-loop', '1', '-t', String(duration), '-i', inputPath);
  } else {
    args.push('-i', inputPath);
  }

  if (needNull) {
    args.push('-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  }

  args.push(
    '-map', '0:v:0',
    '-map', needNull ? '1:a:0' : '0:a:0',
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-t', String(duration),
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    outputPath
  );

  await runFFmpeg(ffmpeg, args, `normalizando ${path.basename(outputPath)}`);
  const meta = await ffprobeMeta(outputPath, ffprobe);
  return { outputPath, duration: meta.duration || duration, hasAudio: meta.hasAudio, width: meta.width, height: meta.height };
}

/**
 * Prepara todos los clips de un proyecto en un directorio temporal uniforme.
 * @returns Prepared[] = [{ id, kind, fileName, section, word, label, inputPath, file, duration }]
 */
async function prepareProject(ctx) {
  const { slug, clips, ffmpeg, ffprobe } = ctx;
  const workDir = ensureDir(path.join(projectDir(slug), 'temp'));
  const template = ctx.template;
  const background = template.paddingColor || template.resolution?.padColor || '14100C';

  const prepared = [];
  for (const clip of clips) {
    throwIfCancelled(ctx.isCancelled);
    const inputPath = path.join(projectInputDir(slug, clip.kind === 'photo' ? 'photos' : 'videos'), clip.fileName);
    // Siempre .mp4: el clip normalizado es video independientemente del origen.
    const outFile = `${String(prepared.length + 1).padStart(2, '0')}_${clip.section.id}_${sanitize(clip.fileName)}.mp4`;
    const outputPath = path.join(workDir, outFile);

    let hasRealAudio = false;
    if (clip.kind === 'video') {
      try {
        const meta = await ffprobeMeta(inputPath, ffprobe);
        hasRealAudio = meta.hasAudio;
      } catch {
        hasRealAudio = false;
      }
    }

    const res = await prepareClip({
      ffmpeg,
      ffprobe,
      inputPath,
      outputPath,
      kind: clip.kind,
      duration: clip.duration,
      hasAudio: hasRealAudio,
      background,
    });

    prepared.push({
      id: clip.id,
      kind: clip.kind,
      fileName: clip.fileName,
      section: clip.section,
      word: clip.section.id,
      label: clip.section.label,
      inputPath,
      file: outputPath,
      duration: res.duration,
    });
  }

  return prepared;
}

function sanitize(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
}

// runner local (evita import circular con utils.run)
const { run } = require('./utils');
async function runFFmpeg(ffmpeg, args, label) {
  try {
    await run(ffmpeg, args);
  } catch (err) {
    err.label = label;
    throw err;
  }
}

module.exports = { prepareClip, prepareProject, W, H, FPS };