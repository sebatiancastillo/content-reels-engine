'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { readProject, patchProject, projectOutputDir } = require('../engine/utils');
const { renderProject } = require('../engine/render');

const router = express.Router();

/** Renders en curso por slug (evita doble render en paralelo del mismo proyecto). */
const active = new Map(); // slug -> { flag, promise }

/* ---------------- POST /api/projects/:id/render  ---------------- */
/** Dispara el pipeline (asíncrono). Responde inmediatamente { started: true }. */
router.post('/:id/render', async (req, res, next) => {
  try {
    const slug = req.params.id;
    const project = readProject(slug);
    if (!project.name) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    if (active.has(slug)) {
      return res.status(409).json({ error: 'Ya hay un render en curso para este proyecto.', render: project.render });
    }

    await patchProject(slug, {
      status: 'rendering',
      render: {
        status: 'rendering',
        progress: 0,
        message: 'Iniciando pipeline…',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        validation: null,
      },
    });

    const session = { flag: false, promise: null };
    const promise = runPipeline(slug, () => session.flag);
    session.promise = promise;
    active.set(slug, session);
    promise.finally(() => {
      if (active.get(slug) === session) active.delete(slug);
    }).catch(() => {});

    res.status(202).json({ started: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Ejecuta el pipeline completo. Es el "worker" del proceso asíncrono:
 * escribir progreso en project.json con throttling y registrar errores
 * legibles (stderr completo de FFmpeg) si algo falla.
 */
async function runPipeline(slug, isCancelled) {
  let lastWrite = 0;
  const logs = [];

  const throttledWrite = (patch) => {
    patchProject(slug, patch).catch(() => {});
  };

  const remember = async (patch) => {
    const project = readProject(slug);
    await throttle(() =>
      throttledWrite({
        render: { ...project.render, ...patch.render },
      })
    );
  };

  const throttle = async (fn) => {
    const now = Date.now();
    if (now - lastWrite > 200) {
      lastWrite = now;
      await fn();
    }
  };

  try {
    const result = await renderProject(slug, {
      isCancelled,
      onLog: (line) => {
        logs.push(line);
        console.log(`[${slug}] ${line}`);
        remember({ render: { message: line } });
      },
      onProgress: (p) => {
        throttle(() =>
          patchProject(slug, {
            render: { progress: p.percent, message: `Renderizando… ${p.percent}%` },
          })
        );
      },
    });

    // render + validación ok
    const project = readProject(slug);
    await patchProject(slug, {
      status: 'rendered',
      render: {
        ...project.render,
        status: 'done',
        progress: 100,
        message: 'Render completado y validado.',
        finishedAt: new Date().toISOString(),
        output: result.outFile ? path.basename(result.outFile) : null,
        validation: result.metadata,
        error: null,
      },
    });
    console.log(`[${slug}] Render completado: ${result.outFile}`);
    return { ok: true, file: result.outFile };
  } catch (err) {
    if (err && err.code === 'CANCELLED') {
      console.log(`[${slug}] Render cancelado por el usuario.`);
      try {
        const project = readProject(slug);
        await patchProject(slug, {
          status: project.status === 'rendering' ? 'ready' : project.status,
          render: {
            ...project.render,
            status: 'cancelled',
            progress: project.render.progress || 0,
            message: 'Render cancelado por el usuario.',
            finishedAt: new Date().toISOString(),
            error: null,
            logs,
          },
        });
      } catch (writeErr) {
        console.error(`[${slug}] No se pudo persistir la cancelación:`, writeErr.message);
      }
      return { ok: false, cancelled: true };
    }
    console.error(`[${slug}] Render fallido:`, err.message);
    try {
      const project = readProject(slug);
      await patchProject(slug, {
        status: 'error',
        render: {
          ...project.render,
          status: 'error',
          message: err.message || 'Error desconocido durante el render.',
          finishedAt: new Date().toISOString(),
          error: {
            name: err.name || 'Error',
            message: err.message || 'Error desconocido.',
            code: err.code || null,
            stderrTail: err.stderrTail ? err.stderrTail.split('\n').slice(-120).join('\n') : null,
            validationErrors: err.validation ? err.validation.errors : null,
            logs,
          },
        },
      });
    } catch (writeErr) {
      console.error(`[${slug}] No se pudo persistir el error:`, writeErr.message);
    }
    return { ok: false, error: err.message };
  }
}

/* ---------------- POST /api/projects/:id/render/cancel  ---------------- */
/** Solicita cancelar el render en curso (se propaga por el pipeline y mata ffmpeg). */
router.post('/:id/render/cancel', async (req, res, next) => {
  try {
    const slug = req.params.id;
    const project = readProject(slug);
    if (!project.name) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    const session = active.get(slug);
    if (!session) {
      return res.status(409).json({ error: 'No hay un render en curso para cancelar.', render: project.render });
    }

    session.flag = true;
    await patchProject(slug, {
      render: {
        ...project.render,
        status: 'cancelling',
        message: 'Cancelando render…',
      },
    });
    res.json({ cancelling: true });
  } catch (err) {
    next(err);
  }
});

/* ---------------- GET /api/projects/:id/render/status  ---------------- */
router.get('/:id/render/status', (req, res) => {
  const slug = req.params.id;
  const project = readProject(slug);
  if (!project.name) return res.status(404).json({ error: 'Proyecto no encontrado.' });

  res.json({
    running: active.has(slug),
    render: project.render,
    materialPending: (project.status || 'created') === 'created',
  });
});

/* ---------------- GET /api/projects/:id/output  ---------------- */
/** Sirve el mp4 final para previsualización (soporta HTTP Range para el <video>). */
router.get('/:id/output', (req, res) => {
  const slug = req.params.id;
  const project = readProject(slug);
  if (!project.name) return res.status(404).json({ error: 'Proyecto no encontrado.' });

  const file = findOutput(slug);
  if (!file) {
    return res.status(409).json({ error: 'Aún no hay un render completado para este proyecto.', render: project.render });
  }

  const stat = fs.statSync(file);
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(file).pipe(res);
  }
});

function findOutput(slug) {
  const dir = projectOutputDir(slug);
  if (!fs.existsSync(dir)) return null;
  const mp4 = fs.readdirSync(dir).find((f) => f.endsWith('.mp4'));
  return mp4 ? path.join(dir, mp4) : null;
}

module.exports = router;
module.exports.isActive = (slug) => Boolean(active.get(slug));