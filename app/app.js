'use strict';

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

const state = {
  slug: null,
  project: null,
  media: { videos: [], photos: [], audio: [] },
  script: {},
  step: 'material',
  renderTimer: null,
  lastLogLine: null,
};

const SECTIONS = ['Hook', 'Dolor', 'Problema', 'Proceso', 'Resultado', 'CTA'];
const PLATFORMS = { instagram: 'Instagram', tiktok: 'TikTok' };
const STYLES = { limpio: 'Limpio', dinamico: 'Dinámico', profesional: 'Profesional' };

/* ------------------------------------------------------------------ */
/* Fetch helpers                                                      */
/* ------------------------------------------------------------------ */

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  let body = null;
  const text = await res.text();
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = (body && body.error) ? body.error : `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

const get = (p) => api(p);
const postJSON = (p, data) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });

/* ------------------------------------------------------------------ */
/* Views / navigation                                                 */
/* ------------------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);

function show(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $(`#${viewId}`).classList.remove('hidden');
}

function goStep(step) {
  state.step = step;
  if (step === 'result' && !(state.project.render && state.project.render.status === 'done')) {
    step = 'generate';
  }
  document.querySelectorAll('.step-panel').forEach((p) => p.classList.add('hidden'));
  document.querySelectorAll('.step').forEach((b) => b.classList.remove('active'));
  const panel = $(`#step-${step}`);
  if (panel) panel.classList.remove('hidden');
  const btn = document.querySelector(`.step[data-step="${step}"]`);
  if (btn) btn.classList.add('active');
  if (step === 'result') renderResult();
  if (step === 'generate') renderGenerate();
  if (step === 'material') { renderClips(); renderAudio(); }
  if (step === 'script') fillScript();
  if (step === 'format') fillFormat();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function openProject(slug) {
  state.slug = slug;
  state.renderTimer && clearInterval(state.renderTimer);
  const data = await get(`/api/projects/${slug}`);
  state.project = data.project;
  state.media = data.media;
  state.script = data.script || {};
  $('#project-title').textContent = state.project.name;
  $('#project-slug').textContent = `@ ${state.project.slug}`;
  $('#project-badge').textContent = renderStatusLabel(state.project.render);
  show('view-project');
  markSteps();
  goStep('material');
}

function markSteps() {
  const p = state.project;
  const order = ['created', 'material', 'script', 'config', 'ready', 'rendering', 'rendered'];
  const idx = Math.max(order.indexOf(p.status), 0);
  document.querySelectorAll('.step').forEach((b, i) => {
    b.classList.toggle('done', i < idx);
  });
}

function renderStatusLabel(render) {
  if (!render) return '';
  const map = {
    idle: 'En preparación',
    rendering: `Renderizando ${render.progress}%`,
    cancelling: 'Cancelando…',
    cancelled: 'Render cancelado',
    done: 'Reel listo',
    error: 'Error en render',
  };
  return map[render.status] || render.status;
}

/* ------------------------------------------------------------------ */
/* Projects list                                                      */
/* ------------------------------------------------------------------ */

async function loadProjects() {
  const { projects } = await get('/api/projects');
  const grid = $('#project-list');
  grid.innerHTML = '';
  $('#empty-state').classList.toggle('hidden', projects.length > 0);

  for (const p of projects) {
    const tile = document.createElement('div');
    tile.className = 'project-tile';
    const counts = p.mediaCounts ? `${p.mediaCounts.videos} vid · ${p.mediaCounts.photos} fotos · ${p.mediaCounts.audio} audio` : '—';
    const dur = p.duration ? fmtDur(p.duration) : null;
    tile.innerHTML = `
      <div class="p-thumb-wrap">
        ${p.thumb
          ? `<img class="p-thumb" src="${escapeHtml(p.thumb)}" alt="" loading="lazy">`
          : '<span class="p-thumb-ph">⛰️</span>'}
      </div>
      <h3>${escapeHtml(p.name)}</h3>
      <div class="p-title">${escapeHtml(p.slug)}</div>
      <div class="p-stats">${counts}${dur ? ` · ${dur}` : ''}</div>
      <div class="p-foot">
        <span class="p-status">${renderStatusLabel(p.render)}</span>
        <button class="icon-btn danger" data-del="${escapeHtml(p.slug)}" title="Eliminar proyecto">🗑</button>
      </div>`;
    tile.addEventListener('click', () => openProject(p.slug));
    tile.querySelector('[data-del]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`¿Eliminar el proyecto "${p.name}" y todo su material? Esta acción no se puede deshacer.`)) return;
      try {
        await api(`/api/projects/${p.slug}`, { method: 'DELETE' });
        await loadProjects();
      } catch (err) {
        alert(err.message);
      }
    });
    grid.appendChild(tile);
  }
}

