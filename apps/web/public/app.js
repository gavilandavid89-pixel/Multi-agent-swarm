const $ = id => document.getElementById(id);
const state = { accessKey: sessionStorage.getItem('swarm-access-key') || '', jobs: [], jobsTotal: 0, jobsFilter: 'all', historyShown: false, pollHandle: null, listPollHandle: null, currentDetailId: null, lastDetailSignature: '', uploadedZipPreview: null };
const statusNames = { queued: 'En cola', running: 'En curso', completed: 'Completado', failed: 'Error', needs_review: 'Revisión humana' };
const agentIcons = { Arquitecto: '⌂', Escéptico: '◈', Árbitro: '⚖', 'Coordinador de coherencia': '⌘', Desarrollador: '⌘', Validador: '✓', 'Validador determinista': '⌁', sistema: '✳' };
let refreshPromise = null;
function authHeaders(json = true) { return { ...(json ? { 'content-type': 'application/json' } : {}), ...(state.accessKey ? { authorization: `Bearer ${state.accessKey}` } : {}) }; }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...authHeaders(options.body !== undefined), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { state.accessKey = ''; sessionStorage.removeItem('swarm-access-key'); showAccess(); throw new Error(data.error || 'La clave de acceso no es válida.'); }
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
  const jobs = state.jobs || [];
  const active = jobs.filter(job => ['queued','running'].includes(job.status));
  const latest = jobs[0];
  $('history-indicator').textContent = active.length ? '◌' : data.hasHistory ? '▤' : '◌';
  $('history-title').textContent = active.length ? `${active.length} tarea${active.length === 1 ? '' : 's'} en marcha` : data.hasHistory ? `${data.count} tarea${data.count === 1 ? '' : 's'} guardada${data.count === 1 ? '' : 's'}` : 'Todavía no hay historial';
  $('history-copy').textContent = active.length ? `${latest && ['queued','running'].includes(latest.status) ? latest.stage : 'El comité sigue trabajando'} · los hitos se guardan al terminar cada etapa.` : data.hasHistory ? (latest ? `Última: ${statusNames[latest.status] || latest.status} · ${latest.stage || 'sin etapa'}` : 'Abrí una tarea para ver su conversación.') : 'Las tareas y sus conversaciones aparecerán aquí.';
  $('show-history').classList.toggle('hidden', !data.hasHistory);
}
async function loadHistorySummary() { renderHistory(await api('/api/history')); }
async function loadJobs({ append = false } = {}) {
  const pageSize = 25;
  const filter = state.jobsFilter === 'all' ? '' : `&status=${encodeURIComponent(state.jobsFilter)}`;
  let incoming = [];
  let total = 0;
  if (append) {
    const offset = state.jobs.length;
    const data = await api(`/api/jobs?limit=${pageSize}&offset=${offset}${filter}`);
    incoming = data.jobs || []; total = data.total || 0;
    state.jobs = [...state.jobs, ...incoming];
  } else {
    const offsets = [];
    const desired = Math.max(pageSize, state.jobs.length);
    for (let offset = 0; offset < desired; offset += pageSize) offsets.push(offset);
    if (!offsets.length) offsets.push(0);
    const pages = await Promise.all(offsets.map(offset => api(`/api/jobs?limit=${pageSize}&offset=${offset}${filter}`)));
    state.jobs = pages.flatMap(page => page.jobs || []);
    total = pages[0]?.total || 0;
  }
  state.jobsTotal = total || state.jobs.length;
  const list = $('jobs-list');
  if (!state.jobs.length) {
    list.innerHTML = '<div class="empty-state"><span class="empty-glyph">✳</span><p>No hay tareas en esta categoría.</p><span class="muted tiny">Probá otro filtro o creá una tarea.</span></div>';
  } else {
    list.innerHTML = state.jobs.map(job => `<div class="job-row ${job.id === state.currentDetailId ? 'selected' : ''}"><div class="job-main"><div class="job-name">Tarea ${escapeHtml(job.id.slice(0,8))}</div><div class="job-meta">${escapeHtml(job.stage)} · ${escapeHtml(dateLabel(job.updatedAt))}</div><div class="status ${escapeHtml(job.status)}">${escapeHtml(statusNames[job.status] || job.status)}</div></div><button class="mini-button" data-detail="${escapeHtml(job.id)}">Ver comité</button>${job.status === 'failed' || job.status === 'needs_review' ? `<button class="mini-button" data-retry="${escapeHtml(job.id)}">Reintentar</button>` : ''}</div>`).join('');
  }
  $('jobs-count').textContent = `${state.jobs.length} de ${state.jobsTotal} tareas`;
  $('load-more-jobs').classList.toggle('hidden', state.jobs.length >= state.jobsTotal);
  list.querySelectorAll('[data-detail]').forEach(button => button.addEventListener('click', () => showDetail(button.dataset.detail)));
  list.querySelectorAll('[data-retry]').forEach(button => button.addEventListener('click', async () => { try { await api(`/api/jobs/${encodeURIComponent(button.dataset.retry)}/retry`, { method: 'POST', body: '{}' }); await showDetail(button.dataset.retry); await refresh(); await loadJobs(); } catch (error) { alert(error.message); } }));
}
function renderConversation(data) {
  const conversation = $('conversation');
  const entries = Array.isArray(data.history) ? data.history : [];
  const nearBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 100;
  const existing = new Map([...conversation.querySelectorAll('[data-message-key]')].map(node => [node.dataset.messageKey, node]));
  if (!entries.length) {
    if (!conversation.querySelector('.empty-state')) conversation.innerHTML = '<div class="empty-state"><span class="empty-glyph">✳</span><p>El comité está preparando la primera intervención…</p></div>';
    return;
  }
  conversation.querySelector('.empty-state')?.remove();
  entries.forEach((entry, index) => {
    const agent = String(entry.agent || 'sistema');
    const type = String(entry.type || 'message');
    const key = String(entry.at || '') + '|' + agent + '|' + index;
    let node = existing.get(key);
    const isSystem = ['sistema', 'Validador determinista'].includes(agent) || ['retry','error','check'].includes(type);
    const label = type === 'thinking' ? 'TRABAJANDO' : type === 'activity' ? 'ACTIVIDAD' : type === 'retry' ? 'REINTENTO' : type === 'error' ? 'ERROR' : type === 'check' ? 'COMPROBACIÓN' : type === 'usage' ? 'TOKENS' : type === 'budget' ? 'PRESUPUESTO' : 'MENSAJE';
    const icon = agentIcons[agent] || (isSystem ? '✳' : '◈');
    if (!node) {
      node = document.createElement('article');
      node.dataset.messageKey = key;
      node.className = 'chat-message';
      node.innerHTML = '<div class="agent-avatar"></div><div class="message-body"><div class="message-heading"><strong></strong><span></span><time></time></div><div class="message-text"></div></div>';
      conversation.appendChild(node);
    }
    node.className = `chat-message ${isSystem ? 'system-message' : 'agent-' + agentClass(agent)} ${type === 'thinking' ? 'thinking-message' : ''}`;
    node.querySelector('.agent-avatar').textContent = icon;
    node.querySelector('.message-heading strong').textContent = agent;
    node.querySelector('.message-heading span').textContent = label;
    node.querySelector('.message-heading time').textContent = entry.at ? new Date(entry.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '';
    node.querySelector('.message-text').textContent = entry.content || '';
  });
  // Prune messages that fell out of the bounded server transcript without replacing the conversation container.
  const keys = new Set(entries.map((entry,index) => String(entry.at || '') + '|' + String(entry.agent || 'sistema') + '|' + index));
  [...conversation.querySelectorAll('[data-message-key]')].forEach(node => { if (!keys.has(node.dataset.messageKey)) node.remove(); });
  if (nearBottom) conversation.scrollTop = conversation.scrollHeight;
}
function saveDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}
async function responseError(response) {
  const data = await response.json().catch(() => ({}));
  return data.error || `Error HTTP ${response.status}`;
}
function renderArtifacts(files, jobId, jobStatus, validation, syntax) {
  const panel = $('artifacts-panel'); const list = $('artifacts-list');
  const items = Array.isArray(files) ? files : [];
  panel.classList.toggle('hidden', items.length === 0);
  $('artifacts-count').textContent = `${items.length} archivo${items.length === 1 ? '' : 's'}`;
  const bundleReady = jobStatus === 'completed' && validation?.verdict !== 'NEEDS_CHANGES' && syntax?.ok !== false;
  $('artifacts-kicker').textContent = bundleReady ? 'ENTREGA VALIDADA' : jobStatus === 'needs_review' ? 'ARCHIVOS · REQUIEREN CORRECCIÓN' : 'ARCHIVOS GENERADOS · EN PROCESO';
  $('download-bundle').disabled = items.length === 0 || !bundleReady;
  $('download-bundle').textContent = bundleReady ? 'Descargar proyecto completo (.zip) ↓' : jobStatus === 'needs_review' ? 'ZIP bloqueado · falta corregir' : 'ZIP disponible al completar la validación';
  list.innerHTML = items.map(file => {
    const ext = String(file.path || '').split('.').pop().toLowerCase();
    const kind = ext === 'html' ? 'HTML · vista previa disponible' : ext === 'apk' ? 'APK · requiere ser un binario Android válido' : ext === 'zip' ? 'ZIP · archivo proporcionado por la tarea' : 'Archivo del proyecto';
    const preview = ext === 'html' ? `<button class="mini-button" data-preview-index="${Number(file.index)}" type="button">Vista previa ▶</button>` : '';
    return `<div class="artifact-row"><div class="artifact-info"><span class="artifact-icon">▤</span><div><strong>${escapeHtml(file.path)}</strong><span class="muted tiny">${(Number(file.size || 0) / 1024).toFixed(1)} KB</span><span class="artifact-kind">${kind}</span></div></div><div class="artifact-actions">${preview}<button class="mini-button" data-artifact-index="${Number(file.index)}" type="button">Descargar archivo</button></div></div>`;
  }).join('');
  list.querySelectorAll('[data-artifact-index]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true; const original = button.textContent; button.textContent = 'Preparando…';
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(button.dataset.artifactIndex)}`, { headers: authHeaders(false) });
      if (!response.ok) throw new Error(await responseError(response));
      const blob = await response.blob();
      saveDownload(blob, String(items[Number(button.dataset.artifactIndex)]?.path || 'archivo.txt').split('/').pop() || 'archivo.txt');
    } catch (error) { alert(`No se pudo descargar el archivo: ${error.message}`); }
    finally { button.disabled = false; button.textContent = original; }
  }));
  list.querySelectorAll('[data-preview-index]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true; const original = button.textContent; button.textContent = 'Preparando vista previa…';
    const preview = $('artifact-preview');
    try {
      const result = await api(`/api/jobs/${encodeURIComponent(jobId)}/preview-session`, { method: 'POST', body: JSON.stringify({ index: Number(button.dataset.previewIndex) }) });
      const item = items.find(file => Number(file.index) === Number(button.dataset.previewIndex));
      $('artifact-preview-title').textContent = item?.path || 'Vista previa HTML';
      $('artifact-preview-status').textContent = 'Vista aislada: las conexiones de red, formularios y acceso a la sesión principal están bloqueados. La vista previa caduca en 10 minutos.';
      $('artifact-preview-frame').src = result.url;
      preview.classList.remove('hidden');
      preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      $('artifact-preview-status').textContent = `No se pudo abrir la vista previa: ${error.message}`;
      preview.classList.remove('hidden');
    } finally { button.disabled = false; button.textContent = original; }
  }));
}
$('download-bundle').addEventListener('click', async () => {
  const jobId = state.currentDetailId;
  if (!jobId) return;
  const button = $('download-bundle'); const original = button.textContent;
  button.disabled = true; button.textContent = 'Empaquetando todos los archivos…';
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/bundle`, { headers: authHeaders(false) });
    if (!response.ok) throw new Error(await responseError(response));
    const blob = await response.blob();
    saveDownload(blob, `swarm-${jobId.slice(0, 8)}.zip`);
    button.textContent = 'ZIP descargado ✓';
    window.setTimeout(() => { button.textContent = original; }, 1800);
  } catch (error) {
    alert(`No se pudo crear el paquete ZIP: ${error.message}`);
    button.textContent = original;
  } finally { button.disabled = false; }
});
$('close-artifact-preview').addEventListener('click', () => {
  $('artifact-preview-frame').src = 'about:blank';
  $('artifact-preview').classList.add('hidden');
});
function closeUploadedZipPreview() {
  $('zip-preview-frame').src = 'about:blank';
  $('zip-preview-result').classList.add('hidden');
  state.uploadedZipPreview = null;
}
$('zip-preview-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('zip-preview-file');
  const file = input.files?.[0];
  if (!file) { $('zip-preview-status').textContent = 'Elegí un archivo ZIP primero.'; return; }
  if (file.size > 32 * 1024 * 1024) { $('zip-preview-status').textContent = 'El ZIP supera el límite de 32 MB.'; return; }
  const button = $('zip-preview-submit');
  button.disabled = true; button.textContent = 'Analizando ZIP…';
  $('zip-preview-status').textContent = 'Comprobando rutas, tamaños, código web y recursos compatibles…';
  closeUploadedZipPreview();
  try {
    const response = await fetch('/api/preview-zip', {
      method: 'POST',
      headers: { authorization: `Bearer ${state.accessKey}`, 'content-type': 'application/zip' },
      body: file
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Error HTTP ${response.status}`);
    if (!Array.isArray(result.pages) || !result.pages.length || !result.url) throw new Error('El ZIP no devolvió páginas HTML para previsualizar.');
    const token = result.url.split('/')[2];
    if (!token) throw new Error('La sesión de vista previa no es válida.');
    state.uploadedZipPreview = { token, pages: result.pages };
    const select = $('zip-preview-page');
    select.innerHTML = result.pages.map(page => `<option value="${Number(page.index)}">${escapeHtml(page.path)}</option>`).join('');
    select.value = String(result.pages[0].index);
    $('zip-preview-frame').src = result.url;
    $('zip-preview-details').textContent = `${result.filesCount} recurso(s) compatibles · ${(result.expandedBytes / 1024).toFixed(1)} KB descomprimidos. La sesión caduca en 10 minutos; los ejecutables e instaladores no se ejecutan.`;
    $('zip-preview-result').classList.remove('hidden');
    $('zip-preview-status').textContent = `ZIP analizado: ${result.pages.length} página(s) HTML disponibles. Se abrió ${result.pages[0].path} en el laboratorio aislado.`;
    $('zip-preview-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    $('zip-preview-status').textContent = `No se pudo abrir el ZIP: ${error.message}`;
  } finally {
    button.disabled = false; button.textContent = 'Analizar y abrir vista previa ↗';
  }
});
$('zip-preview-page').addEventListener('change', () => {
  const preview = state.uploadedZipPreview;
  if (!preview) return;
  const page = preview.pages.find(item => Number(item.index) === Number($('zip-preview-page').value));
  if (page) $('zip-preview-frame').src = `/preview/${preview.token}/${page.index}`;
});
$('close-zip-preview').addEventListener('click', closeUploadedZipPreview);

function renderTokenBudget(data) {
  const usage = data.tokenUsage || {};
  const total = Math.max(1, Number(data.tokenBudget) || 50000);
  const used = Math.max(0, Number(data.tokensUsed ?? usage.totalTokens) || 0);
  const remaining = Math.max(0, Number(data.tokensRemaining ?? (total - used)) || 0);
  const prompt = Math.max(0, Number(usage.promptTokens) || 0);
  const completion = Math.max(0, Number(usage.completionTokens) || 0);
  const calls = Math.max(0, Number(usage.calls) || 0);
  const pct = Math.min(100, used / total * 100);
  const fmt = value => Math.round(value).toLocaleString('es-AR');
  $('tokens-remaining').textContent = fmt(remaining);
  $('tokens-total-label').textContent = 'de ' + fmt(total);
  $('tokens-used').textContent = fmt(used);
  $('tokens-input').textContent = fmt(prompt);
  $('tokens-output').textContent = fmt(completion);
  $('tokens-calls').textContent = fmt(calls);
  $('token-budget-fill').style.width = pct + '%';
  $('token-budget-track').setAttribute('aria-valuemax', String(total));
  $('token-budget-track').setAttribute('aria-valuenow', String(Math.min(total, used)));
  $('token-budget-track').classList.toggle('token-budget-low', remaining <= total * 0.15);
  $('token-budget-note').textContent = remaining === 0
    ? 'Presupuesto agotado; la tarea debe pausarse hasta ampliar el límite.'
    : remaining <= total * 0.15
      ? 'Queda menos del 15 % del presupuesto. Priorizá correcciones y validación.'
      : 'Actualización automática cada ~2 segundos. El consumo refleja los datos reportados por el proveedor.';
}
function updateDetailView(data) {
  const job = data.job || {};
  $('detail-title').textContent = `Comité · ${job.id ? job.id.slice(0,8) : ''}`;
  $('detail-stage').textContent = job.stage || 'Preparando tarea…';
  $('detail-status').textContent = job.status === 'needs_review' && job.stage?.includes('presupuesto') ? 'Bloqueada · presupuesto' : statusNames[job.status] || job.status || 'Sin estado';
  $('detail-status').className = `status ${job.status || 'queued'}`;
  $('detail-live').textContent = ['queued','running'].includes(job.status) ? (job.stage?.includes('Esperando disponibilidad') ? '◷ EN ESPERA' : '● EN DIRECTO') : '● ACTUALIZADO';
  $('detail-live').classList.toggle('live-active', ['queued','running'].includes(job.status));
  const fill = $('detail-progress-fill');
  const track = $('detail-progress');
  track.classList.toggle('indeterminate', ['queued','running'].includes(job.status));
  fill.style.width = job.status === 'completed' ? '100%' : job.status === 'needs_review' ? '99%' : job.status === 'failed' ? '100%' : '35%';
  track.classList.toggle('progress-failed', job.status === 'failed');
  $('detail-progress-label').textContent = job.status === 'completed' ? '100% · resultado listo' : job.status === 'failed' ? 'Interrumpida · revisar diagnóstico' : job.status === 'needs_review' && job.stage?.includes('presupuesto') ? 'Checkpoint conservado · ajustar presupuesto para reanudar' : job.status === 'needs_review' ? '99% · necesita revisión humana' : job.status === 'queued' && data.retryAt ? 'Pausa automática · reanudación programada' : job.status === 'queued' ? 'En cola · esperando al motor' : 'Trabajando · esperando el siguiente hito';
  $('detail-hint').textContent = job.status === 'failed' ? (job.error || 'La tarea falló. Abrí el diagnóstico técnico para ver la causa.') : job.status === 'queued' && data.retryAt ? `Pausa automática por límite temporal del proveedor. Reanudación prevista: ${dateLabel(data.retryAt)}. Se conserva el checkpoint.` : ['queued','running'].includes(job.status) ? 'La tarea continúa automáticamente; el porcentaje refleja el último checkpoint guardado.' : 'El diagnóstico técnico está separado de la conversación completa y de los archivos generados.';
  renderTokenBudget(data);\n  renderConversation(data);
  renderArtifacts(data.artifacts, job.id, job.status, data.validation, data.syntax);
  const technicalEvents = (data.history || []).filter(entry => ['retry','error','check','usage'].includes(entry.type) || entry.agent === 'Validador').slice(-30).map(entry => ({ at: entry.at || null, agent: entry.agent || 'sistema', type: entry.type || 'message', detail: String(entry.content || '').slice(0, 1800) }));
  const diagnostic = {
    diagnosticVersion: 1, taskId: job.id || null, status: job.status || null, stage: job.stage || null,
    progressCheckpoint: job.progress ?? null, lastCheckpoint: data.lastCheckpoint || null,
    objective: String(data.objective || '').slice(0, 1800), error: job.error || null,
    providerBlock: data.providerBlock || null, retryAt: data.retryAt || null,
    tokenUsage: data.tokenUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, byModel: {} },
    validation: data.validation ? { verdict: data.validation.verdict || null, summary: data.validation.summary || null, findings: data.validation.findings || [] } : null,
    syntax: data.syntax || null, validationLevel: data.validationLevel || null,
    artifacts: (data.artifacts || []).map(file => ({ path: file.path, size: file.size, contentType: file.contentType })),
    technicalEvents
  };
  $('detail-content').textContent = JSON.stringify(diagnostic, null, 2);
  const previousStatus = state.lastJobStatus;
  state.lastJobStatus = job.status;
  if (previousStatus && previousStatus !== job.status) loadJobs().catch(() => {});
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
      await updateSelectedDetail();
      setConnection(true, 'Conversación sincronizada');

    } catch (error) { setConnection(false, 'Reconectando…'); console.warn(error.message); }
  })();
  try { await refreshPromise; } finally { refreshPromise = null; }
}
async function showDetail(id) {
  if (state.currentDetailId !== id) {
    $('artifact-preview-frame').src = 'about:blank';
    $('artifact-preview').classList.add('hidden');
  }
  state.currentDetailId = id;
  $('detail-panel').classList.remove('hidden');
  $('detail-title').textContent = `Comité · ${id.slice(0,8)}`;
  $('detail-stage').textContent = 'Conectando con la tarea…';
  $('conversation').innerHTML = '<div class="empty-state"><span class="empty-glyph">✳</span><p>Recuperando mensajes de los agentes…</p></div>';
  $('detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try { await updateSelectedDetail(); await loadJobs(); await loadHistorySummary(); }
  catch (error) { $('detail-stage').textContent = 'No se pudo actualizar la tarea'; $('detail-hint').textContent = error.message; }
}
async function enterApp() {
  await api('/api/access-check');
  $('access-status').textContent = '';
  showApp();
  try { await Promise.all([loadHistorySummary(), loadJobs()]); await refresh(); }
  catch (error) { setConnection(false, 'Error de conexión'); $('jobs-count').textContent = `No se pudieron cargar las tareas: ${error.message}`; }
  if (!state.pollHandle) state.pollHandle = setInterval(refresh, 1800);
  if (!state.listPollHandle) state.listPollHandle = setInterval(async () => { try { await loadJobs(); await loadHistorySummary(); } catch {} }, 12000);
}
$('access-form').addEventListener('submit', async event => {
  event.preventDefault(); state.accessKey = $('access-key').value.trim();
  if (!state.accessKey) { $('access-status').textContent = 'Ingresá la clave de acceso.'; return; }
  sessionStorage.setItem('swarm-access-key', state.accessKey);
  const button = $('access-form').querySelector('button[type="submit"]'); button.disabled = true;
  $('access-status').textContent = 'Verificando acceso…';
  try { await enterApp(); }
  catch (error) { $('access-status').textContent = error.message; showAccess(); }
  finally { button.disabled = false; }
});
$('job-form').addEventListener('submit', async event => {
  event.preventDefault(); const objective = $('objective').value.trim(); if (!objective) return;
  const button = $('submit-job'); button.disabled = true; button.textContent = 'Enviando…';
  $('job-submit-status').textContent = 'Enviando la orden al motor…';
  try { const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ objective }) }); $('objective').value = ''; $('job-submit-status').textContent = 'Orden recibida. Abriendo la tarea…'; await showDetail(job.id); await refresh(); }
  catch (error) { $('job-submit-status').textContent = `No se pudo iniciar: ${error.message}`; }
  finally { button.disabled = false; button.innerHTML = 'Iniciar comité <span>↗</span>'; }
});
$('refresh-jobs').addEventListener('click', async () => { try { await loadJobs(); await loadHistorySummary(); await refresh(); } catch (error) { alert(error.message); } });
$('jobs-filter').addEventListener('change', async () => { state.jobsFilter = $('jobs-filter').value; state.jobs = []; state.jobsTotal = 0; try { await loadJobs(); } catch (error) { alert(error.message); } });
$('load-more-jobs').addEventListener('click', async () => { const button = $('load-more-jobs'); button.disabled = true; try { await loadJobs({ append: true }); } catch (error) { alert(error.message); } finally { button.disabled = false; } });
$('show-history').addEventListener('click', async () => {
  state.historyShown = !state.historyShown;
  $('history-list').classList.toggle('hidden', !state.historyShown);
  $('show-history').innerHTML = state.historyShown ? 'Ocultar registros <span>↑</span>' : 'Ver registros <span>→</span>';
  if (!state.historyShown) return;
  try {
    const allJobs = [];
    let offset = 0;
    let total = 0;
    do {
      const page = await api(`/api/jobs?limit=100&offset=${offset}&status=all`);
      allJobs.push(...(page.jobs || []));
      total = page.total || 0;
      offset += (page.jobs || []).length;
      if (!(page.jobs || []).length) break;
    } while (offset < total);
    const data = { jobs: allJobs }; const list = $('history-list');
    list.innerHTML = (data.jobs || []).map(job => {
      const active = ['queued','running'].includes(job.status);
      const done = job.status === 'completed';
      const failed = job.status === 'failed';
      const pct = done ? 100 : job.status === 'needs_review' ? 99 : failed ? null : null;
      const progress = active ? '<div class="history-progress indeterminate"><span></span></div>' : pct !== null ? `<div class="history-progress"><span style="width:${pct}%"></span></div>` : '';
      const detail = active ? `${escapeHtml(job.stage || 'Trabajando')} · actividad en curso` : `${escapeHtml(job.stage || 'Sin etapa')} · ${escapeHtml(dateLabel(job.updatedAt || job.createdAt))}`;
      return `<div class="history-row"><div class="job-main"><div class="job-name">${escapeHtml(statusNames[job.status] || job.status)} · ${escapeHtml(job.id.slice(0,8))}</div><div class="job-meta">${detail}</div>${progress}</div><button class="mini-button" data-history="${escapeHtml(job.id)}">Abrir</button></div>`;
    }).join('') || '<p class="muted tiny">Sin registros.</p>';
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
$('agent-reply-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.currentDetailId) { $('agent-reply-status').textContent = 'Primero abrí una tarea del historial.'; return; }
  const message = $('agent-reply-message').value.trim();
  if (!message) return;
  const button = $('agent-reply-submit');
  button.disabled = true; button.textContent = 'Enviando…';
  $('agent-reply-status').textContent = 'Enviando el mensaje al agente de esta tarea…';
  try {
    const result = await api(`/api/jobs/${encodeURIComponent(state.currentDetailId)}/reply`, { method: 'POST', body: JSON.stringify({ agent: $('agent-reply-target').value, message }) });
    $('agent-reply-message').value = '';
    $('agent-reply-status').textContent = `Respuesta de ${result.agent || 'agente'} recibida en esta tarea.`;
    await updateSelectedDetail();
  } catch (error) {
    $('agent-reply-status').textContent = `No se pudo enviar: ${error.message}`;
  } finally {
    button.disabled = false; button.textContent = 'Enviar al agente ↗';
  }
});
$('close-detail').addEventListener('click', () => { $('detail-panel').classList.add('hidden'); state.currentDetailId = null; state.lastJobStatus = null; });
async function boot() {
  try { const health = await fetch('/healthz'); if (!health.ok) throw new Error(); setConnection(true, 'Puente disponible'); }
  catch { setConnection(false, 'Puente no disponible'); }
  if (!state.accessKey) { showAccess(); return; }
  try { await enterApp(); } catch (error) { showAccess(); $('access-status').textContent = error.message; }
}
boot();