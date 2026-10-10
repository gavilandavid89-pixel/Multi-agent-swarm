const $ = id => document.getElementById(id);
const state = { accessKey: sessionStorage.getItem('swarm-access-key') || '', jobs: [], historyShown: false, pollHandle: null };
const statusNames = { queued: 'En cola', running: 'En curso', completed: 'Completado', failed: 'Error', needs_review: 'Revisión humana' };
let refreshPromise = null;
function authHeaders(json = true) { return { ...(json ? { 'content-type': 'application/json' } : {}), ...(state.accessKey ? { authorization: `Bearer ${state.accessKey}` } : {}) }; }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...authHeaders(options.body !== undefined), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { state.accessKey = ''; sessionStorage.removeItem('swarm-access-key'); showAccess(); throw new Error('Necesitás ingresar tu clave de acceso.'); }
  if (!response.ok) throw new Error(data.error || `Error HTTP ${response.status}`);
  return data;
}
function showAccess() { $('access-panel').classList.remove('hidden'); $('app-content').classList.add('hidden'); $('access-key').value = state.accessKey; }
function showApp() { $('access-panel').classList.add('hidden'); $('app-content').classList.remove('hidden'); }
function setConnection(ok, label) { $('connection-dot').classList.toggle('online', ok); $('connection-label').textContent = label; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function dateLabel(value) { if (!value) return 'sin fecha'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(); }
async function loadHistorySummary() {
  const data = await api('/api/history');
  $('history-indicator').textContent = data.hasHistory ? '▤' : '◌';
  $('history-title').textContent = data.hasHistory ? `Hay historial (${data.count})` : 'Todavía no hay historial';
  $('history-copy').textContent = data.hasHistory ? 'Los detalles se cargan únicamente cuando los abrís.' : 'Cuando completes tareas, aparecerán registros.';
  $('show-history').classList.toggle('hidden', !data.hasHistory);
}
async function loadJobs() {
  const data = await api('/api/jobs'); state.jobs = data.jobs || [];
  const list = $('jobs-list');
  if (!state.jobs.length) { list.innerHTML = '<div class="empty-state"><span class="empty-glyph">✳</span><p>Todo tranquilo por ahora.</p><span class="muted tiny">Las tareas aparecerán aquí.</span></div>'; return; }
  list.innerHTML = state.jobs.map(job => `<div class="job-row"><div class="job-main"><div class="job-name">Tarea ${escapeHtml(job.id.slice(0,8))}</div><div class="job-meta">${escapeHtml(job.stage)} · ${escapeHtml(dateLabel(job.updatedAt))} · ${Number(job.progress)||0}%</div><div class="status ${escapeHtml(job.status)}">${escapeHtml(statusNames[job.status] || job.status)}</div></div><button class="mini-button" data-detail="${escapeHtml(job.id)}">Detalle</button>${job.status === 'failed' || job.status === 'needs_review' ? `<button class="mini-button" data-retry="${escapeHtml(job.id)}">Reintentar</button>` : ''}</div>`).join('');
  list.querySelectorAll('[data-detail]').forEach(button => button.addEventListener('click', () => showDetail(button.dataset.detail)));
  list.querySelectorAll('[data-retry]').forEach(button => button.addEventListener('click', async () => { try { await api(`/api/jobs/${encodeURIComponent(button.dataset.retry)}/retry`, { method: 'POST', body: '{}' }); await refresh(); } catch (error) { alert(error.message); } }));
}
async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try { await Promise.all([loadHistorySummary(), loadJobs()]); setConnection(true, 'Puente conectado'); }
    catch (error) { setConnection(false, 'Puente no disponible'); console.warn(error.message); }
  })();
  try { await refreshPromise; } finally { refreshPromise = null; }
}
async function showDetail(id) {
  try {
    const data = await api(`/api/jobs/${encodeURIComponent(id)}/history`);
    $('detail-title').textContent = `Tarea ${id.slice(0,8)} · ${statusNames[data.job.status] || data.job.status}`;
    $('detail-content').textContent = JSON.stringify({ objective: data.objective, stage: data.job.stage, progress: data.job.progress, transcript: data.history, result: data.result, validation: data.validation, syntax: data.syntax, validationLevel: data.validationLevel, error: data.job.error, delivery: data.delivery }, null, 2);
    $('detail-panel').classList.remove('hidden'); $('detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { alert(error.message); }
}
$('access-form').addEventListener('submit', async event => { event.preventDefault(); state.accessKey = $('access-key').value.trim(); sessionStorage.setItem('swarm-access-key', state.accessKey); showApp(); await refresh(); });
$('job-form').addEventListener('submit', async event => {
  event.preventDefault(); const objective = $('objective').value.trim(); if (!objective) return;
  const button = $('submit-job'); button.disabled = true; button.textContent = 'Enviando…';
  try { const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ objective }) }); $('objective').value = ''; await refresh(); await showDetail(job.id); }
  catch (error) { alert(error.message); }
  finally { button.disabled = false; button.innerHTML = 'Iniciar comité <span>↗</span>'; }
});
$('refresh-jobs').addEventListener('click', refresh);
$('show-history').addEventListener('click', async () => {
  state.historyShown = !state.historyShown;
  $('history-list').classList.toggle('hidden', !state.historyShown);
  $('show-history').innerHTML = state.historyShown ? 'Ocultar registros <span>↑</span>' : 'Ver registros <span>→</span>';
  if (!state.historyShown) return;
  try {
    const data = await api('/api/jobs'); const list = $('history-list');
    list.innerHTML = (data.jobs || []).map(job => `<div class="history-row"><div class="job-main"><div class="job-name">${escapeHtml(statusNames[job.status] || job.status)}</div><div class="job-meta">${escapeHtml(job.stage)} · ${escapeHtml(dateLabel(job.createdAt))}</div></div><button class="mini-button" data-history="${escapeHtml(job.id)}">Abrir</button></div>`).join('') || '<p class="muted tiny">Sin registros.</p>';
    list.querySelectorAll('[data-history]').forEach(button => button.addEventListener('click', () => showDetail(button.dataset.history)));
  } catch (error) { alert(error.message); }
});
$('close-detail').addEventListener('click', () => $('detail-panel').classList.add('hidden'));
async function boot() {
  try { const health = await fetch('/healthz'); if (!health.ok) throw new Error(); setConnection(true, 'Puente disponible'); }
  catch { setConnection(false, 'Puente no disponible'); }
  if (!state.accessKey) { showAccess(); return; }
  showApp(); await refresh(); state.pollHandle = setInterval(refresh, 12000);
}
boot();