/* ------------------------------------------------------------------ */
/* Material                                                           */
/* ------------------------------------------------------------------ */

function combinedClips() {
  const items = [
    ...state.media.videos.map((m) => ({ key: `video:${m.fileName}`, fileName: m.fileName, kind: 'video', thumb: m.thumb })),
    ...state.media.photos.map((m) => ({ key: `photo:${m.fileName}`, fileName: m.fileName, kind: 'photo', thumb: m.thumb })),
  ];
  const order = Array.isArray(state.project.clipOrder) ? state.project.clipOrder : null;
  if (order && order.length === items.length) {
    const byKey = new Map(items.map((i) => [i.key, i]));
    const rebuilt = order.map((k) => byKey.get(k)).filter(Boolean);
    if (rebuilt.length === items.length) return rebuilt;
  }
  // convención por número de prefijo
  items.sort((a, b) => {
    const an = /^(\d{1,3})/.exec(a.fileName);
    const bn = /^(\d{1,3})/.exec(b.fileName);
    if (an && bn) return parseInt(an[1], 10) - parseInt(bn[1], 10);
    if (an) return -1;
    if (bn) return 1;
    return a.fileName.localeCompare(b.fileName);
  });
  return items;
}

function guessSection(fileName) {
  const m = /^(\d{1,3})[_-]/.exec(fileName);
  if (!m) return null;
  const idx = parseInt(m[1], 10) - 1;
  return idx < SECTIONS.length ? SECTIONS[idx] : 'CTA';
}

function renderClips() {
  const clips = combinedClips();
  const ul = $('#clip-list');
  ul.innerHTML = '';
  $('#clip-empty').classList.toggle('hidden', clips.length > 0);

  clips.forEach((clip, i) => {
    const li = document.createElement('li');
    const sec = guessSection(clip.fileName);
    li.innerHTML = `
      <span class="clip-thumbbox">${clip.thumb
        ? `<img class="clip-thumb" src="${escapeHtml(clip.thumb)}" alt="" loading="lazy">`
        : '<span class="clip-thumbph"></span>'}</span>
      <span class="clip-order">${i + 1}</span>
      <span class="clip-kind">${clip.kind === 'video' ? 'Video' : 'Foto'}</span>
      ${sec ? `<span class="clip-section">${sec}</span>` : ''}
      <span class="clip-name">${escapeHtml(clip.fileName)}</span>
      <button class="icon-btn" data-act="up" title="Subir">↑</button>
      <button class="icon-btn" data-act="down" title="Bajar">↓</button>
      <button class="icon-btn danger" data-act="del" title="Eliminar">✕</button>`;
    const up = li.querySelector('[data-act="up"]');
    const down = li.querySelector('[data-act="down"]');
    up.disabled = i === 0;
    down.disabled = i === clips.length - 1;
    up.addEventListener('click', () => moveClip(clip.key, -1));
    down.addEventListener('click', () => moveClip(clip.key, 1));
    li.querySelector('[data-act="del"]').addEventListener('click', () => removeMedia(clip));
    ul.appendChild(li);
  });
}

