'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT, readJson, patchProject, projectInputDir, projectScriptFile, projectConfigFile } = require('./utils');

const TEMPLATES_DIR = path.join(ROOT, 'templates');

/* ------------------------------------------------------------------ */
/* Template                                                           */
/* ------------------------------------------------------------------ */

function loadTemplate(name = 'reel-default') {
  const file = path.join(TEMPLATES_DIR, `${name}.json`);
  const template = readJson(file, null);
  if (!template) throw new Error(`No existe la plantilla de edición "${name}" (${file})`);
  return template;
}

/* ------------------------------------------------------------------ */
/* Material disponible                                                 */
/* ------------------------------------------------------------------ */

const MEDIA_EXT = {
  video: ['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv'],
  photo: ['.jpg', '.jpeg', '.png', '.webp'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'],
};

/** kind ('video'|'photo'|'audio') → subcarpeta de input/. */
const FOLDER_OF = { video: 'videos', photo: 'photos', audio: 'audio' };

const EXT_TO_KIND = new Map(
  Object.entries(MEDIA_EXT).flatMap(([kind, exts]) => exts.map((e) => [e, kind]))
);

function kindOfFile(name) {
  return EXT_TO_KIND.get(path.extname(String(name).toLowerCase())) || null;
}

function listMedia(slug) {
  const result = { videos: [], photos: [], audio: [] };
  for (const [kind, exts] of Object.entries(MEDIA_EXT)) {
    const dir = projectInputDir(slug, FOLDER_OF[kind]);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (exts.includes(path.extname(f).toLowerCase())) {
        result[FOLDER_OF[kind]].push({ fileName: f, url: `/api/projects/${slug}/material/${encodeURIComponent(f)}` });
      }
    }
  }
  result.videos.sort(byNameConvention);
  result.photos.sort(byNameConvention);
  result.audio.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return result;
}

/** Ordena por número de prefijo (01_, 02_...) y luego alfabético. */
function byNameConvention(a, b) {
  const an = prefixNumber(a.fileName);
  const bn = prefixNumber(b.fileName);
  if (an !== null && bn !== null && an !== bn) return an - bn;
  return a.fileName.localeCompare(b.fileName);
}

/** Número del prefijo "NN_" del archivo, o null. */
function prefixNumber(fileName) {
  const m = /^(\d{1,3})[_-]/.exec(fileName);
  return m ? parseInt(m[1], 10) : null;
}

/* ------------------------------------------------------------------ */
/* Análisis (v1)                                                       */
/* ------------------------------------------------------------------ */

/**
 * v1 — asigna sección y duración a cada clip y persiste el resultado.
 *
 * Sección:
 *   - ¿Prefijo numérico (01_, 02_...)? Se usa como posición en
 *     `template.sections`; un índice mayor a la última sección cae en la
 *     última (CTA), para que el material de proceso extra se monte al final.
 *   - ¿Sin prefijo? Asignación secuencial con saturación a la última.
 *
 * Duración:
 *   Los `weight` de las secciones son pesos relativos. `distributeDurations`
 *   reparte la duración objetivo exactamente (a décimas), respetando `min`.
 *
 * FASE 2 (arquitectura preparada, sin implementar): scdet + silencedetect de
 * FFmpeg para detectar escenas/silencios y recortar el material automáticamente.
 * analyze.js solo ordena y dimensiona; el contrato de salida (contenido + orden
 * + duraciones) se mantendrá para no romper prepare/render.
 */
