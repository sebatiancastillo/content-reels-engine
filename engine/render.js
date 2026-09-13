'use strict';

const fs = require('fs');
const path = require('path');
const { registerFont, createCanvas } = require('canvas');
const { BRAND_DIR, TEMP_DIR, projectDir, projectConfigFile, projectScriptFile, projectOutputDir, projectInputDir, readJson, run, ProgressParser, detectFFmpeg, ensureDir, patchProject, cancelledError, throwIfCancelled } = require('./utils');
const { prepareProject } = require('./prepare');
const { analyzeProject, loadTemplate } = require('./analyze');
const { validateOutput } = require('./validate');

const W = 1080;
const H = 1920;

/* ------------------------------------------------------------------ */
/* Fuentes de marca                                                    */
/* ------------------------------------------------------------------ */

let fontsState = null;

/** Invalida el cache de fuentes (llamado al reemplazar tipografía de marca). */
function resetFonts() {
  fontsState = null;
}

function ensureFonts() {
  if (fontsState) return fontsState;
  const branding = readJson(path.join(BRAND_DIR, 'branding.json'), { font: {} });
  const fontsDir = path.join(BRAND_DIR, 'fonts');
  const regular = path.join(fontsDir, branding.font.regular || 'Vikingos-Regular.ttf');
  const bold = path.join(fontsDir, branding.font.bold || 'Vikingos-Bold.ttf');

  const reg = fs.existsSync(regular) ? regular : null;
  const bol = fs.existsSync(bold) ? bold : null;

  if (reg) {
    try {
      registerFont(reg, { family: 'Vikingos' });
    } catch { /* se ignora, cae a sans-serif */ }
  }
  if (bol) {
    try {
      registerFont(bol, { family: 'VikingosBold' });
    } catch { /* se ignora, cae a sans-serif */ }
  }

  fontsState = {
    regular: reg ? '"Vikingos"' : 'sans-serif',
    bold: bol ? '"VikingosBold"' : 'sans-serif',
    files: { reg, bol },
  };
  return fontsState;
}

/* ------------------------------------------------------------------ */
/* PNG de texto del guion (node-canvas)                                */
/* ------------------------------------------------------------------ */

const STYLES = {
  limpio: {
    fontSize: 58,
    boxAlpha: 0.32,
    barHeight: 6,
    uppercase: false,
    tracking: 0,
    fontWeight: 'normal',
    borderRadius: 24,
  },
  dinamico: {
    fontSize: 76,
    boxAlpha: 0.58,
    barHeight: 12,
    uppercase: true,
    tracking: 0,
    fontWeight: 'bold',
    borderRadius: 16,
  },
  profesional: {
    fontSize: 62,
    boxAlpha: 0.42,
    barHeight: 6,
    uppercase: false,
    tracking: 8,
    fontWeight: 'bold',
    borderRadius: 4,
    bordered: true,
  },
};

/**
 * Genera una imagen PNG transparente 1080x1920 con el texto de una sección
 * del guion. Cada clip lleva su propia imagen: el "drawtext" se evita para no
 * depender de fuentes instaladas en el sistema.
 */