function renderAudio() {
  const ul = $('#audio-list');
  ul.innerHTML = '';
  $('#audio-empty').classList.toggle('hidden', state.media.audio.length > 0);
  for (const a of state.media.audio) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="clip-kind">Audio</span>
      <span class="clip-name">${escapeHtml(a.fileName)}</span>
      <button class="icon-btn danger" title="Eliminar">✕</button>`;
    li.querySelector('button').addEventListener('click', () => removeMedia({ key: `audio:${a.fileName}`, fileName: a.fileName, kind: 'audio' }));
    ul.appendChild(li);
  }
}

async function moveClip(key, delta) {
  const clips = combinedClips();
  const i = clips.findIndex((c) => c.key === key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= clips.length) return;
  [clips[i], clips[j]] = [clips[j], clips[i]];
  const { order } = await postJSON(`/api/projects/${state.slug}/material/order`, { order: clips.map((c) => c.key) });
  state.project.clipOrder = order;
  renderClips();
}

async function removeMedia(clip) {
  if (!confirm(`¿Eliminar "${clip.fileName}" del proyecto?`)) return;
  const enc = encodeURIComponent(clip.fileName);
  await api(`/api/projects/${state.slug}/material/${enc}`, { method: 'DELETE' });
  await refreshState();
  renderClips();
  renderAudio();
}

async function uploadFiles(files) {
  if (!files || !files.length) return;
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const box = $('#upload-progress');
  box.classList.remove('hidden');
  try {
    const res = await api(`/api/projects/${state.slug}/material`, { method: 'POST', body: form });
    await refreshState();
    renderClips();
    renderAudio();
    if (res.rejected && res.rejected.length) {
      alert(`No se subieron ${res.rejected.length} archivo(s):\n` + res.rejected.map((r) => `• ${r.fileName}: ${r.reason}`).join('\n'));
    }
  } catch (err) {
    alert(err.message);
  } finally {
    box.classList.add('hidden');
  }
}

/* ------------------------------------------------------------------ */
/* Guion                                                              */
/* ------------------------------------------------------------------ */

function fillScript() {
  const s = state.script || {};
  ['hook', 'dolor', 'problema', 'proceso', 'resultado', 'cta'].forEach((f) => {
    $(`[data-field="${f}"]`).value = s[f] || '';
  });
  $('#observaciones').value = s.observaciones || '';
  $('#target-duration').value = state.project.targetDuration || s.targetDuration || 30;
}

async function saveScript() {
  const body = {};
  ['hook', 'dolor', 'problema', 'proceso', 'resultado', 'cta'].forEach((f) => {
    body[f] = $(`[data-field="${f}"]`).value;
  });
  body.observaciones = $('#observaciones').value;
  body.targetDuration = parseInt($('#target-duration').value, 10) || 30;
  try {
    const res = await postJSON(`/api/projects/${state.slug}/script`, body);
    state.script = res.script;
    state.project = res.project;
    const flag = $('#script-saved');
    flag.classList.remove('hidden');
    setTimeout(() => flag.classList.add('hidden'), 2000);
    markSteps();
  } catch (err) {
    alert(err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Formato                                                            */
/* ------------------------------------------------------------------ */

function fillFormat() {
  const p = state.project || {};
  const radio = (name, value) => {
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  };
  radio('platform', p.platform || 'instagram');
  radio('style', p.style || 'dinamico');
  radio('format', '9:16');
  $('#target-duration').value = p.targetDuration || 30;
}

async function saveConfig() {
  const platform = document.querySelector('input[name="platform"]:checked');
  const style = document.querySelector('input[name="style"]:checked');
  const body = {
    platform: platform ? platform.value : 'instagram',
    style: style ? style.value : 'dinamico',
    format: '9:16',
    targetDuration: parseInt($('#target-duration').value, 10) || 30,
  };
  const res = await postJSON(`/api/projects/${state.slug}/config`, body);
  state.project = res.project;
  const flag = $('#config-saved');
  flag.classList.remove('hidden');
  setTimeout(() => flag.classList.add('hidden'), 2000);
  markSteps();
}

/* ------------------------------------------------------------------ */
/* Generar / poll                                                     */
/* ------------------------------------------------------------------ */

function renderGenerate() {
  const p = state.project || {};
  const clips = combinedClips();
  const summary = $('#render-summary');
  summary.innerHTML = '';
  const items = [
    { k: 'Clips', v: String(clips.length) },
    { k: 'Duración', v: `${p.targetDuration || 30}s` },
    { k: 'Plataforma', v: PLATFORMS[p.platform] || '—' },
    { k: 'Estilo', v: STYLES[p.style] || '—' },
    { k: 'Estado', v: renderStatusLabel(p.render) },
  ];
  for (const it of items) {
    const div = document.createElement('div');
    div.className = 'rs-item';
    div.innerHTML = `<div class="k">${it.k}</div><div class="v">${it.v}</div>`;
    summary.appendChild(div);
  }
  updateRenderUI(p.render);
}

function updateRenderUI(render) {
  if (!render) return;
  const progress = $('#render-progress-label');
  const fill = $('#render-progress-fill');
  const wrap = $('#render-progress-wrap');
  const errBox = $('#render-error');
  const btn = $('#btn-render');
  const cancelBtn = $('#btn-cancel');

  progress.textContent = `${render.progress || 0}%`;
  fill.style.width = `${render.progress || 0}%`;
  $('#render-message').textContent = render.message || '';

  if (render.status === 'idle') {
    wrap.classList.add('hidden');
    errBox.classList.add('hidden');
    btn.disabled = false;
    cancelBtn.classList.add('hidden');
  } else if (render.status === 'rendering') {
    wrap.classList.remove('hidden');
    errBox.classList.add('hidden');
    btn.disabled = true;
    cancelBtn.classList.remove('hidden');
    cancelBtn.disabled = false;
  } else if (render.status === 'cancelling') {
    wrap.classList.remove('hidden');
    errBox.classList.add('hidden');
    btn.disabled = true;
    cancelBtn.classList.remove('hidden');
    cancelBtn.disabled = true;
  } else if (render.status === 'cancelled') {
    wrap.classList.remove('hidden');
    errBox.classList.add('hidden');
    btn.disabled = false;
    cancelBtn.classList.add('hidden');
  } else if (render.status === 'error') {
    wrap.classList.remove('hidden');
    errBox.classList.remove('hidden');
    btn.disabled = false;
    cancelBtn.classList.add('hidden');
    $('#error-message').textContent = (render.error && (render.error.message || render.message)) || 'Error de render.';
    const tail = render.error ? render.error.stderrTail : null;
    $('#error-stderr').textContent = tail || 'Sin detalle de stderr disponible.';
    const vErrs = render.error && render.error.validationErrors;
    $('#error-validation').textContent = vErrs && vErrs.length ? 'Validación: ' + vErrs.join(' | ') : '';
  } else if (render.status === 'done') {
    wrap.classList.remove('hidden');
    errBox.classList.add('hidden');
    btn.disabled = false;
    cancelBtn.classList.add('hidden');
  } else {
    wrap.classList.add('hidden');
    errBox.classList.add('hidden');
    btn.disabled = false;
    cancelBtn.classList.add('hidden');
  }
}

async function startRender() {
  const p = state.project || {};
  const clips = combinedClips();
  const gate = $('#render-gate');

  const hasScript = ['hook', 'dolor', 'problema', 'proceso', 'resultado', 'cta'].some((f) => (state.script[f] || '').trim());
  if (!clips.length) { gate.textContent = 'Carga material primero (paso Material).'; gate.classList.remove('hidden'); return; }
  if (!hasScript) { gate.textContent = 'Completa el guion (paso Guion) antes de generar.'; gate.classList.remove('hidden'); return; }
  if (!p.style) { gate.textContent = 'Guarda formato y estilo (paso Formato).'; gate.classList.remove('hidden'); return; }
  gate.classList.add('hidden');

  $('#render-log').textContent = '';
  state.lastLogLine = null;
  try {
    await postJSON(`/api/projects/${state.slug}/render`, {});
    startPolling();
  } catch (err) {
    alert(err.message);
  }
}

async function cancelRender() {
  try {
    await postJSON(`/api/projects/${state.slug}/render/cancel`, {});
  } catch (err) {
    alert(err.message);
  }
}

function startPolling() {
  $('#render-progress-wrap').classList.remove('hidden');
  $('#render-error').classList.add('hidden');
  $('#btn-render').disabled = true;
  state.lastLogLine = null;
  pollOnce();
  state.renderTimer = setInterval(pollOnce, 1000);
}

async function pollOnce() {
  if (!state.slug) return;
  try {
    const { render } = await get(`/api/projects/${state.slug}/render/status`);
    state.project.render = render;
    updateRenderUI(render);

    const msg = render.message || '';
    if (msg !== state.lastLogLine) {
      const log = $('#render-log');
      if (msg) log.textContent += msg + '\n';
      log.scrollTop = log.scrollHeight;
      state.lastLogLine = msg;
    }

    if (render.status === 'done') {
      clearInterval(state.renderTimer);
      state.renderTimer = null;
      await refreshState();
      showResult();
    } else if (render.status === 'error' || render.status === 'cancelled') {
      clearInterval(state.renderTimer);
      state.renderTimer = null;
      await refreshState();
    }
  } catch (err) {
    // el servidor puede estar ocupado; reintenta en el siguiente tick
  }
}

async function showResult() {
  await refreshState();
  goStep('result');
}

/* ------------------------------------------------------------------ */
/* Resultado                                                          */
/* ------------------------------------------------------------------ */

function renderResult() {
  const p = state.project || {};
  const src = `/api/projects/${state.slug}/output`;
  const video = $('#result-video');
  video.src = src + `?cb=${Date.now()}`;
  video.load();

  const v = (p.render && p.render.validation) || {};
  const meta = $('#result-meta');
  const rows = [
    ['Duración', `${fmtDur(v.duration)}`],
    ['Resolución', v.width && v.height ? `${v.width} × ${v.height}` : '—'],
    ['FPS', v.fps ? `${v.fps}` : '—'],
    ['Video', v.videoCodec || '—'],
    ['Audio', v.audioCodec || (v.hasAudio ? 'AAC' : '—')],
    ['Peso', v.size ? fmtSize(v.size) : '—'],
    ['Plataforma', PLATFORMS[p.platform] || '—'],
    ['Estilo', STYLES[p.style] || '—'],
  ];
  meta.innerHTML = rows.map(([k, val]) => `<tr><td>${k}</td><td>${val}</td></tr>`).join('');
}

/* ------------------------------------------------------------------ */
/* Misc                                                               */
/* ------------------------------------------------------------------ */

function fmtDur(sec) {
  if (!sec && sec !== 0) return '—';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtSize(b) {
  if (!b) return '—';
  return b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshState() {
  const data = await get(`/api/projects/${state.slug}`);
  state.project = data.project;
  state.media = data.media;
  if (data.script) state.script = data.script;
  $('#project-badge').textContent = renderStatusLabel(state.project.render);
  markSteps();
}

/* ------------------------------------------------------------------ */
/* Wiring                                                             */
/* ------------------------------------------------------------------ */

// Proyectos
$('#btn-new-project').addEventListener('click', () => $('#new-project-form').classList.toggle('hidden'));
$('#btn-submit-project').addEventListener('click', async () => {
  const name = $('#new-name').value.trim();
  if (!name) { alert('Escribe un nombre para el proyecto.'); return; }
  try {
    const { project } = await postJSON('/api/projects', { name });
    $('#new-name').value = '';
    $('#new-project-form').classList.add('hidden');
    await openProject(project.slug);
  } catch (err) {
    alert(err.message);
  }
});
$('#new-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-submit-project').click(); });

// Navegación por pasos
document.querySelectorAll('.step').forEach((btn) => {
  btn.addEventListener('click', () => {
    const step = btn.dataset.step;
    if (step === 'result' && !(state.project && state.project.render && state.project.render.status === 'done')) {
      alert('Genera el reel primero para ver el resultado.');
      return;
    }
    goStep(step);
  });
});

// Botones "Continuar →"
document.querySelectorAll('.next').forEach((btn) => {
  btn.addEventListener('click', () => goStep(btn.dataset.step));
});

// Back
$('#btn-back').addEventListener('click', async () => {
  state.renderTimer && clearInterval(state.renderTimer);
  state.renderTimer = null;
  state.slug = null;
  await loadProjects();
  show('view-projects');
});

// Dropzone / upload
const dz = $('#dropzone');
const fileInput = $('#file-input');
$('#browse-link').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
dz.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { uploadFiles(fileInput.files); fileInput.value = ''; });
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
dz.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

// Guion
$('#btn-save-script').addEventListener('click', saveScript);

// Formato
$('#btn-save-config').addEventListener('click', saveConfig);

// Generar
$('#btn-render').addEventListener('click', startRender);
$('#btn-cancel').addEventListener('click', cancelRender);

// Resultado
$('#btn-edit').addEventListener('click', () => { fillScript(); goStep('script'); });
$('#btn-regen').addEventListener('click', () => goStep('generate'));
$('#btn-finish').addEventListener('click', () => $('#btn-back').click());

// Arranque
loadProjects().catch(console.error);