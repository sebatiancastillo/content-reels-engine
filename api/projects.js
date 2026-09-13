'use strict';

const fs = require('fs');
const express = require('express');
const {
  PROJECTS_DIR,
  projectDir,
  readProject,
  writeProject,
  patchProject,
  projectMedia,
  ensureDir,
} = require('../engine/utils');
const { readJson } = require('../engine/utils');

const { isActive } = require('./render');

const router = express.Router();

/** Primer thumbnail del proyecto según el orden de edición. */
function firstThumb(slug) {
  const media = projectMedia(slug);
  const indexed = {};
  media.videos.forEach((m) => { indexed[`video:${m.fileName}`] = m; });
  media.photos.forEach((m) => { indexed[`photo:${m.fileName}`] = m; });
  const order = readProject(slug).clipOrder || [];
  for (const k of order) {
    const m = indexed[k];
    if (m && m.thumb) return m.thumb;
  }
  for (const list of [media.videos, media.photos]) {
    for (const m of list) if (m.thumb) return m.thumb;
  }
  return null;
}

/* ---------------- POST /api/projects  ---------------- */
/** Crear proyecto (nombre → slug kebab-case). Devuelve el proyecto creado. */
router.post('/', async (req, res, next) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'El nombre del proyecto es obligatorio.' });
    if (name.length > 80) return res.status(400).json({ error: 'El nombre no puede superar 80 caracteres.' });

    const slug = require('../engine/utils').slugify(name);
    const dir = projectDir(slug);
    if (fs.existsSync(dir)) {
      return res.status(409).json({ error: `Ya existe un proyecto con el slug "${slug}".` });
    }

    ensureDir(dir);
    ensureDir(projectDir(slug) + '/input/videos');
    ensureDir(projectDir(slug) + '/input/photos');
    ensureDir(projectDir(slug) + '/input/audio');
    ensureDir(projectDir(slug) + '/script');
    ensureDir(projectDir(slug) + '/config');
    ensureDir(projectDir(slug) + '/output');

    const now = new Date().toISOString();
    const project = await writeProject(slug, { slug, name, createdAt: now, status: 'created' });

    res.status(201).json({ project });
  } catch (err) {
    next(err);
  }
});

/* ---------------- GET /api/projects  ---------------- */
/** Listar proyectos (del directorio projects/). */
router.get('/', (req, res) => {
  const list = [];
  if (fs.existsSync(PROJECTS_DIR)) {
    for (const entry of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      const p = readProject(slug);
      if (!p.name && !fs.existsSync(require('path').join(projectDir(slug), 'config', 'project.json'))) continue;
      list.push({
        slug: p.slug || slug,
        name: p.name || slug,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        status: p.status,
        render: p.render,
        thumb: firstThumb(slug),
        duration: (p.render && p.render.validation && p.render.validation.duration) || null,
        mediaCounts: {
          videos: projectMedia(slug).videos.length,
          photos: projectMedia(slug).photos.length,
          audio: projectMedia(slug).audio.length,
        },
      });
    }
  }
  list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  res.json({ projects: list });
});

/* ---------------- GET /api/projects/:id  ---------------- */
/** Estado completo: material, guion, config, clips, render. */
router.get('/:id', async (req, res, next) => {
  try {
    const slug = req.params.id;
    const project = readProject(slug);
    if (!project.name) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    const media = projectMedia(slug);
    const script = readJson(require('../engine/utils').projectScriptFile(slug), null);

    res.json({
      project,
      media,
      script,
      outputVideo: project.render && project.render.output
        ? `${req.baseUrl}/${slug}/output?cb=${encodeURIComponent(String(project.render.finishedAt || ''))}`
        : null,
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------- DELETE /api/projects/:id  ---------------- */
/** Elimina el proyecto completo (carpeta) si no hay un render en curso. */
router.delete('/:id', async (req, res, next) => {
  try {
    const slug = req.params.id;
    const project = readProject(slug);
    if (!project.name) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    if (isActive(slug)) {
      return res.status(409).json({ error: 'No se puede eliminar un proyecto con un render en curso. Cancela el render primero.' });
    }

    fs.rmSync(projectDir(slug), { recursive: true, force: true });
    res.json({ ok: true, slug });
  } catch (err) {
    next(err);
  }
});

module.exports = router;