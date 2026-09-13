'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const TEMP_DIR = path.join(ROOT, 'temp');
const BRAND_DIR = path.join(ROOT, 'brand');

/* ------------------------------------------------------------------ */
/* Rutas                                                              */
/* ------------------------------------------------------------------ */

function projectDir(slug) {
  return path.join(PROJECTS_DIR, slug);
}

function projectInputDir(slug, kind) {
  return path.join(projectDir(slug), 'input', kind);
}

function projectConfigFile(slug) {
  return path.join(projectDir(slug), 'config', 'project.json');
}

function projectScriptFile(slug) {
  return path.join(projectDir(slug), 'script', 'guion.json');
}

function projectOutputDir(slug) {
  return path.join(projectDir(slug), 'output');
}

function projectThumbDir(slug) {
  return path.join(projectDir(slug), 'thumbs');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeResolve(base, name) {
  const target = path.resolve(base, name);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Ruta no permitida: ${name}`);
  }
  return target;
}

/* ------------------------------------------------------------------ */
/* JSON persistente                                                   */
/* ------------------------------------------------------------------ */

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // Sufijo único: dos escrituras concurrentes en el mismo proceso nunca
  // comparten el archivo temporal (evita corrupción por intercalado).
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function writeJson(file, data) {
  await writeJsonAtomic(file, data);
  return data;
}

/* ------------------------------------------------------------------ */
/* Slugs y nombres                                                    */
/* ------------------------------------------------------------------ */

function slugify(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'proyecto';
}

function toKebab(name) {
  return slugify(name);
}

/* ------------------------------------------------------------------ */
/* Estado del proyecto (config/project.json)                           */
/* ------------------------------------------------------------------ */

const DEFAULT_PROJECT = {
  slug: '',
  name: '',
  platform: 'instagram',
  format: { width: 1080, height: 1920, fps: 30 },
  style: 'dinamico',
  theme: 'limpio',
  status: 'created',
  render: { status: 'idle', progress: 0, message: '', startedAt: null, finishedAt: null, output: null, error: null, validation: null },
  clipOrder: [],
  updatedAt: null,
  createdAt: null,
};

function readProject(slug) {
  const saved = readJson(projectConfigFile(slug), {});
  return { ...DEFAULT_PROJECT, ...saved, render: { ...DEFAULT_PROJECT.render, ...(saved.render || {}) } };
}

async function writeProject(slug, data) {
  await fsp.mkdir(path.dirname(projectConfigFile(slug)), { recursive: true });
  const merged = { ...readProject(slug), ...data, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(projectConfigFile(slug), merged);
  return merged;
}

async function patchProject(slug, patch) {
  const current = readProject(slug);
  const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
  if (patch.render) merged.render = { ...current.render, ...patch.render };
  await writeJsonAtomic(projectConfigFile(slug), merged);
  return merged;
}

/** Inventario completo de material del proyecto sin tocar el engine. */
function projectMedia(slug) {
  const media = { videos: [], photos: [], audio: [] };
  const thumb = (f) => {
    const p = path.join(projectThumbDir(slug), `${f}.jpg`);
    return fs.existsSync(p) ? `/api/projects/${slug}/thumb/${encodeURIComponent(f)}` : null;
  };
  for (const [kind, exts] of Object.entries({
    videos: ['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv'],
    photos: ['.jpg', '.jpeg', '.png', '.webp'],
    audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'],
  })) {
    const dir = projectInputDir(slug, kind);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (exts.includes(path.extname(f).toLowerCase())) {
        const item = { fileName: f, url: `/api/projects/${slug}/material/${encodeURIComponent(f)}` };
        if (kind !== 'audio') item.thumb = thumb(f);
        media[kind].push(item);
      }
    }
  }
  return media;
}

/* ------------------------------------------------------------------ */
/* Detección de FFmpeg                                                */
/* ------------------------------------------------------------------ */

const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';

/**
 * Devuelve rutas absolutas a ffmpeg y ffprobe, o lanza un error claro.
 * Estrategias, en orden:
 *   1. FFMPEG_DIR / variable explícita
 *   2. PATH del sistema
 *   3. Ubicaciones conocidas (winget, scoop, chocolatey, manual)
 */
function detectFFmpeg() {
  const binDirs = [];

  if (process.env.FFMPEG_DIR) {
    binDirs.push(process.env.FFMPEG_DIR);
  }

  if (WIN) {
    // winget instala bajo <Packages>/<Instalador>_<Source>/<build>/bin
    // (a veces un nivel más profundo). Escaneo de profundidad 1-2.
    try {
      const wingetRoot = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
      if (fs.existsSync(wingetRoot)) {
        for (const entry of fs.readdirSync(wingetRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const sub = path.join(wingetRoot, entry.name);
          if (fs.existsSync(path.join(sub, 'bin', `ffmpeg${EXE}`))) binDirs.push(path.join(sub, 'bin'));
          for (const inner of fs.readdirSync(sub, { withFileTypes: true })) {
            if (!inner.isDirectory()) continue;
            const nested = path.join(sub, inner.name, 'bin');
            if (fs.existsSync(path.join(nested, `ffmpeg${EXE}`))) binDirs.push(nested);
          }
        }
      }
    } catch {
      /* seguir con la siguiente estrategia */
    }

    for (const dir of [
      path.join(process.env.USERPROFILE || '', 'scoop', 'apps', 'ffmpeg', 'current', 'bin'),
      'C:\\ProgramData\\chocolatey\\bin',
      path.join(process.env.PROGRAMFILES || 'C:', 'ffmpeg', 'bin'),
    ]) {
      if (fs.existsSync(dir)) binDirs.push(dir);
    }
  }

  const ffmpeg = findExecutable(binDirs, 'ffmpeg');
  const ffprobe = findExecutable(binDirs, 'ffprobe');

  if (!ffmpeg || !ffprobe) {
    throw new Error(
      [
        'FFmpeg no está disponible.',
        '',
        'Se buscó en: PATH, FFMPEG_DIR y ubicaciones conocidas de Windows (winget, scoop, chocolatey).',
        '',
        'Instala FFmpeg con cualquiera de estos métodos:',
        WIN ? '  winget install --id Gyan.FFmpeg   (recomendado)' : '  sudo apt install ffmpeg   (Debian/Ubuntu)',
        WIN ? '  o descárgalo de https://www.gyan.dev/ffmpeg/builds/ y añádelo al PATH' : '  brew install ffmpeg   (macOS)',
        '',
        `Si ya lo tienes en otra ruta, define la variable de entorno FFMPEG_DIR apuntando al directorio bin.`,
      ].join('\n')
    );
  }

  return { ffmpeg, ffprobe };
}

function findExecutable(dirs, name) {
  // 1) PATH del sistema
  const onPath = spawnSync(name + EXE, ['-version'], { encoding: 'utf8' });
  if (!onPath.error) return name + EXE;

  // 2) directorios conocidos (sin duplicados)
  for (const dir of Array.from(new Set(dirs.filter(Boolean)))) {
    const candidate = path.join(dir, `${name}${EXE}`);
    try {
      const res = spawnSync(candidate, ['-version'], { encoding: 'utf8' });
      if (!res.error && !/not (found|recognized)/i.test(String(res.stderr || ''))) return candidate;
    } catch {
      /* continuar */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Ejecución de procesos                                              */
/* ------------------------------------------------------------------ */

function dieIfFFmpegMissing() {
  try {
    return detectFFmpeg();
  } catch (err) {
    console.error('\n[ERROR] ' + err.message);
    console.error('El servidor no puede arrancar sin FFmpeg.\n');
    process.exit(1);
  }
}

/** Ejecuta un binario capturando stdout/stderr; resolve con {code, stdout, stderr}. */
function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      cwd: opts.cwd || ROOT,
      env: { ...process.env, ...(opts.env || {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; if (opts.onStdout) opts.onStdout(d.toString()); });
    child.stderr.on('data', (d) => { stderr += d; if (opts.onStderr) opts.onStderr(d.toString()); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ code, stdout, stderr });
      const err = new Error(`El proceso terminó con código ${code}`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

/* ------------------------------------------------------------------ */
/* ffprobe                                                            */
/* ------------------------------------------------------------------ */

async function ffprobeMeta(file, ffprobeBin) {
  const { stdout } = await run(ffprobeBin, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  const data = JSON.parse(stdout);
  const video = (data.streams || []).find((s) => s.codec_type === 'video');
  const audio = (data.streams || []).find((s) => s.codec_type === 'audio');
  const format = data.format || {};
  return {
    format,
    duration: parseFloat(format.duration || (video && video.duration) || 0),
    width: video ? video.width : null,
    height: video ? video.height : null,
    fps: video ? parseFps(video.r_frame_rate || video.avg_frame_rate) : null,
    videoCodec: video ? video.codec_name : null,
    audioCodec: audio ? audio.codec_name : null,
    hasAudio: Boolean(audio),
    video,
    audio,
  };
}

function parseFps(rate) {
  if (!rate) return null;
  const [n, d = '1'] = String(rate).split('/');
  const val = parseFloat(n) / parseFloat(d);
  return Number.isFinite(val) ? Math.round(val * 100) / 100 : null;
}

function parseTimeToSeconds(timeStr) {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(timeStr || ''));
  if (!m) return parseFloat(timeStr) || 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

/** Error estándar para renders cancelados por el usuario. */
function cancelledError() {
  const err = new Error('Render cancelado por el usuario.');
  err.code = 'CANCELLED';
  return err;
}

/** Lanza CANCELLED si `isCancelled()` devuelve true (tolerante a null). */
function throwIfCancelled(isCancelled) {
  if (isCancelled && isCancelled()) throw cancelledError();
}

/** Genera un JPG pequeño (un frame) para previsualizar video o foto. Devuelve true si lo crea. */
async function makeThumb({ src, dest, width = 360 }) {
  try {
    const { ffmpeg } = detectFFmpeg();
    ensureDir(path.dirname(dest));
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', src,
      '-frames:v', '1',
      '-vf', `scale=min(${width}\\,iw):-2`,
    ];
    // fotos: escala simple; videos: toma un frame cerca del inicio
    if (!/\.(jpe?g|png|webp|gif)$/i.test(src)) args.splice(2, 0, '-ss', '0.2');
    args.push(dest);
    await run(ffmpeg, args);
    return fs.existsSync(dest) && fs.statSync(dest).size > 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Progreso de render                                                 */
/* ------------------------------------------------------------------ */

class ProgressParser {
  constructor(totalSeconds) {
    this.total = totalSeconds;
    this.last = 0;
    this.lastAt = 0;
  }

  /** Alimenta stderr de ffmpeg; devuelve {percent} cuando avanza. */
  push(chunk) {
    let hit = null;
    const re = /time=(\d+:\d+:\d+(?:\.\d+)?)/g;
    let m;
    while ((m = re.exec(chunk)) !== null) {
      const t = parseTimeToSeconds(m[1]);
      if (t > this.last) {
        this.last = t;
        hit = t;
      }
    }
    if (hit == null) return null;
    // abstrain de reportar 100% prematuramente (ffmpeg lo escribe al cerrar)
    const percent = Math.min(99, Math.round((Math.min(hit, this.total) / this.total) * 100));
    return { percent, played: hit, total: this.total };
  }

  done() {
    return { percent: 100, played: this.total, total: this.total };
  }
}

/* ------------------------------------------------------------------ */

module.exports = {
  ROOT,
  PROJECTS_DIR,
  TEMP_DIR,
  BRAND_DIR,
  WIN,
  projectDir,
  projectInputDir,
  projectConfigFile,
  projectScriptFile,
  projectOutputDir,
  projectThumbDir,
  ensureDir,
  safeResolve,
  readJson,
  writeJson,
  writeJsonAtomic,
  readProject,
  writeProject,
  patchProject,
  projectMedia,
  slugify,
  toKebab,
  detectFFmpeg,
  dieIfFFmpegMissing,
  run,
  ffprobeMeta,
  makeThumb,
  parseTimeToSeconds,
  cancelledError,
  throwIfCancelled,
  ProgressParser,
};