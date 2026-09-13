'use strict';

const path = require('path');
const express = require('express');

const { dieIfFFmpegMissing, ROOT } = require('./engine/utils');

// ---------------------------------------------------------------------
// Verificación de FFmpeg al arrancar (ventana temprana de error claro,
// en vez de fallar a mitad de un render).
// ---------------------------------------------------------------------
const ff = dieIfFFmpegMissing();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// ---------------------------------------------------------------------
// API interna
// ---------------------------------------------------------------------
app.use('/api/projects', require('./api/projects'));
app.use('/api/projects', require('./api/material'));
app.use('/api/projects', require('./api/script'));
app.use('/api/projects', require('./api/render'));

// ---------------------------------------------------------------------
// Frontend estático
// ---------------------------------------------------------------------
app.use(express.static(path.join(ROOT, 'app')));

// ---------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err && err.code && String(err.code).startsWith('LIMIT_')) {
    return res.status(413).json({ error: `El archivo excede el límite permitido (${err.code}).` });
  }
  const message = err && err.message ? err.message : 'Error interno del servidor.';
  if (err && err.stderr) console.error('[error]', err.stderr.split('\n').slice(-40).join('\n'));
  else if (err) console.error('[error]', err);
  res.status(500).json({ error: message, stack: process.env.NODE_ENV === 'development' ? err.stack : undefined });
});

app.listen(PORT, () => {
  console.log('');
  console.log('  ⚒️  CONTENT REELS ENGINE — Vikingos');
  console.log('  ------------------------------------------');
  console.log(`  FFmpeg:   ${ff.ffmpeg}`);
  console.log(`  FFprobe:  ${ff.ffprobe}`);
  console.log(`  Frontend: http://localhost:${PORT}`);
  console.log(`  API:      http://localhost:${PORT}/api/projects`);
  console.log('  ------------------------------------------');
  console.log('');
});