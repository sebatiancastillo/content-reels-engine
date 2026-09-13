'use strict';

/**
 * API global de marca (brand/).
 *
 * GET  /api/brand          → config completa (colores, transición, logo, fuentes, música)
 * POST /api/brand          → guarda colores + transición en branding.json
 * POST /api/brand/logo     → sube/reemplaza logo.png
 * POST /api/brand/font     → sube/reemplaza la tipografía (.ttf/.otf)
 * POST /api/brand/music    → sube música de fondo
 * DELETE /api/brand/music/:file → elimina un archivo de música
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const {
  BRAND_DIR,
  ensureDir,
  readJson,
  writeJson,
} = require('../engine/utils');

const router = express.Router();

const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];
const FONT_EXT  = ['.ttf', '.otf'];

/* ------------------------------------------------------------------ */
/* Helpers compartidos con material.js (upload + sanitize)              */
/* ------------------------------------------------------------------ */

function sanitizeFileName(name) {
  const base = path.basename(String(name || '')).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '') || `archivo_${Date.now()}.bin`;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, ensureDir(path.join(BRAND_DIR, 'uploads-tmp'))),
    filename: (req, file, cb) => cb(null, `${Date.now()}_${sanitizeFileName(file.originalname)}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
});

function readBranding() {
  return readJson(path.join(BRAND_DIR, 'branding.json'), {
    brand: 'Vikingos',
    colors: { primary: '#C8A453', secondary: '#2B2118', accent: '#8C6A34' },
    transitions: { seconds: 0.3 },
    font: { regular: 'Vikingos-Regular.ttf', bold: 'Vikingos-Bold.ttf' },
  });
}

function cleanupTmp(file) {
  try { if (file && file.path) fs.unlinkSync(file.path); } catch { /* */ }
}

/* ------------------------------------------------------------------ */
/* GET /api/brand                                                      */
/* ------------------------------------------------------------------ */
router.get('/', (req, res) => {
  const config = readBranding();

  const logoPath = path.join(BRAND_DIR, 'logo', 'logo.png');
  const hasLogo = fs.existsSync(logoPath);

  const fontsDir = path.join(BRAND_DIR, 'fonts');
  const fonts = fs.existsSync(fontsDir)
    ? fs.readdirSync(fontsDir).filter((f) => FONT_EXT.includes(path.extname(f).toLowerCase()))
    : [];

  const musicDir = path.join(BRAND_DIR, 'music');
  const music = fs.existsSync(musicDir)
    ? fs.readdirSync(musicDir).filter((f) => AUDIO_EXT.includes(path.extname(f).toLowerCase())).sort()
    : [];

  res.json({
    brand: config.brand || '',
    colors: config.colors || {},
    transitions: config.transitions || { seconds: 0.3 },
    font: config.font || {},
    hasLogo,
    fonts,
    music,
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/brand  (colores + transición)                             */
/* ------------------------------------------------------------------ */
router.post('/', async (req, res, next) => {
  try {
    const current = readBranding();
    const body = req.body || {};
    const patch = {};

    if (body.brand !== undefined) {
      patch.brand = String(body.brand).trim().slice(0, 60) || current.brand;
    }

    if (body.font === 'default') {
      patch.font = { regular: 'Vikingos-Regular.ttf', bold: 'Vikingos-Bold.ttf' };
      try { require('../engine/render').resetFonts(); } catch { /* */ }
    }

    if (body.colors && typeof body.colors === 'object') {
      const valid = ['primary', 'secondary', 'accent'];
      const colors = { ...(current.colors || {}) };
      for (const k of valid) {
        if (typeof body.colors[k] === 'string' && /^#[0-9A-Fa-f]{3,8}$/.test(body.colors[k])) {
          colors[k] = body.colors[k];
        }
      }
      patch.colors = colors;
    }

    if (body.transitions && typeof body.transitions === 'object') {
      const seconds = Number(body.transitions.seconds);
      if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 5) {
        patch.transitions = { seconds: Math.round(seconds * 100) / 100 };
      }
    }

    const merged = { ...current, ...patch };
    await writeJson(path.join(BRAND_DIR, 'branding.json'), merged);
    res.json({ colors: merged.colors, transitions: merged.transitions, brand: merged.brand });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/brand/logo  (reemplaza brand/logo/logo.png)               */
/* ------------------------------------------------------------------ */
router.post('/logo', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) { cleanupTmp(req.file); return res.status(400).json({ error: 'No se envió archivo.' }); }

    const logoDir = ensureDir(path.join(BRAND_DIR, 'logo'));
    const dest = path.join(logoDir, 'logo.png');
    fs.copyFileSync(req.file.path, dest);
    cleanupTmp(req.file);

    res.json({ ok: true, file: 'brand/logo/logo.png' });
  } catch (err) {
    cleanupTmp(req.file);
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/brand/font  (reemplaza Vikingos-Regular.ttf y Bold.ttf)   */
/* ------------------------------------------------------------------ */
router.post('/font', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) { cleanupTmp(req.file); return res.status(400).json({ error: 'No se envió archivo.' }); }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!FONT_EXT.includes(ext)) {
      cleanupTmp(req.file);
      return res.status(400).json({ error: `Formato no soportado (${ext}). Usa .ttf o .otf.` });
    }

    const fontsDir = ensureDir(path.join(BRAND_DIR, 'fonts'));
    const stem = sanitizeFileName(path.basename(req.file.originalname, ext));
    const newName = `${stem}${ext}`;
    const dest = path.join(fontsDir, newName);
    fs.copyFileSync(req.file.path, dest);
    cleanupTmp(req.file);

    // Invalida el cache de fuentes de render.js para que la nueva tipografía
    // se use en el próximo render sin reiniciar el servidor.
    try { require('../engine/render').resetFonts(); } catch { /* */ }

    // Actualizar branding.json para apuntar a la nueva fuente (regular + bold)
    const current = readBranding();
    current.font = { regular: newName, bold: newName };
    await writeJson(path.join(BRAND_DIR, 'branding.json'), current);

    const fonts = fs.readdirSync(fontsDir).filter((f) => FONT_EXT.includes(path.extname(f).toLowerCase()));
    res.json({ ok: true, file: newName, font: current.font, fonts });
  } catch (err) {
    cleanupTmp(req.file);
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/brand/music  (sube a brand/music/)                        */
/* ------------------------------------------------------------------ */
router.post('/music', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) { cleanupTmp(req.file); return res.status(400).json({ error: 'No se envió archivo.' }); }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!AUDIO_EXT.includes(ext)) {
      cleanupTmp(req.file);
      return res.status(400).json({ error: `Formato no soportado (${ext}). Usa mp3, wav, m4a, aac, ogg o flac.` });
    }

    const musicDir = ensureDir(path.join(BRAND_DIR, 'music'));
    const stem = sanitizeFileName(path.basename(req.file.originalname, ext));
    const newName = `${stem}${ext}`;
    const dest = path.join(musicDir, newName);
    fs.copyFileSync(req.file.path, dest);
    cleanupTmp(req.file);

    const music = fs.readdirSync(musicDir).filter((f) => AUDIO_EXT.includes(path.extname(f).toLowerCase())).sort();
    res.json({ ok: true, file: newName, music });
  } catch (err) {
    cleanupTmp(req.file);
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* DELETE /api/brand/music/:file                                       */
/* ------------------------------------------------------------------ */
router.delete('/music/:file', async (req, res, next) => {
  try {
    const fileName = path.basename(decodeURIComponent(req.params.file));
    const musicDir = path.join(BRAND_DIR, 'music');
    const full = path.join(musicDir, fileName);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Archivo no encontrado.' });

    fs.unlinkSync(full);
    const music = fs.readdirSync(musicDir).filter((f) => AUDIO_EXT.includes(path.extname(f).toLowerCase())).sort();
    res.json({ ok: true, music });
  } catch (err) {
    next(err);
  }
});

module.exports = router;