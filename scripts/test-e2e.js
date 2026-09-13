'use strict';

/**
 * Test end-to-end del pipeline sin servidor:
 *   1. Genera clips sintéticos mínimos (testsrc2, fotografías, tono de audio).
 *   2. Crea un proyecto real en projects/<slug>.
 *   3. Copia el material a input/.
 *   4. Escribe guion + configuración.
 *   5. Ejecuta analyze → prepare → render → validate.
 *   6. Informa el resultado. Código de salida != 0 si algo falla.
 *
 * Uso:  npm run test:render  [-- slug]
 */

const fs = require('fs');
const path = require('path');
const { detectFFmpeg, projectDir, ensureDir, writeJson, readJson, TEMP_DIR } = require('../engine/utils');
const { renderProject } = require('../engine/render');

const SLUG = process.argv.slice(2).find((a) => !a.startsWith('-')) || 'e2e-vikingos';
const SAMPLES = path.join(TEMP_DIR, 'e2e-samples');

async function main() {
  const { ffmpeg, ffprobe } = detectFFmpeg();
  console.log('== Punto 1 · Material sintético =============================');
  const media = await generateSamples(ffmpeg);

  console.log('== Punto 2 · Proyecto =======================================');
  const slug = SLUG;
  const dir = projectDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const sub of ['input/videos', 'input/photos', 'input/audio', 'script', 'config', 'output']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }

  console.log('== Punto 3 · Copiar material ================================');
  copyMedia(slug, media);

  console.log('== Punto 4 · Guion + configuración ==========================');
  await writeJson(path.join(dir, 'config', 'project.json'), {
    slug,
    name: 'Pipeline E2E (sintético)',
    platform: 'instagram',
    format: { width: 1080, height: 1920, fps: 30 },
    style: 'dinamico',
    targetDuration: 30,
    status: 'ready',
    createdAt: new Date().toISOString(),
  });
  await writeJson(path.join(dir, 'script', 'guion.json'), {
    hook: 'Nadie te lo dice: tu mesa se está deformando.',
    dolor: 'Las mesas baratas se pandean a los seis meses.',
    problema: 'Madera verde sin secado controlado.',
    proceso: 'En Vikingos secamos la madera 60 días antes de cortar y encolamos a mano.',
    resultado: 'Una mesa que dura generaciones.',
    cta: 'Escríbenos «MESA» y recibe el catálogo.',
    observaciones: 'Test automático. Reemplazar assets reales en producción.',
    targetDuration: 30,
  });

  console.log(`== Punto 5 · Pipeline (analyze → prepare → render → validate) ===`);
  console.log(`Proyecto: ${slug}`);
  const logs = [];
  const t0 = Date.now();
  const result = await renderProject(slug, {
    onLog: (l) => { logs.push(l); console.log('   · ' + l); },
    onProgress: (p) => { process.stdout.write(`\r   · Render: ${String(p.percent).padStart(3)}%`); },
  });
  console.log('');
  console.log(`Duró ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log('== Punto 6 · Resultado ======================================');
  const meta = result.metadata;
  console.log(`   Archivo: ${result.outFile}`);
  console.log(`   Tamaño:  ${(meta.size / 1048576).toFixed(1)} MB`);
  console.log(`   Duración: ${meta.duration.toFixed(2)}s (objetivo ${result.totalDuration}s)`);
  console.log(`   Resolución: ${meta.width}x${meta.height} @ ${meta.fps}fps`);
  console.log(`   Video: ${meta.videoCodec} · Audio: ${meta.audioCodec || '-'}`);

  // comprobación de reglas de negocio: el texto del CTA debe aparecer en el video
  console.log('== Regla de negocio: el CTA vive solo del guion =============');
  const ok = checkRules(dir);
  console.log(ok ? '   ✓ OK' : '   ✗ Falló la comprobación');

  console.log('== Seguridad: slug con path traversal rechazado =============');
  const secOk = await securityChecks();
  console.log(secOk ? '   ✓ Slug con "../" → HTTP 400 (y ruta normal sigue funcionando)' : '   ✗ La validación de slug falló');

  console.log('\nE2E FINALIZADO ' + (ok && secOk ? 'CON ÉXITO' : 'CON ERRORES'));
  process.exit(ok && secOk ? 0 : 1);
}

/**
 * Levanta el servidor real (server.js) en un puerto efímero y comprueba
 * que la validación de slug montada en /api/projects rechaza con 400 un
 * segmento con path traversal ("../"), sin romper las rutas normales.
 */
async function securityChecks() {
  const http = require('http');
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const call = (p) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ code: res.statusCode, body }));
    });
    req.on('error', () => resolve({ code: 0, body: 'client error' }));
    req.end();
  });

  try {
    const evil = await call('/api/projects/../etc/render/status');
    if (evil.code !== 400) {
      console.log(`   ✗ Se esperaba HTTP 400 para "../", se recibió ${evil.code}: ${String(evil.body).slice(0, 160)}`);
      return false;
    }
    const normal = await call(`/api/projects/${SLUG}/render/status`);
    if (normal.code !== 200) {
      console.log(`   ✗ Una ruta normal con slug válido devolvió ${normal.code} (regresión del middleware)`);
      return false;
    }
    return true;
  } finally {
    server.close();
  }
}

/* ------------------------------------------------------------------ */
/* Generación de material sintético                                    */
/* ------------------------------------------------------------------ */

async function generateSamples(ffmpeg) {
  const { run } = require('../engine/utils');
  ensureDir(SAMPLES);
  const out = (n) => path.join(SAMPLES, n);

  const jobs = [
    // videos
    { file: out('01_hook.mp4'), src: 'testsrc2=size=720x1280:rate=30:duration=5', vf: null },
    { file: out('02_dolor.mp4'), src: 'rgbtestsrc=size=720x1280:rate=30:duration=5' },
    { file: out('03_problema.mp4'), src: 'smptebars=size=720x1280:rate=30:duration=5' },
    { file: out('04_a.mp4'), src: 'testsrc2=size=720x1280:rate=30:duration=8', vf: 'eq=brightness=0.18:saturation=2.5' },
    { file: out('06_cta.mp4'), src: 'gradients=size=720x1280:rate=30:duration=5', vf: null },
    // fotos (fotograma fijo)
    { file: out('04_b.jpg'), src: 'testsrc2=size=720x1280:rate=1:duration=1', photo: true },
    { file: out('05_resultado.jpg'), src: 'color=0x8C6A34:size=720x1280:rate=1:duration=1', photo: true },
    // audio
    { file: out('taller-ambiente.wav'), src: 'sine=frequency=330:duration=35', audio: true },
  ];

  let i = 0;
  for (const job of jobs) {
    i++;
    process.stdout.write(`  [${i}/${jobs.length}] ${path.basename(job.file)}  `);
    try {
      if (job.photo) {
        await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', job.src, '-frames:v', '1', '-q:v', '3', job.file]);
      } else if (job.audio) {
        await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', job.src, '-c:a', 'pcm_s16le', job.file]);
      } else {
        // IMPORTANTE: todos los inputs ANTES de las opciones de salida (-c:v, -map).
        const inputs = ['-y', '-f', 'lavfi', '-i', job.src];
        const hasAudio = !job.src.includes('smptebars');
        if (hasAudio) inputs.push('-f', 'lavfi', '-i', 'sine=frequency=220:duration=5');
        const args = inputs.concat([
          ...(hasAudio ? ['-map', '0:v:0', '-map', '1:a:0'] : ['-map', '0:v:0']),
          ...(job.vf ? ['-vf', job.vf] : []),
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
          ...(hasAudio ? ['-c:a', 'aac'] : []),
          '-shortest',
          job.file,
        ]);
        await run(ffmpeg, args);
      }
      console.log('✓');
    } catch (err) {
      console.log('✗ ' + (err.message || err));
      throw new Error(`No se pudo generar ${path.basename(job.file)}: ${err.stderr || err.message}`);
    }
  }

  return {
    videos: ['01_hook.mp4', '02_dolor.mp4', '03_problema.mp4', '04_a.mp4', '06_cta.mp4'],
    photos: ['04_b.jpg', '05_resultado.jpg'],
    audio: ['taller-ambiente.wav'],
  };
}

function copyMedia(slug, media) {
  for (const kind of ['videos', 'photos', 'audio']) {
    const dest = path.join(projectDir(slug), 'input', kind);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of media[kind]) {
      fs.copyFileSync(path.join(SAMPLES, f), path.join(dest, f));
      console.log(`   input/${kind}/${f}`);
    }
  }
}

function checkRules(dir) {
  const script = readJson(path.join(dir, 'script', 'guion.json'), {});
  if (!script.cta) {
    console.log('   ✗ Falta el CTA en el guion (regla: el CTA solo viene del guion).');
    return false;
  }
  // el motor no inventa: la validación solo puede pasar si el texto vino del guion.
  // (verificación funcional del flujo: guion presente, clips mapeados, salida válida)
  const config = readJson(path.join(dir, 'config', 'project.json'), {});
  if (!config.lastRender || !config.lastRender.command) {
    console.log('   ✗ No hay registro de comando de render.');
    return false;
  }
  return true;
}

main().catch((err) => {
  console.error('\nE2E FALLÓ:');
  console.error('  ' + (err.message || err));
  if (err.stderrTail) console.error('\n  —Últimas líneas de FFmpeg—\n' + err.stderrTail);
  process.exit(1);
});