function buildTextPng({ text, style = 'limpio', colors, outPath }) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const fonts = ensureFonts();
  const s = STYLES[style] || STYLES.limpio;
  const c = colors || { primary: '#C8A453', text: '#F5EFE4', bg: '#14100C' };

  const clean = String(text || '').trim();
  const paddingX = 90;

  if (clean) {
    let fontFamily = s.fontWeight === 'bold' ? fonts.bold : fonts.regular;
    let fontSize = s.fontSize;
    const maxWidth = W - paddingX * 2;
    const maxBlockH = H * 0.42;

    // Tooltip de ajuste: reducir fuente hasta que quepa
    let lines = wrapText(ctx, clean, fontSize, fontFamily, maxWidth, s.tracking);
    while (lines.length > 6 && fontSize > 34) {
      fontSize -= 4;
      lines = wrapText(ctx, clean, fontSize, fontFamily, maxWidth, s.tracking);
    }

    const lineHeight = Math.round(fontSize * 1.22);
    const blockH = lines.length * lineHeight + 46 + s.barHeight;
    const boxW = maxWidth;
    const boxH = lines.length * lineHeight + 46 + s.barHeight;
    const boxX = (W - boxW) / 2;

    // bloquear centro vertical ligeramente por debajo (zona segura de UI)
    let boxY = (H - boxH) / 2;

    // fondo translúcido
    const [r, g, b] = hexToRgb(c.bg || '#14100C');
    ctx.fillStyle = `rgba(${r},${g},${b},${s.boxAlpha})`;
    roundRect(ctx, boxX, boxY, boxW, boxH, s.borderRadius || 20);
    ctx.fill();

    if (s.bordered) {
      ctx.strokeStyle = c.primary;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.9;
      roundRect(ctx, boxX, boxY, boxW, boxH, (s.borderRadius || 20));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // barra de acento
    ctx.fillStyle = c.primary;
    ctx.fillRect(boxX, boxY + 6, boxW, s.barHeight);

    // texto
    ctx.fillStyle = c.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `${s.fontWeight} ${fontSize}px ${fontFamily}`;
    const textStartY = boxY + 26 + s.barHeight;
    let y = textStartY;
    for (const line of lines) {
      if (s.tracking) {
        ctx.letterSpacing = `${s.tracking}px`;
      }
      ctx.fillText(line, W / 2, y);
      y += lineHeight;
    }
    ctx.letterSpacing = '0px';
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  return outPath;
}

function wrapText(ctx, text, fontSize, fontFamily, maxWidth, tracking) {
  ctx.font = `${fontSize}px ${fontFamily}`;
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    const w = ctx.measureText(candidate).width + (tracking ? tracking * candidate.length : 0);
    if (w > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.replace('#', ''));
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [20, 16, 12];
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* ------------------------------------------------------------------ */
/* Logo de marca                                                       */
/* ------------------------------------------------------------------ */

function ensureLogo() {
  const logosDir = path.join(BRAND_DIR, 'logo');
  fs.mkdirSync(logosDir, { recursive: true });
  const logoFile = path.join(logosDir, 'logo.png');
  if (fs.existsSync(logoFile) && fs.statSync(logoFile).size > 500) return logoFile;

  // Placeholder: monograma "V" en marco redondeado dorado
  const canvas = createCanvas(512, 512);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2B2118';
  roundRect(ctx, 24, 24, 512 - 48, 512 - 48, 56);
  ctx.fill();
  ctx.strokeStyle = '#C8A453';
  ctx.lineWidth = 10;
  roundRect(ctx, 44, 44, 512 - 88, 512 - 88, 40);
  ctx.stroke();
  const fonts = ensureFonts();
  ctx.fillStyle = '#C8A453';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold 260px ${fonts.bold}`;
  ctx.fillText('V', 256, 264);
  fs.writeFileSync(logoFile, canvas.toBuffer('image/png'));
  return logoFile;
}

/* ------------------------------------------------------------------ */
/* Música de fondo                                                     */
/* ------------------------------------------------------------------ */

const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];

function pickMusic(slug) {
  const dirs = [];
  const projectAudio = projectInputDir(slug, 'audio');
  if (fs.existsSync(projectAudio)) dirs.push(projectAudio);
  const brandMusic = path.join(BRAND_DIR, 'music');
  if (fs.existsSync(brandMusic)) dirs.push(brandMusic);
  for (const dir of dirs) {
    const files = fs.readdirSync(dir).filter((f) => AUDIO_EXT.includes(path.extname(f).toLowerCase()));
    if (files.length) return path.join(dir, files.sort()[0]);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Ensamblado del comando (empuje de progreso desde stderr)            */
/* ------------------------------------------------------------------ */

function buildCommand({ prepared, textPngs, logoFile, musicFile, total, transitions, musicVolume, background }) {
  const C = prepared.length;
  const F = transitions.seconds;

  const inputs = [];
  for (const p of prepared) inputs.push('-i', p.file);
  for (const t of textPngs) inputs.push('-i', t);
  inputs.push('-loop', '1', '-t', String(total + 1), '-i', logoFile);
  if (musicFile) inputs.push('-i', musicFile);

  const fc = [];
  const videoSegs = [];
  const audioSegs = [];

  prepared.forEach((p, i) => {
    const dur = p.duration;

    // clip: fundido de entrada/salida (transición simple entre cortes)
    fc.push(`[${i}:v]fade=t=in:st=0:d=${F},fade=t=out:st=${fmt(dur - F)}:d=${F},setpts=PTS-STARTPTS[v${i}]`);
    fc.push(`[${i}:a]afade=t=in:st=0:d=${F},afade=t=out:st=${fmt(dur - F)}:d=${F},atrim=duration=${fmt(dur)}[a${i}]`);

    // texto del guion con fundido (tapado del drawtext de FFmpeg)
    fc.push(`[${C + i}:v]format=rgba,fade=t=in:st=0:d=0.25,fade=t=out:st=${fmt(dur - 0.35)}:d=0.35[t${i}]`);
    fc.push(`[v${i}][t${i}]overlay=0:0,format=yuv420p[ov${i}]`);

    videoSegs.push(`[ov${i}]`);
    audioSegs.push(`[a${i}]`);
  });

  // concatenación (los fades ya están aplicados por clip)
  fc.push(`${videoSegs.join('')}concat=n=${C}:v=1:a=0[vcat]`);
  fc.push(`${audioSegs.join('')}concat=n=${C}:v=0:a=1[acat]`);

  // logo en esquina superior derecha durante todo el reel
  const logoScale = logoPx();
  fc.push(`[${C * 2}:v]scale=${logoScale}:-1,format=rgba[lg]`);
  fc.push(`[vcat][lg]overlay=${W - logoScale - 36}:36,format=yuv420p[vlg]`);

  // cierre de video
  fc.push(`[vlg]fade=t=in:st=0:d=0.3,fade=t=out:st=${fmt(total - 0.6)}:d=0.6,format=yuv420p[vout]`);

  // audio final: música de marca mezclada a bajo volumen
  if (musicFile) {
    fc.push(`[${C * 2 + 1}:a]volume=${musicVolume}[m]`);
    fc.push(
      `[acat][m]amix=inputs=2:duration=first:normalize=0,atrim=0:${fmt(total)},afade=t=out:st=${fmt(total - 1.2)}:d=1.2[aout]`
    );
  } else {
    fc.push(`[acat]afade=t=out:st=${fmt(total - 0.8)}:d=0.8[aout]`);
  }

  const args = [
    '-y', '-hide_banner',
    ...inputs,
    '-filter_complex', fc.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-movflags', '+faststart',
    '-t', fmt(total),
  ];

  return { args, inputs, filterGraph: fc.join(';') };
}

function logoPx() {
  const template = loadTemplate('reel-default');
  const scale = (template.logo && template.logo.scale) || 0.14;
  return Math.round(W * scale);
}

function fmt(n) {
  const x = Math.max(0, Number(n) || 0);
  return x.toFixed(2);
}

/* ------------------------------------------------------------------ */
/* Orquestación del render completo                                    */
/* ------------------------------------------------------------------ */

/**
 * Ejecuta el pipeline completo (analyze → prepare → render → validate).
 * `onProgress` recibe llamadas periódicas {percent, played, total}.
 */
async function renderProject(slug, opts = {}) {
  const { onProgress = () => {}, onLog = () => {} } = opts;
  const isCancelled = opts.isCancelled || null;
  const { ffmpeg, ffprobe } = detectFFmpeg();

  const cfg = readJson(projectConfigFile(slug), {});
  const script = readJson(projectScriptFile(slug), {});
  const template = loadTemplate('reel-default');
  const branding = readJson(path.join(BRAND_DIR, 'branding.json'), { colors: {}, transitions: {} });
  const colors = branding.colors;

  // 1) análisis (orden + duraciones)
  onLog('Analizando clips y asignando duraciones…');
  const { clips, totalDuration } = analyzeProject(slug, {
    template: cfg.template || 'reel-default',
    targetDuration: Number(cfg.targetDuration || script.targetDuration),
  });
  throwIfCancelled(isCancelled);

  // 2) preparación (normalización)
  onLog('Normalizando clips (1080x1920 @ 30fps)…');
  const prepared = await prepareProject({
    slug,
    clips,
    ffmpeg,
    ffprobe,
    template,
    isCancelled,
  });
  throwIfCancelled(isCancelled);
  onLog(`${prepared.length} clips preparados.`);

  // 3) PNGs de texto por sección
  onLog('Generando overlays de texto con tipografía de marca…');
  const textDir = ensureDir(path.join(projectDir(slug), 'temp', 'text'));
  const style = cfg.style || 'dinamico';
  const seen = new Set();
  const textPngs = prepared.map((p, i) => {
    const firstOfSection = !seen.has(p.section.id);
    seen.add(p.section.id);
    const text = firstOfSection ? script[p.section.id] || '' : '';
    const outPath = path.join(textDir, `text_${String(i).padStart(2, '0')}.png`);
    buildTextPng({ text, style, colors, outPath });
    return outPath;
  });

  const logoFile = ensureLogo();
  const musicFile = pickMusic(slug);
  if (musicFile) onLog(`Usando música de fondo: ${path.basename(musicFile)}`);
  throwIfCancelled(isCancelled);

  // 4) comando único
  const { args, filterGraph } = buildCommand({
    prepared,
    textPngs,
    logoFile,
    musicFile,
    total: totalDuration,
    transitions: { ...template.transitions, ...branding.transitions },
    musicVolume: template.audio.musicVolume,
    background: template.resolution?.padColor || '14100C',
  });

  const outDir = ensureDir(projectOutputDir(slug));
  const outFile = path.join(outDir, `vikingos-${slug}-final.mp4`);
  args.push(outFile);

  patchProject(slug, {
    lastRender: { startedAt: new Date().toISOString(), command: ['ffmpeg', ...args].join(' '), hasMusic: Boolean(musicFile) },
  }).catch(() => {});

  onLog(`Renderizando con FFmpeg (${totalDuration}s de video)…`);

  const progress = new ProgressParser(totalDuration);
  const errLines = [];

  await new Promise((resolve, reject) => {
    const child = spawnFFmpeg(ffmpeg, args);
    let killed = false;
    const tryCancel = () => {
      if (killed) return;
      if (isCancelled && isCancelled()) {
        killed = true;
        try { child.kill(); } catch { /* proceso ya terminado */ }
      }
    };
    child.stderr.on('data', (d) => {
      tryCancel();
      const chunk = d.toString();
      const p = progress.push(chunk);
      if (p) onProgress(p);
      errLines.push(...chunk.split(/\r?\n/).filter(Boolean));
      if (errLines.length > 400) errLines.splice(0, errLines.length - 400);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (killed) return reject(cancelledError());
      if (code === 0) return resolve();
      const err = new Error('FFmpeg falló al renderizar el reel.');
      err.code = 'FFMPEG_RENDER_FAILED';
      err.stderrTail = errLines.join('\n');
      reject(err);
    });
  });
  throwIfCancelled(isCancelled);

  onProgress(progress.done());

  // 5) validación (ffprobe + decodificación completa)
  onLog('Validando archivo final…');
  const validation = await validateOutput(outFile, { ffmpeg, ffprobe, expectedDuration: totalDuration, expected: { width: W, height: H } });

  if (!validation.ok) {
    const err = new Error('La validación del video final falló.');
    err.code = 'VALIDATE_FAILED';
    err.validation = validation;
    throw err;
  }

  return { outFile, metadata: validation.metadata, totalDuration, filterGraph };
}

const { spawn } = require('child_process');
function spawnFFmpeg(bin, args) {
  return spawn(bin, args, {
    windowsHide: true,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

module.exports = {
  W,
  H,
  renderProject,
  buildCommand,
  buildTextPng,
  ensureFonts,
  ensureLogo,
  pickMusic,
  wrapText,
  resetFonts,
};