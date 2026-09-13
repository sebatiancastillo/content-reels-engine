'use strict';

const express = require('express');
const { readProject, patchProject, readJson, writeJson, projectScriptFile } = require('../engine/utils');

const router = express.Router();

const SCRIPT_FIELDS = ['hook', 'dolor', 'problema', 'proceso', 'resultado', 'cta'];

/* ---------------- POST /api/projects/:id/script  ---------------- */
/** Guardar guion: Hook, Dolor, Problema, Proceso, Resultado, CTA, duración objetivo, observaciones. */
router.post('/:id/script', async (req, res, next) => {
  try {
    const slug = req.params.id;
    const current = readProject(slug);
    if (!current.name) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    const body = req.body || {};
    const clean = {};
    let touched = false;
    for (const field of SCRIPT_FIELDS) {
      if (typeof body[field] === 'string' && body[field].trim() !== '') {
        clean[field] = body[field].trim();
        touched = true;
      }
    }
    if (typeof body.observaciones === 'string') {
      clean.observaciones = body.observaciones.trim();
      touched = true;
    }
    if (body.targetDuration !== undefined) {
      const t = Math.max(4, Math.min(120, Math.round(Number(body.targetDuration)) || 30));
      clean.targetDuration = t;
      touched = true;
    }
    if (!touched && SCRIPT_FIELDS.every((f) => String(body[f] || '').trim() === '')) {
      return res.status(400).json({ error: 'Escribe al menos un campo del guion (Hook, Dolor, Problema, Proceso, Resultado o CTA).' });
    }

    const existing = readJson(projectScriptFile(slug), {
      hook: '', dolor: '', problema: '', proceso: '', resultado: '', cta: '',
      observaciones: '', targetDuration: 30,
    });
    const merged = { ...existing, ...clean };
    await writeJson(projectScriptFile(slug), merged);

    const project = await patchProject(slug, { status: projectStatus(current, 'script') });
    res.json({ script: merged, project });
  } catch (err) {
    next(err);
  }
});

/* ---------------- POST /api/projects/:id/config  ---------------- */
/** Guardar plataforma, formato y estilo elegidos. */
router.post('/:id/config', async (req, res, next) => {
  try {
    const slug = req.params.id;
    const project = readProject(slug);
    if (!project.name) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    const body = req.body || {};
    const patch = {};

    const platforms = ['instagram', 'tiktok'];
    if (body.platform && platforms.includes(body.platform)) patch.platform = body.platform;

    const formats = ['9:16'];
    if (body.format && formats.includes(body.format)) patch.format = { width: 1080, height: 1920, fps: 30 };

    const styles = ['limpio', 'dinamico', 'profesional'];
    if (body.style && styles.includes(body.style)) patch.style = body.style;

    if (body.targetDuration || body.targetDuration === 0) {
      patch.targetDuration = Math.max(4, Math.min(120, Math.round(Number(body.targetDuration)) || 30));
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Configuración inválida. Revisa plataforma/formato/estilo.' });
    }

    const updated = await patchProject(slug, { ...patch, status: projectStatus(project, 'config') });
    res.json({ project: updated });
  } catch (err) {
    next(err);
  }
});

function projectStatus(project, step) {
  const order = ['created', 'material', 'script', 'config', 'ready', 'rendered'];
  const currentIdx = Math.max(order.indexOf(project.status || 'created'), 0);
  const stepIdx = order.indexOf(step);
  return stepIdx > currentIdx ? order[stepIdx] : project.status;
}

/* ---------------- GET /api/projects/:id/state  ---------------- */
/** Estado completo servido al frontend (guion, config, clips, render). */
router.get('/:id/state', (req, res, next) => {
  try {
    const slug = req.params.id;
    const project = readProject(slug);
    if (!project.name) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    const script = readJson(projectScriptFile(slug), null);
    res.json({
      project,
      script,
      baseUrl: `${req.protocol}://${req.get('host')}`,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;