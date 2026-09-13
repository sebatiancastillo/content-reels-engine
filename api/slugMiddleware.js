'use strict';

/**
 * Middleware compartido de validación de slug (:id) para las rutas
 * /api/projects/<slug>/...
 *
 * Se monta ANTES de cada router en server.js. Valida que el primer segmento
 * de la ruta sea un slug seguro ([a-z0-9-]) y, si no, responde 400.
 * Esto bloquea path traversal (p. ej. "..") que llegaría a fs.rmSync/readProject
 * y slugs malformados en el resto de rutas.
 */

const SLUG_RE = /^[a-z0-9-]{1,60}$/;

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function validateSlug(req, res, next) {
  const seg = String(req.path || '').split('/').find((s) => s !== '');
  const id = seg ? decodeSafe(seg) : '';
  if (id && !SLUG_RE.test(id)) {
    return res.status(400).json({ error: 'Slug de proyecto inválido.' });
  }
  next();
}

module.exports = validateSlug;