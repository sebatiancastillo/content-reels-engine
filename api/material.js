'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const {
  TEMP_DIR,
  projectDir,
  projectInputDir,
  projectThumbDir,
  readProject,
  patchProject,
  projectMedia,
  ensureDir,
  safeResolve,
  makeThumb,
} = require('../engine/utils');

const router = express.Router();
const { kindOfFile } = require('../engine/analyze');

const ALLOWED = new Set(['video', 'photo', 'audio']);

function sanitizeFileName(name) {
  const base = path.basename(String(name || '')).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '');
  return clean || `archivo_${Date.now()}.bin`;
}

/** Nombre único: si existe, añade sufijo antes de la extensión. */
function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let candidate = fileName;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}_${i}${ext}`;
    i++;
  }
  return path.join(dir, candidate);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, ensureDir(path.join(TEMP_DIR, 'uploads'))),
    filename: (req, file, cb) => cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${sanitizeFileName(file.originalname)}`),
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 24 },
});

/* ---------------- POST /api/projects/:id/material  ---------------- */
router.post('/:id/material', upload.array('files'), async (req, res, next) => {
  try {
    const slug = req.params.id;
    const project = readProject(slug);
    if (!project.name) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    const accepted = [];
    const rejected = [];
    for (const file of req.files || []) {
      const kind = kindOfFile(file.originalname);
      if (!kind || !ALLOWED.has(kind)) {
        fs.unlink(file.path, () => {});
        rejected.push({ fileName: file.originalname, reason: `Tipo de archivo no soportado (${path.extname(file.originalname) || 'sin extensión'}).` });
        continue;
      }
      const safe = sanitizeFileName(file.originalname);
      const destDir = projectInputDir(slug, kind === 'video' ? 'videos' : kind === 'photo' ? 'photos' : 'audio');
      ensureDir(destDir);
      const dest = uniquePath(destDir, safe);
      fs.renameSync(file.path, dest);
      accepted.push({ fileName: path.basename(dest), kind });

      // previsualización para tarjetas y lista de material
      if (kind === 'video' || kind === 'photo') {
        await makeThumb({ src: dest, dest: path.join(projectThumbDir(slug), `${path.basename(dest)}.jpg`) });
      }
    }

    await patchProject(slug, { status: project.status === 'created' ? 'material' : project.status });
    res.status(201).json({ accepted, rejected, media: projectMedia(slug) });
  } catch (err) {
    next(err);
  }
});

/* ---------------- GET /api/projects/:id/material/:file  ---------------- */
router.get('/:id/material/:file', (req, res, next) => {
  try {
    const slug = req.params.id;
    const fileName = req.params.file;
    const project = readProject(slug);
    if (!project.name) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    for (const kind of ['videos', 'photos', 'audio']) {
      const base = projectInputDir(slug, kind);
      if (!fs.existsSync(base)) continue;
      for (const name of fs.readdirSync(base)) {
        if (name === fileName) {
          const full = safeResolve(base, name);
          return res.sendFile(full);
        }
      }
    }
    res.status(404).json({ error: `Archivo "${fileName}" no encontrado en el proyecto.` });
  } catch (err) {
    next(err);
  }
});

/* ---------------- GET /api/projects/:id/thumb/:file  ---------------- */
/** Sirve el JPG de previsualización de un clip (video o foto). */
router.get('/:id/thumb/:file', (req, res, next) => {
  try {
    const slug = req.params.id;
    const project = readProject(slug);
    if (!project.name) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    const fileName = path.basename(req.params.file);
    const base = projectThumbDir(slug);
    const thumb = path.join(base, `${fileName}.jpg`);
    if (fs.existsSync(thumb)) {
      return res.sendFile(safeResolve(base, `${fileName}.jpg`));
    }
    res.status(404).json({ error: `Thumbnail no disponible para "${fileName}".` });
  } catch (err) {
    next(err);
  }
});

/* ---------------- DELETE /api/projects/:id/material/:file  ---------------- */
router.delete('/:id/material/:file', async (req, res, next) => {
  try {
    const slug = req.params.id;
    const fileName = req.params.file;
    const project = readProject(slug);
    if (!project.name) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    let removed = false;
    for (const kind of ['videos', 'photos', 'audio']) {
      const base = projectInputDir(slug, kind);
      if (!fs.existsSync(base)) continue;
      for (const name of fs.readdirSync(base)) {
        if (name === fileName) {
          const full = safeResolve(base, name);
          fs.unlinkSync(full);
          removed = true;
        }
      }
    }
    if (!removed) return res.status(404).json({ error: `Archivo "${fileName}" no encontrado.` });

    // thumbnails asociados
    try {
      fs.unlinkSync(path.join(projectThumbDir(slug), `${fileName}.jpg`));
    } catch { /* sin thumb */ }

    // limpiar clipOrder obsoleto
    const current = readProject(slug);
    if (Array.isArray(current.clipOrder)) {
      const media = projectMedia(slug);
      const validKeys = new Set([
        ...media.videos.map((m) => `video:${m.fileName}`),
        ...media.photos.map((m) => `photo:${m.fileName}`),
      ]);
      const clipOrder = current.clipOrder.filter((k) => validKeys.has(k));
      if (clipOrder.length !== current.clipOrder.length) await patchProject(slug, { clipOrder });
    }

    res.json({ removed: true, media: projectMedia(slug) });
  } catch (err) {
    next(err);
  }
});

/* ---------------- POST /api/projects/:id/material/order  ---------------- */
/** Reordenar clips: body { order: ["video:01_hook.mp4", "photo:02_x.jpg", ...] } */
router.post('/:id/material/order', async (req, res, next) => {
  try {
    const slug = req.params.id;
    const project = readProject(slug);
    if (!project.name) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    let order = Array.isArray(req.body && req.body.order) ? req.body.order : [];
    const media = projectMedia(slug);
    const valid = new Set([
      ...media.videos.map((m) => `video:${m.fileName}`),
      ...media.photos.map((m) => `photo:${m.fileName}`),
    ]);
    order = order.filter((k) => typeof k === 'string' && valid.has(k));

    // asegurar que estén todos
    for (const key of valid) if (!order.includes(key)) order.push(key);

    await patchProject(slug, { clipOrder: order });
    res.json({ order, media });
  } catch (err) {
    next(err);
  }
});

module.exports = router;