const $ = id => document.getElementById(id);
const state = { accessKey: sessionStorage.getItem('swarm-access-key') || '', jobs: [], historyShown: false, pollHandle: null, currentDetailId: null, lastDetailSignature: '' };
const statusNames = { queued: 'En cola', running: 'En curso', completed: 'Completado', failed: 'Error', needs_review: 'Revisión humana' };
const agentIcons = { Arquitecto: '⌂', Escéptico: '◈', Árbitro: '⚖', Desarrollador: '⌘', Validador: '✓', 'Validador determinista': '⌁', sistema: '✳' };
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
function agentClass(agent) { return String(agent || 'sistema').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sistema'; }
function renderHistory(data) {
  $('history-indicator').textContent = data.hasHistory ? '▤' : '◌';
  $('history-title').textContent = data.hasHistory ? `Hay historial (${data.count})` : 'Todavía no hay historial';
  $('history-copy').textContent = data.hasHistory ? 'Los detalles se cargan cuando abrís una tarea.' : 'Cuando completes tareas, aparecerán registros.';
  $('show-history').classList.toggle('hidden', !data.hasHistory);
}
async function loadHistorySummary() { renderHistory(await api('/api/history')); }
async function loadJobs() {
  const data = await api('/api/jobs'); state.jobs = data.jobs || [];
  const list = $('jobs-list');
  if (!state.jobs.length) { list.innerHTML = '<div class="empty-state"><span class="empty-glyph">✳</span><p>Todo tranquilo por ahora.</p><span class="muted tiny">Las tareas aparecerán aquí.</span></div>'; return; }
  list.innerHTML = state.jobs.map(job => `<div class="job-row ${job.id === state.currentDetailId ? 'selected' : ''}"><div class="job-main"><div class="job-name">Tarea ${escapeHtml(job.id.slice(0,8))}</div><div class="job-meta">${escapeHtml(job.stage)} · ${escapeHtml(dateLabel(job.updatedAt))}</div><div class="status ${escapeHtml(job.status)}">${escapeHtml(statusNames[job.status] || job.status)}</div></div><button class="mini-button" data-detail="${escapeHtml(job.id)}">Ver comité</button>${job.status === 'failed' || job.status === 'needs_review' ? `<button class="mini-button" data-retry="${escapeHtml(job.id)}">Reintentar</button>` : ''}</div>`).join('');
  list.querySelectorAll('[data-detail]').forEach(button => button.addEventListener('click', () => showDetail(button.dataset.detail)));
  list.querySelectorAll('[data-retry]').forEach(button => button.addEventListener('click', async () => { try { await api(`/api/jobs/${encodeURIComponent(button.dataset.retry)}/retry`, { method: 'POST', body: '{}' }); await showDetail(button.dataset.retry); await refresh(); } catch (error) { alert(error.message); } }));
}
function renderConversation(data) {
  const conversation = $('conversation');
  const entries = Array.isArray(data.history) ? data.history : [];
  const wasNearBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 100;
  if (!entries.length) {
    conversation.innerHTML = '<div class="empty-state"><span class="empty-glyph">✳</span><p>El comité está preparando la primera intervención…</p></div>';
  } else {
    conversation.innerHTML = entries.map(entry => {
      const agent = String(entry.agent || 'sistema');
      const type = String(entry.type || 'message');
      const isSystem = ['sistema', 'Validador determinista'].includes(agent) || ['retry','error','check'].includes(type);
      const label = type === 'thinking' ? 'TRABAJANDO' : type === 'activity' ? 'ACTIVIDAD' : type === 'retry' ? 'REINTENTO' : type === 'error' ? 'ERROR' : type === 'check' ? 'COMPROBACIÓN' : 'MENSAJE';
      const icon = agentIcons[agent] || (isSystem ? '✳' : '◈');
      return `<article class="chat-message ${isSystem ? 'system-message' : 'agent-' + agentClass(agent)} ${type === 'thinking' ? 'thinking-message' : ''}"><div class="agent-avatar">${escapeHtml(icon)}</div><div class="message-body"><div class="message-heading"><strong>${escapeHtml(agent)}</strong><span>${label}</span><time>${escapeHtml(entry.at ? new Date(entry.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '')}</time></div><div class="message-text">${escapeHtml(entry.content || '')}</div></div></article>`;
    }).join('');
  }
  if (wasNearBottom) conversation.scrollTop = conversation.scrollHeight;
}
function updateDetailView(data) {
  const job = data.job || {};
  $('detail-title').textContent = `Comité · ${job.id ? job.id.slice(0,8) : ''}`;
  $('detail-stage').textContent = job.stage || 'Preparando tarea…';
  $('detail-status').textContent = statusNames[job.status] || job.status || 'Sin estado';
  $('detail-status').className = `status ${job.status || 'queued'}`;
  $('detail-live').textContent = ['queued','running'].includes(job.status) ? '● EN DIRECTO' : '● ACTUALIZADO';
  $('detail-live').classList.toggle('live-active', ['queued','running'].includes(job.status));
  const fill = $('detail-progress-fill');
  const track = $('detail-progress');
  track.classList.toggle('indeterminate', ['queued','running'].includes(job.status));
  fill.style.width = job.status === 'completed' ? '100%' : job.status === 'failed' ? '100%' : job.status === 'needs_review' ? '99%' : '100%';
  track.classList.toggle('progress-failed', job.status === 'failed');
  $('detail-progress-label').textContent = job.status === 'completed' ? 'Proceso finalizado' : job.status === 'failed' ? 'La tarea se interrumpió' : job.status === 'needs_review' ? 'Revisión humana necesaria' : job.status === 'queued' ? 'En espera de un agente' : 'Etapa activa · progreso por hitos';
  $('detail-hint').textContent = job.status === 'failed' ? (job.error || 'La tarea falló. Abrí el diagnóstico técnico para ver la causa.') : ['queued','running'].includes(job.status) ? 'Sincronización automática cada pocos segundos. La animación indica actividad; el sistema no inventa porcentajes durante la espera del proveedor.' : 'Conversación guardada. Podés revisar los mensajes y el diagnóstico técnico.';
  renderConversation(data);
  const diagnostic = { objective: data.objective, stage: job.stage, status: job.status, progress: job.progress, transcript: data.history, result: data.result, validation: data.validation, syntax: data.syntax, validationLevel: data.validationLevel, error: job.error, delivery: data.delivery };
  $('detail-content').textContent = JSON.stringify(diagnostic, null, 2);
  state.lastDetailSignature = JSON.stringify({ id: job.id, status: job.status, stage: job.stage, updatedAt: job.updatedAt, historyLength: (data.history || []).length });
}
async function updateSelectedDetail() {
  if (!state.currentDetailId) return;
  const data = await api(`/api/jobs/${encodeURIComponent(state.currentDetailId)}/history`);
  updateDetailView(data);
}
async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      await Promise.all([loadHistorySummary(), loadJobs()]);
      if (state.currentDetailId) await updateSelectedDetail();
      setConnection(true, 'Puente conectado · sincronizado');
    } catch (error) { setConnection(false, 'Reconectando…'); console.warn(error.message); }
  })();
  try { await refreshPromise; } finally { refreshPromise = null; }
}
async function showDetail(id) {
  state.currentDetailId = id;
  $('detail-panel').classList.remove('hidden');
  $('detail-title').textContent = `Comité · ${id.slice(0,8)}`;
  $('detail-stage').textContent = 'Conectando con la tarea…';
  $('conversation').innerHTML = '<div class="empty-state"><span class="empty-glyph">✳</span><p>Recuperando mensajes de los agentes…</p></div>';
  $('detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try { await updateSelectedDetail(); await loadJobs(); }
  catch (error) { $('detail-stage').textContent = 'No se pudo actualizar la tarea'; $('detail-hint').textContent = error.message; }
}
$('access-form').addEventListener('submit', async event => { event.preventDefault(); state.accessKey = $('access-key').value.trim(); sessionStorage.setItem('swarm-access-key', state.accessKey); showApp(); await refresh(); state.pollHandle = setInterval(refresh, 3500); });
$('job-form').addEventListener('submit', async event => {
  event.preventDefault(); const objective = $('objective').value.trim(); if (!objective) return;
  const button = $('submit-job'); button.disabled = true; button.textContent = 'Enviando…';
  try { const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ objective }) }); $('objective').value = ''; await showDetail(job.id); await refresh(); }
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
    list.innerHTML = (data.jobs || []).map(job => `<div class="history-row"><div class="job-main"><div class="job-name">${escapeHtml(statusNames[job.status] || job.status)}</div><div class="job-meta">${escapeHtml(job.stage)} · ${escapeHtml(dateLabel(job.createdAt))}</div></div><button class="mini-button" data-history="${escapeHtml(job.id)}">Abrir comité</button></div>`).join('') || '<p class="muted tiny">Sin registros.</p>';
    list.querySelectorAll('[data-history]').forEach(button => button.addEventListener('click', () => showDetail(button.dataset.history)));
  } catch (error) { alert(error.message); }
});
$('copy-detail').addEventListener('click', async () => {
  const button = $('copy-detail'); const content = $('detail-content').textContent || '';
  if (!content.trim()) { $('copy-status').textContent = 'No hay diagnóstico para copiar.'; return; }
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(content);
    else { const area = document.createElement('textarea'); area.value = content; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0'; document.body.appendChild(area); area.select(); const copied = document.execCommand('copy'); area.remove(); if (!copied) throw new Error('El navegador no permitió copiar.'); }
    $('copy-status').textContent = 'Diagnóstico copiado. No incluye claves secretas.'; button.textContent = 'Copiado ✓';
  } catch { $('copy-status').textContent = 'No se pudo copiar automáticamente. Mantené pulsado el texto del diagnóstico para seleccionarlo.'; }
});
$('close-detail').addEventListener('click', () => { $('detail-panel').classList.add('hidden'); state.currentDetailId = null; });
async function boot() {
  try { const health = await fetch('/healthz'); if (!health.ok) throw new Error(); setConnection(true, 'Puente disponible'); }
  catch { setConnection(false, 'Puente no disponible'); }
  if (!state.accessKey) { showAccess(); return; }
  showApp(); await refresh(); state.pollHandle = setInterval(refresh, 3500);
}
boot();