function analyzeProject(slug, cfg = {}) {
  const media = listMedia(slug);
  const clipsRaw = [
    ...media.videos.map((m) => ({ kind: 'video', ...m })),
    ...media.photos.map((m) => ({ kind: 'photo', ...m })),
  ];
  if (clipsRaw.length === 0) {
    const err = new Error('El proyecto no tiene material cargado (videos o fotos).');
    err.code = 'NO_MATERIAL';
    throw err;
  }

  const template = loadTemplate(cfg.template || 'reel-default');
  const sections = template.sections;
  const script = readJson(projectScriptFile(slug), {});
  const targetDuration = Math.max(
    4,
    Number(cfg.targetDuration || script.targetDuration || template.targetDuration) || template.targetDuration
  );

  // Orden manual guardado (prioridad sobre la convención de nombres)
  const saved = readJson(projectConfigFile(slug), {});
  let ordered = clipsRaw;
  if (Array.isArray(saved.clipOrder) && saved.clipOrder.length === clipsRaw.length) {
    const byKey = new Map(clipsRaw.map((c) => [`${c.kind}:${c.fileName}`, c]));
    const rebuilt = saved.clipOrder.map((k) => byKey.get(k)).filter(Boolean);
    if (rebuilt.length === clipsRaw.length) ordered = rebuilt;
  }

  const clips = ordered.map((c, i) => {
    const num = prefixNumber(c.fileName);
    let sectionIdx;
    if (num !== null) {
      sectionIdx = num - 1;
      if (sectionIdx > sections.length - 1) sectionIdx = sections.length - 1;
    } else {
      sectionIdx = Math.min(i, sections.length - 1);
    }
    const section = sections[sectionIdx];
    return {
      id: `${c.kind}:${c.fileName}`,
      kind: c.kind,
      fileName: c.fileName,
      url: c.url,
      section: { id: section.id, label: section.label, weight: section.weight, min: section.min },
    };
  });

  const durations = distributeDurations(targetDuration, clips.map((c) => c.section));
  const result = clips.map((c, i) => ({ ...c, duration: durations[i] }));
  const totalDuration = Math.round(result.reduce((s, c) => s + c.duration, 0) * 10) / 10;

  patchProject(slug, {
    analyzedAt: new Date().toISOString(),
    clips: result.map((c) => ({ id: c.id, kind: c.kind, fileName: c.fileName, section: c.section.id, label: c.section.label, duration: c.duration })),
    targetDuration: totalDuration,
  }).catch(() => {});

  return { clips: result, totalDuration, template, sections };
}

/**
 * Reparte `target` (segundos) entre items [{min, weight}] devolviendo
 * duraciones en décimas que suman exactamente `target`.
 */
function distributeDurations(target, items) {
  const W = items.reduce((s, it) => s + it.weight, 0);
  const minSum = items.reduce((s, it) => s + it.min, 0);
  if (minSum > target) {
    throw new Error(
      `La duración objetivo (${target}s) es menor que la suma de los mínimos de sección (${minSum}s). Sube la duración objetivo.`
    );
  }

  const r = (n) => Math.round(n * 10) / 10;
  let d = items.map((it) => r((target * it.weight) / W));

  // 1) forzar mínimos, robando décimas del clip con mayor holgura
  for (let i = 0; i < items.length; i++) {
    let guard = 0;
    while (d[i] < items[i].min && guard++ < 1000) {
      const need = items[i].min - d[i];
      let donor = -1;
      let maxHeadroom = 0;
      for (let j = 0; j < items.length; j++) {
        if (j === i) continue;
        const headroom = d[j] - items[j].min;
        if (headroom > maxHeadroom) {
          maxHeadroom = headroom;
          donor = j;
        }
      }
      if (donor < 0) break; // imposible: minSum <= target
      const give = Math.min(need, maxHeadroom);
      d[donor] = r(d[donor] - give);
      d[i] = r(d[i] + give);
    }
  }

  // 2) normalizar a la suma exacta a base de décimas
  const total = r(d.reduce((s, v) => s + v, 0));
  let diff = Math.round((target - total) * 10);
  if (diff !== 0) {
    const pool =
      diff > 0
        ? d.map((v, i) => ({ i, v })).sort((a, b) => b.v - a.v)
        : d.map((v, i) => ({ i, v })).filter((x) => x.v > items[x.i].min).sort((a, b) => b.v - a.v);
    let k = 0;
    while (diff !== 0 && pool.length > 0 && k < 100000) {
      const x = pool[k % pool.length];
      if (diff > 0) d[x.i] = r(d[x.i] + 0.1);
      else d[x.i] = r(d[x.i] - 0.1);
      diff = diff > 0 ? diff - 1 : diff + 1;
      k++;
    }
  }

  return d.map((v) => Math.max(0.2, r(v)));
}

/* ------------------------------------------------------------------ */

module.exports = {
  loadTemplate,
  MEDIA_EXT,
  kindOfFile,
  listMedia,
  byNameConvention,
  prefixNumber,
  analyzeProject,
  distributeDurations,
};