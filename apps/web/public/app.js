const $ = id => document.getElementById(id);
const state = { accessKey: sessionStorage.getItem('swarm-session-token') || '', user: null, accountKey: null, accountKeyVisible: false, apiFields: [], jobs: [], jobsTotal: 0, jobsFilter: 'all', historyShown: false, pollHandle: null, listPollHandle: null, currentDetailId: null, lastDetailSignature: '', uploadedZipPreview: null, currentTokenBudget: 1000000, jobStatuses: new Map(), agentDocuments: {}, artifactsSignature: '', previewedArtifactIndex: null, previewedArtifactJobId: null, previewedArtifactVersion: '', previewRefreshPending: '', eventStreamController: null, eventStreamGeneration: 0, chats: [], currentChatId: null, currentChat: null, chatMessages: [] };
const statusNames = { queued: 'En cola', running: 'En curso', completed: 'Completado', failed: 'Error', needs_review: 'Revisión humana' };
const agentIcons = { Vos: '◉', Arquitecto: '⌂', Escéptico: '◈', Árbitro: '⚖', 'Coordinador de coherencia': '⌘', Desarrollador: '⌘', Validador: '✓', 'Validador determinista': '⌁', sistema: '✳' };
let refreshPromise = null;
window.SwarmEvents?.on('task.notice', event => {
  const { message, level } = event.detail || {};
  if (message) showTaskNotice(message, level || 'warning');
});
function authHeaders(json = true) { return { ...(json ? { 'content-type': 'application/json' } : {}), ...(state.accessKey ? { authorization: `Bearer ${state.accessKey}` } : {}) }; }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...authHeaders(options.body !== undefined), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { state.accessKey = ''; state.user = null; sessionStorage.removeItem('swarm-session-token'); showAccess(); throw new Error(data.error || 'La sesión venció.'); }
  if (!response.ok) throw new Error(data.error || `Error HTTP ${response.status}`);
  return data;
}
function showAccess() { document.body.classList.add('auth-gate'); $('files-menu-toggle')?.classList.add('hidden'); $('files-drawer')?.classList.add('hidden'); $('access-panel').classList.remove('hidden'); $('app-content').classList.add('hidden'); $('api-settings-panel').classList.add('hidden'); $('account-menu').classList.add('hidden'); $('access-key').value = ''; if ($('access-form')?.classList.contains('hidden')) { $('invite-gate-form')?.classList.remove('hidden'); $('register-form')?.classList.add('hidden'); $('show-login')?.classList.remove('hidden'); $('show-key-login')?.classList.add('hidden'); if ($('register-status')) $('register-status').textContent = ''; } }
function showApp() { document.body.classList.remove('auth-gate'); syncViewportAfterChange(); $('files-menu-toggle')?.classList.remove('hidden'); $('access-panel').classList.add('hidden'); $('api-settings-panel').classList.add('hidden'); $('app-content').classList.remove('hidden'); $('account-menu').classList.remove('hidden'); const isAdmin = state.user?.role === 'admin'; $('invite-admin-panel').classList.toggle('hidden', !isAdmin); $('managed-users-panel').classList.toggle('hidden', !isAdmin); }
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
  $('history-copy').textContent = active.length ? `${latest && ['queued','running'].includes(latest.status) ? (latest.title || latest.stage) : 'El comité sigue trabajando'} · los hitos se guardan al terminar cada etapa.` : data.hasHistory ? (latest ? `Última: ${latest.title || 'Tarea'} · ${statusNames[latest.status] || latest.status}` : 'Abrí una tarea para ver su conversación.') : 'Las tareas y sus conversaciones aparecerán aquí.';
  $('show-history').classList.toggle('hidden', !data.hasHistory);
}
async function loadHistorySummary() { renderHistory(await api('/api/history')); }
function observeJobStatus(job) {
  if (!job?.id) return { changed: false, wasActive: false, terminal: false };
  const previousStatus = state.jobStatuses.get(job.id);
  state.jobStatuses.set(job.id, job.status);
  if (!previousStatus || previousStatus === job.status) return { changed: false, wasActive: false, terminal: false };
  const wasActive = ['queued', 'running'].includes(previousStatus);
  const terminal = ['completed', 'failed', 'needs_review'].includes(job.status);
  const budgetBlocked = job.status === 'needs_review' && /presupuesto|tokens/i.test(job.stage || '');
  window.SwarmEvents?.emit('task.status.changed', {
    jobId: job.id, title: job.title || '', previousStatus, status: job.status, wasActive, terminal
  });
  const notify = (message, level) => window.SwarmEvents?.emit('task.notice', { message, level });
  if (wasActive && job.status === 'completed') notify(`Los agentes terminaron «${job.title || `tarea ${job.id.slice(0,8)}`}». El resultado está listo para revisar.`, 'completed');
  else if (wasActive && job.status === 'failed') notify(`«${job.title || `Tarea ${job.id.slice(0,8)}`}» se interrumpió. Abrí el diagnóstico para ver la causa.`, 'failed');
  else if (wasActive && job.status === 'needs_review' && budgetBlocked) notify(`«${job.title || `Tarea ${job.id.slice(0,8)}`}» alcanzó su presupuesto. El checkpoint está guardado y la continuación se prepara automáticamente.`, 'warning');
  else if (wasActive && job.status === 'needs_review') notify(`«${job.title || `Tarea ${job.id.slice(0,8)}`}» necesita revisión humana antes de considerarla aprobada.`, 'warning');
  return { changed: true, wasActive, terminal };
}

// Fetch-based SSE client: unlike EventSource, fetch can send the existing Bearer token.
function stopTaskEventStream() {
  state.eventStreamGeneration += 1;
  state.eventStreamController?.abort();
  state.eventStreamController = null;
}
function startTaskEventStream() {
  stopTaskEventStream();
  const generation = ++state.eventStreamGeneration;
  const pause = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  void (async () => {
    while (state.accessKey && generation === state.eventStreamGeneration) {
      const controller = new AbortController();
      state.eventStreamController = controller;
      try {
        const response = await fetch('/api/events', {
          headers: authHeaders(false),
          cache: 'no-store',
          signal: controller.signal
        });
        if (response.status === 401) {
          state.accessKey = '';
          state.user = null;
          sessionStorage.removeItem('swarm-session-token');
          showAccess();
          return;
        }
        if (!response.ok || !response.body) throw new Error(`Event stream HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (generation === state.eventStreamGeneration) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() || '';
          for (const frame of frames) {
            let eventName = 'message';
            const dataLines = [];
            for (const line of frame.split(/\r?\n/)) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
            }
            if (!dataLines.length) continue;
            let payload;
            try { payload = JSON.parse(dataLines.join('\n')); } catch { continue; }
            if (eventName === 'task.status' && payload.jobId && payload.status) {
              observeJobStatus({
                id: payload.jobId, title: payload.title || '', stage: payload.stage || '',
                status: payload.status
              });
              if (payload.terminal) {
                void Promise.allSettled([loadJobs(), loadHistorySummary()]);
                if (state.currentDetailId === payload.jobId) void refresh();
              }
            } else if (eventName === 'session.expired') {
              state.accessKey = '';
              state.user = null;
              sessionStorage.removeItem('swarm-session-token');
              showAccess();
              stopTaskEventStream();
              return;
            }
          }
        }
        try { await reader.cancel(); } catch {}
      } catch (error) {
        if (error?.name !== 'AbortError' && generation === state.eventStreamGeneration) {
          console.warn('[swarm] event stream reconnecting');
        }
      } finally {
        if (state.eventStreamController === controller) state.eventStreamController = null;
      }
      if (state.accessKey && generation === state.eventStreamGeneration) await pause(3000);
    }
  })();
}

async function monitorAllJobStatuses() {
  // Keep completion notices working even when the user filters the visible activity list.
  const data = await api('/api/jobs?limit=100&offset=0&status=all');
  for (const job of (data.jobs || [])) observeJobStatus(job);
}
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
  // Watch every task currently present in the activity list, not only the open detail pane.
  state.jobs.forEach(observeJobStatus);
  const list = $('jobs-list');
  if (!state.jobs.length) {
    list.innerHTML = '<div class="empty-state"><span class="empty-glyph">✳</span><p>No hay tareas en esta categoría.</p><span class="muted tiny">Probá otro filtro o creá una tarea.</span></div>';
  } else {
    list.innerHTML = state.jobs.map(job => `<div class="job-row ${job.id === state.currentDetailId ? 'selected' : ''}"><div class="job-main"><div class="job-name" title="${escapeHtml(job.title || `Tarea ${job.id.slice(0,8)}`)}">${escapeHtml(job.title || `Tarea ${job.id.slice(0,8)}`)}</div><div class="job-meta">${escapeHtml(job.stage)} · ${escapeHtml(dateLabel(job.updatedAt))}</div><div class="status ${escapeHtml(job.status)}">${escapeHtml(statusNames[job.status] || job.status)}</div></div><button class="mini-button" data-detail="${escapeHtml(job.id)}">Ver comité</button>${job.status === 'failed' || job.status === 'needs_review' ? `<button class="mini-button" data-retry="${escapeHtml(job.id)}">Reintentar</button>` : ''}</div>`).join('');
  }
  $('jobs-count').textContent = `${state.jobs.length} de ${state.jobsTotal} tareas`;
  $('load-more-jobs').classList.toggle('hidden', state.jobs.length >= state.jobsTotal);
  list.querySelectorAll('[data-detail]').forEach(button => button.addEventListener('click', () => showDetail(button.dataset.detail)));
  list.querySelectorAll('[data-retry]').forEach(button => button.addEventListener('click', async () => { try { await api(`/api/jobs/${encodeURIComponent(button.dataset.retry)}/retry`, { method: 'POST', body: '{}' }); await showDetail(button.dataset.retry); await refresh(); await loadJobs(); } catch (error) { alert(error.message); } }));
}
function renderConversation(data) {
  const conversation = $('conversation');
  const historyEntries = (Array.isArray(data.history) ? data.history : []).filter(entry => !(entry?.type === 'activity' && /termin[oó] su an[aá]lisis y comparti[oó] su respuesta|termin[oó] la revisi[oó]n; resultado de la auditor[ií]a a continuaci[oó]n/i.test(String(entry.content || ''))));
  const entries = data.objective ? [{ at: data.createdAt || '', agent: 'Vos', type: 'message', content: data.objective }, ...historyEntries] : historyEntries;
  const nearBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 48;
  const anchor = nearBottom ? null : [...conversation.querySelectorAll('[data-message-key]')].find(node => node.getBoundingClientRect().bottom > conversation.getBoundingClientRect().top + 2);
  const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
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
    const isUser = ['vos', 'usuario', 'user', 'tú'].includes(agent.toLocaleLowerCase('es'));
    const isSystem = !isUser && (['sistema', 'Validador determinista'].includes(agent) || ['retry','error','check'].includes(type));
    const label = type === 'thinking' ? 'TRABAJANDO' : type === 'activity' ? 'ACTIVIDAD' : type === 'retry' ? 'REINTENTO' : type === 'error' ? 'ERROR' : type === 'check' ? 'COMPROBACIÓN' : type === 'usage' ? 'TOKENS' : type === 'budget' ? 'PRESUPUESTO' : 'MENSAJE';
    const icon = agentIcons[agent] || (isSystem ? '✳' : '◈');
    if (!node) {
      node = document.createElement('article');
      node.dataset.messageKey = key;
      node.className = 'chat-message';
      node.innerHTML = '<div class="agent-avatar"></div><div class="message-body"><div class="message-heading"><strong></strong><span></span><time></time></div><div class="message-text"></div></div>';
      conversation.appendChild(node);
    }
    node.className = `chat-message ${isUser ? 'agent-vos' : isSystem ? 'system-message' : 'agent-' + agentClass(agent)} ${type === 'thinking' ? 'thinking-message' : ''}`;
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
  else if (anchor?.isConnected) conversation.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  syncJumpLatestButton();
}
function syncJumpLatestButton() {
  const conversation = $('conversation');
  const button = $('jump-to-latest');
  if (!conversation || !button) return;
  const awayFromLatest = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight > 120;
  button.classList.toggle('hidden', !awayFromLatest || !conversation.querySelector('[data-message-key]'));
  button.setAttribute('aria-hidden', String(!awayFromLatest));
}
$('conversation')?.addEventListener('scroll', syncJumpLatestButton, { passive: true });
$('jump-to-latest')?.addEventListener('click', () => {
  const conversation = $('conversation');
  if (!conversation) return;
  conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'auto' });
  syncJumpLatestButton();
});
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
  $('download-bundle').disabled = items.length === 0;
  $('download-bundle').textContent = bundleReady ? 'Descargar proyecto completo (.zip) ↓' : jobStatus === 'needs_review' || jobStatus === 'failed' ? 'Descargar ZIP · revisión pendiente ↓' : 'Descargar ZIP · entrega sin validar ↓';
  const signature = JSON.stringify({ jobId, files: items.map(file => [file.index, file.path, file.size, file.version || file.updatedAt || '']) });
  const artifactsChanged = signature !== state.artifactsSignature;
  if (artifactsChanged) state.artifactsSignature = signature;
  if (artifactsChanged) {
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
      state.previewedArtifactIndex = Number(button.dataset.previewIndex);
      state.previewedArtifactJobId = jobId;
      state.previewedArtifactVersion = signature;
      preview.classList.remove('hidden');
      window.SwarmPreviewWindow?.open();
    } catch (error) {
      $('artifact-preview-status').textContent = `No se pudo abrir la vista previa: ${error.message}`;
      window.SwarmPreviewWindow?.open();
    } finally { button.disabled = false; button.textContent = original; }
  }));
  }
  if (artifactsChanged && !$('artifact-preview').classList.contains('hidden') && state.previewedArtifactJobId === jobId && state.previewedArtifactIndex !== null) {
    const selected = items.find(file => Number(file.index) === Number(state.previewedArtifactIndex));
    if (selected && state.previewedArtifactVersion !== signature && state.previewRefreshPending !== signature) {
      state.previewRefreshPending = signature;
      api(`/api/jobs/${encodeURIComponent(jobId)}/preview-session`, { method: 'POST', body: JSON.stringify({ index: Number(selected.index) }) }).then(result => {
        if (state.currentDetailId !== jobId || state.artifactsSignature !== signature || $('artifact-preview').classList.contains('hidden')) return;
        const frame = $('artifact-preview-frame');
        if (frame.src !== result.url) frame.src = result.url;
        state.previewedArtifactVersion = signature;
        $('artifact-preview-status').textContent = 'Vista previa actualizada con los últimos archivos guardados. La sesión sigue aislada de la página principal.';
      }).catch(error => {
        $('artifact-preview-status').textContent = `Los archivos cambiaron, pero no se pudo actualizar la vista previa: ${error.message}`;
      }).finally(() => { if (state.previewRefreshPending === signature) state.previewRefreshPending = ''; });
    }
  }
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
  state.previewedArtifactIndex = null; state.previewedArtifactJobId = null; state.previewedArtifactVersion = '';
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
  state.currentTokenBudget = total;
  const job = data.job || {};
  const budgetPaused = job.status === 'needs_review' && /presupuesto|tokens/i.test(job.stage || '');
  // Continuations are created by the worker; no manual budget-extension or batch button is shown.
  const used = Math.max(0, Number(data.tokensUsed ?? usage.totalTokens) || 0);
  const remaining = Math.max(0, Number(data.tokensRemaining ?? (total - used)) || 0);
  const prompt = Math.max(0, Number(usage.promptTokens) || 0);
  const completion = Math.max(0, Number(usage.completionTokens) || 0);
  const calls = Math.max(0, Number(usage.calls) || 0);
  const wasted = Math.max(0, Number(usage.wastedTokens) || 0);
  const chatTokens = Math.max(0, Number(usage.byInteraction?.['direct-chat']?.totalTokens) || 0);
  const pct = Math.min(100, used / total * 100);
  const fmt = value => Math.round(value).toLocaleString('es-AR');
  $('tokens-remaining').textContent = fmt(remaining);
  $('tokens-total-label').textContent = 'de ' + fmt(total);
  $('tokens-used').textContent = fmt(used);
  $('tokens-input').textContent = fmt(prompt);
  $('tokens-output').textContent = fmt(completion);
  $('tokens-calls').textContent = fmt(calls);
  if ($('tokens-wasted')) $('tokens-wasted').textContent = fmt(wasted);
  if ($('tokens-chat')) $('tokens-chat').textContent = fmt(chatTokens);
  $('token-budget-fill').style.width = pct + '%';
  $('token-budget-track').setAttribute('aria-valuemax', String(total));
  $('token-budget-track').setAttribute('aria-valuenow', String(Math.min(total, used)));
  $('token-budget-track').classList.toggle('token-budget-low', remaining <= total * 0.15);
  const stageSummary = Object.entries(usage.byStage || {})
    .filter(([, bucket]) => Number(bucket?.totalTokens) > 0)
    .sort((a, b) => Number(b[1]?.totalTokens || 0) - Number(a[1]?.totalTokens || 0))
    .slice(0, 5)
    .map(([stage, bucket]) => `${stage}: ${fmt(bucket.totalTokens)}`)
    .join(' · ');
  if ($('token-stage-breakdown')) $('token-stage-breakdown').textContent = stageSummary ? 'Por etapa: ' + stageSummary : 'Por etapa: todavía sin consumo registrado.';
  if ($('token-chain-note')) {
    const taskNumber = Math.max(1, Number(data.continuationNumber) || 1);
    const prior = Math.max(0, Number(data.priorTokensUsed) || 0);
    const lifetime = Math.max(0, Number(data.lifetimeTokensUsed) || (prior + used));
    $('token-chain-note').textContent = `Tarea ${taskNumber} · ${fmt(used)} / ${fmt(total)} tokens. Tareas anteriores: ${fmt(prior)} · acumulado de la cadena: ${fmt(lifetime)} tokens.`;
  }
  const duplicateEvents = Math.max(0, Number(usage.dedupedEvents) || 0);
  const unreportedCalls = Math.max(0, Number(usage.unreportedCalls) || 0);
  const baseNote = budgetPaused
    ? 'Esta tarea llegó al presupuesto configurado. El checkpoint se conserva y la continuación se crea automáticamente.'
    : remaining === 0
      ? 'Cada tarea tiene un máximo de 1.000.000 tokens. Al agotarlo, Swarm crea automáticamente otra tarea y conserva el checkpoint, los archivos y el consumo acumulado.'
      : remaining <= total * 0.15
      ? 'Queda menos del 15 % del presupuesto. Priorizá correcciones y validación.'
      : 'Consumo según el usage reportado por el proveedor; “Tras cierre” identifica respuestas automáticas tardías y el chat va separado.';
  const accountingNotes = [];
  if (duplicateEvents) accountingNotes.push(`${fmt(duplicateEvents)} eventos duplicados ignorados.`);
  if (unreportedCalls) accountingNotes.push(`${fmt(unreportedCalls)} llamadas sin tokens reportados; no se inventa consumo.`);
  $('token-budget-note').textContent = [baseNote, ...accountingNotes].join(' ');
}
function renderAgentMemory(data) {
  const select = $('agent-memory-select');
  const individual = $('agent-memory-content');
  const shared = $('shared-memory-content');
  if (!select || !individual || !shared) return;
  state.agentDocuments = data.agentDocuments || {};
  const docs = Object.values(state.agentDocuments);
  const previous = select.value;
  select.replaceChildren();
  for (const doc of docs) {
    const option = document.createElement('option');
    option.value = String(doc.agent || '');
    option.textContent = String(doc.agent || 'Agente');
    select.append(option);
  }
  const selected = docs.find(doc => doc.agent === previous) || docs[docs.length - 1];
  if (selected) select.value = selected.agent;
  individual.textContent = selected?.markdown || 'Todavía no hay checkpoints registrados para agentes. Al completar su primera etapa aparecerá aquí su cuaderno persistente.';
  shared.textContent = String(data.sharedDocument || 'La memoria compartida se creará con el primer checkpoint.');
  const updated = data.memoryUpdatedAt ? new Date(data.memoryUpdatedAt).toLocaleString() : 'Todavía sin actualizaciones';
  $('agent-memory-updated').textContent = 'Última actualización: ' + updated;
}

function renderImprovementVote(data) {
  const panel = $('improvement-vote-panel');
  if (!panel) return;
  const job = data.job || {};
  const budgetPaused = job.status === 'needs_review' && /presupuesto|tokens/i.test(job.stage || '');
  const eligible = ['queued', 'running', 'completed', 'failed'].includes(job.status) || (job.status === 'needs_review' && !budgetPaused);
  panel.classList.toggle('hidden', !eligible);
  if (!eligible) return;
  const votes = Array.isArray(data.improvementVotes) ? data.improvementVotes : [];
  const latest = votes[votes.length - 1];
  const result = $('improvement-vote-result');
  const status = $('improvement-vote-status');
  if (!latest) {
    result.classList.add('hidden');
    result.innerHTML = '';
    status.textContent = 'Podés convocar al comité sin detener la tarea. Los votos corren en segundo plano y consumen tokens adicionales; la decisión final queda en tus manos.';
    return;
  }
  result.classList.remove('hidden');
  const title = latest.status === 'running' ? 'Votación en curso' : latest.outcome === 'MAYORIA_A_FAVOR' ? 'Mayoría a favor' :
    latest.outcome === 'MAYORIA_EN_CONTRA' ? 'Mayoría en contra' :
    latest.outcome === 'SIN_VOTOS_VALIDOS' ? 'Sin votos válidos' : 'Votación empatada';
  const badgeClass = latest.status === 'running' ? 'vote-neutral' : latest.outcome === 'MAYORIA_A_FAVOR' ? 'vote-support' :
    latest.outcome === 'MAYORIA_EN_CONTRA' ? 'vote-oppose' : 'vote-neutral';
  const tally = latest.tally || {};
  const ballots = Array.isArray(latest.votes) ? latest.votes : [];
  result.innerHTML = `<div class="vote-result-head"><div><p class="panel-kicker">${escapeHtml(latest.status === 'running' ? 'PROCESANDO EN SEGUNDO PLANO' : latest.status !== 'completed' ? 'RESULTADO INCOMPLETO' : 'RESULTADO REGISTRADO')}</p><h4>${escapeHtml(title)}</h4></div><span class="vote-outcome ${badgeClass}">${escapeHtml(latest.answered ?? 0)}/${escapeHtml(latest.total ?? ballots.length)} votos válidos</span></div><p class="vote-proposal">${escapeHtml(latest.proposal || '')}</p><p class="vote-summary">${escapeHtml(latest.summary || 'Sin resumen disponible.')}</p><div class="vote-tally"><span>A favor <strong>${Number(tally.APOYAR) || 0}</strong></span><span>En contra <strong>${Number(tally.RECHAZAR) || 0}</strong></span><span>Abstenciones <strong>${Number(tally.ABSTENERSE) || 0}</strong></span></div><div class="vote-ballots">${ballots.map(ballot => { const kind = ballot.vote === 'APOYAR' ? 'vote-support' : ballot.vote === 'RECHAZAR' ? 'vote-oppose' : 'vote-neutral'; return `<article class="vote-ballot"><div class="vote-ballot-head"><strong>${escapeHtml(ballot.agent || 'Agente')}</strong><span class="vote-choice ${kind}">${escapeHtml(ballot.vote || 'ABSTENERSE')}</span></div><p>${escapeHtml(ballot.rationale || 'Sin justificación.')}</p>${ballot.error ? `<p class="vote-error">No respondió el proveedor: ${escapeHtml(ballot.error)}</p>` : ''}</article>`; }).join('')}</div><p class="muted tiny">La votación es orientativa: no aplica ni confirma cambios. Tokens registrados en la etapa “Votación de mejora”.</p>`;
  status.textContent = latest.status === 'running' ? 'Los agentes están votando en segundo plano. Podés seguir trabajando; el resultado aparecerá al actualizarse la tarea.' : latest.status !== 'completed' ? 'La última votación fue parcial o no obtuvo respuestas válidas; revisá los errores. La misma propuesta no se repetirá automáticamente para evitar consumo duplicado.' : 'Última votación guardada. Podés someter otra propuesta; repetir la misma no consume tokens nuevamente.';
}
function updateDetailView(data) {
  renderAgentMemory(data);
  const job = data.job || {};
  const taskNumber = Math.max(1, Number(data.continuationNumber) || 1);
  const continuationLabel = data.continuationOf ? ` · Continuación ${taskNumber}` : '';
  const taskTitle = job.title || (job.id ? `Tarea ${job.id.slice(0,8)}` : 'Conversación de agentes');
  $('detail-title').textContent = `${taskTitle}${continuationLabel}`;
  $('detail-title').title = taskTitle;
  $('detail-stage').textContent = job.stage || 'Preparando tarea…';
  const budgetBlocked = job.status === 'needs_review' && /presupuesto|tokens/i.test(job.stage || '');
  $('detail-status').textContent = budgetBlocked ? 'Pausada · presupuesto' : `${data.continuationOf && ['queued','running'].includes(job.status) ? `Continuación ${taskNumber} · ` : ''}${statusNames[job.status] || job.status || 'Sin estado'}`;
  $('detail-status').className = `status ${job.status || 'queued'}`;
  $('detail-live').textContent = ['queued','running'].includes(job.status) ? (job.stage?.includes('Esperando disponibilidad') ? '◷ EN ESPERA' : '● EN DIRECTO') : job.status === 'completed' ? '✓ AGENTES TERMINARON' : job.status === 'needs_review' ? '● ACCIÓN REQUERIDA' : job.status === 'failed' ? '● TAREA INTERRUMPIDA' : '● ACTUALIZADO';
  $('detail-live').classList.toggle('live-active', ['queued','running'].includes(job.status));
  const fill = $('detail-progress-fill');
  const track = $('detail-progress');
  track.classList.toggle('indeterminate', ['queued','running'].includes(job.status));
  fill.style.width = job.status === 'completed' ? '100%' : job.status === 'needs_review' ? '99%' : job.status === 'failed' ? '100%' : '35%';
  track.classList.toggle('progress-failed', job.status === 'failed');
  $('detail-progress-label').textContent = job.status === 'completed' ? '100% · resultado listo' : job.status === 'failed' ? 'Interrumpida · revisar diagnóstico' : job.status === 'needs_review' && job.stage?.includes('presupuesto') ? 'Checkpoint conservado · ajustar presupuesto para reanudar' : job.status === 'needs_review' ? '99% · necesita revisión humana' : job.status === 'queued' && data.retryAt ? 'Pausa automática · reanudación programada' : job.status === 'queued' ? 'En cola · esperando al motor' : 'Trabajando · esperando el siguiente hito';
  $('detail-hint').textContent = job.status === 'failed' ? (job.error || 'La tarea falló. Abrí el diagnóstico técnico para ver la causa.') : job.status === 'queued' && data.retryAt ? `Pausa automática por límite temporal del proveedor. Reanudación prevista: ${dateLabel(data.retryAt)}. Se conserva el checkpoint.` : ['queued','running'].includes(job.status) ? 'La tarea continúa automáticamente; el porcentaje refleja el último checkpoint guardado.' : 'El diagnóstico técnico está separado de la conversación completa y de los archivos generados.';
  renderTokenBudget(data);
  renderConversation(data);
  renderArtifacts(data.artifacts, job.id, job.status, data.validation, data.syntax);
  renderImprovementVote(data);
  const technicalEvents = (data.history || []).filter(entry => ['retry','error','check','usage'].includes(entry.type) || entry.agent === 'Validador').slice(-30).map(entry => ({ at: entry.at || null, agent: entry.agent || 'sistema', type: entry.type || 'message', detail: String(entry.content || '').slice(0, 1800) }));
  const diagnostic = {
    diagnosticVersion: 1, taskId: job.id || null, status: job.status || null, stage: job.stage || null,
    progressCheckpoint: job.progress ?? null, lastCheckpoint: data.lastCheckpoint || null,
    objective: String(data.objective || '').slice(0, 1800), error: job.error || null,
    providerBlock: data.providerBlock || null, retryAt: data.retryAt || null,
    tokenUsage: data.tokenUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, byModel: {} },
    tokenBudget: data.tokenBudget || 50000, tokensRemaining: data.tokensRemaining ?? null, coherenceReview: data.coherenceReview || null,
    validation: data.validation ? { verdict: data.validation.verdict || null, summary: data.validation.summary || null, findings: data.validation.findings || [] } : null,
    syntax: data.syntax || null, validationLevel: data.validationLevel || null,
    artifacts: (data.artifacts || []).map(file => ({ path: file.path, size: file.size, contentType: file.contentType })),
    technicalEvents
  };
  $('detail-content').textContent = JSON.stringify(diagnostic, null, 2);
  const transition = observeJobStatus(job);
  if (transition.wasActive && transition.terminal) loadJobs().catch(() => {});
  state.lastJobStatus = job.status;
  state.lastDetailSignature = JSON.stringify({ id: job.id, status: job.status, stage: job.stage, updatedAt: job.updatedAt, historyLength: (data.history || []).length });
}
function showTaskNotice(message, kind = 'completed') {
  const notice = $('task-notice');
  const text = $('task-notice-text');
  if (!notice || !text) return;
  text.textContent = message;
  notice.className = `task-notice ${kind}`;
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
    try { new Notification('Swarm · estado de tarea', { body: message }); } catch {}
  }
}
function hideTaskNotice() {
  const notice = $('task-notice');
  if (notice) notice.classList.add('hidden');
}
$('task-notice-close')?.addEventListener('click', hideTaskNotice);

async function updateSelectedDetail() {
  if (!state.currentDetailId) return;
  const selectedId = state.currentDetailId;
  const data = await api(`/api/jobs/${encodeURIComponent(selectedId)}/history`);
  // The worker persists the parent->child link transactionally. Follow it in the UI
  // so a long-running order stays on its newest continuation after the 1M cap.
  if (data.continuedByJobId && data.continuedByJobId !== selectedId) {
    await showDetail(data.continuedByJobId);
    return;
  }
  if (state.currentDetailId !== selectedId) return;
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
  if (state.currentDetailId !== id) hideTaskNotice();
  state.currentDetailId = id;
  $('welcome-chat')?.classList.add('hidden');
  $('detail-panel').classList.remove('hidden');
  $('detail-title').textContent = `Agentes · ${id.slice(0,8)}`;
  $('detail-stage').textContent = 'Conectando con la tarea…';
  $('conversation').innerHTML = '<div class="empty-state"><span class="empty-glyph">✳</span><p>Recuperando mensajes de los agentes…</p></div>';
  $('detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try { await updateSelectedDetail(); await loadJobs(); await loadHistorySummary(); }
  catch (error) { $('detail-stage').textContent = 'No se pudo actualizar la tarea'; $('detail-hint').textContent = error.message; }
}
async function enterApp() {
  const access = await api('/api/access-check');
  state.user = access.user || state.user;
  $('access-status').textContent = '';
  showApp();
  startTaskEventStream();
  try { await Promise.all([loadHistorySummary(), loadJobs(), monitorAllJobStatuses(), loadChats()]); await refresh(); }
  catch (error) { setConnection(false, 'Error de conexión'); $('jobs-count').textContent = `No se pudieron cargar las tareas: ${error.message}`; }
  if (!state.pollHandle) state.pollHandle = setInterval(refresh, 1800);
  if (!state.listPollHandle) state.listPollHandle = setInterval(async () => {
    try { await Promise.all([loadJobs(), monitorAllJobStatuses(), loadHistorySummary()]); } catch {}
  }, 12000);
}
$('access-form').addEventListener('submit', async event => {
  event.preventDefault();
  const username = $('access-username').value.trim().toLowerCase();
  const password = $('access-key').value;
  const button = $('access-form').querySelector('button[type="submit"]'); button.disabled = true;
  $('access-status').textContent = 'Verificando acceso…';
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');
    state.accessKey = data.token; state.user = data.user;
    sessionStorage.setItem('swarm-session-token', state.accessKey);
    sessionStorage.removeItem('swarm-access-key'); $('access-key').value = '';
    await enterApp();
  } catch (error) { $('access-status').textContent = error.message; showAccess(); }
  finally { button.disabled = false; }
});

$('key-access-form').addEventListener('submit', async event => {
  event.preventDefault();
  const accountCode = $('key-access-code').value.trim(), accessKey = $('key-access-secret').value.trim();
  const button = $('key-access-form').querySelector('button[type="submit"]'); button.disabled = true;
  $('key-access-status').textContent = 'Verificando tu clave…';
  try {
    const response = await fetch('/api/auth/key-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountCode, accessKey }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');
    state.accessKey = data.token; state.user = data.user; sessionStorage.setItem('swarm-session-token', state.accessKey); $('key-access-secret').value = '';
    await enterApp();
  } catch (error) { $('key-access-status').textContent = error.message; }
  finally { button.disabled = false; }
});
$('show-key-login').addEventListener('click', () => { $('invite-gate-form')?.classList.add('hidden'); $('register-form')?.classList.add('hidden'); $('access-form')?.classList.add('hidden'); $('key-access-form').classList.remove('hidden'); $('show-login')?.classList.add('hidden'); $('show-key-login').classList.add('hidden'); });
$('back-to-password-login').addEventListener('click', () => { $('key-access-form').classList.add('hidden'); $('access-form').classList.remove('hidden'); $('show-key-login').classList.remove('hidden'); });
$('toggle-login-key').addEventListener('click', () => { const input = $('key-access-secret'); input.type = input.type === 'password' ? 'text' : 'password'; $('toggle-login-key').setAttribute('aria-label', input.type === 'password' ? 'Mostrar clave' : 'Ocultar clave'); });

// Account menu and compact, dynamically-added API fields.
const CUSTOM_PROVIDER_VALUE = '__custom_openai_compatible__';
const API_PROVIDERS = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', reasoning: 'gpt-4o-mini', coding: 'gpt-4o-mini', validation: 'gpt-4o-mini' },
  { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', reasoning: 'gemini-3.8-flash', coding: 'gemini-3.8-flash', validation: 'gemini-3.8-flash' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', reasoning: 'openai/gpt-oss-120b', coding: 'openai/gpt-oss-120b', validation: 'openai/gpt-oss-20b' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', reasoning: 'openai/gpt-4o-mini', coding: 'openai/gpt-4o-mini', validation: 'openai/gpt-4o-mini' },
  { label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', reasoning: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', coding: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', validation: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', reasoning: 'deepseek-chat', coding: 'deepseek-chat', validation: 'deepseek-chat' },
  { label: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', reasoning: 'mistral-small-latest', coding: 'mistral-small-latest', validation: 'mistral-small-latest' },
  { label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', reasoning: 'accounts/fireworks/models/llama-v3p3-70b-instruct', coding: 'accounts/fireworks/models/llama-v3p3-70b-instruct', validation: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
  { label: 'Perplexity', baseUrl: 'https://api.perplexity.ai', reasoning: 'sonar', coding: 'sonar', validation: 'sonar' },
  { label: 'Cohere', baseUrl: 'https://api.cohere.com/compatibility/v1', reasoning: 'command-a-03-2025', coding: 'command-a-03-2025', validation: 'command-a-03-2025' }
];
function providerForUrl(url) {
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  return API_PROVIDERS.find(provider => { try { return new URL(provider.baseUrl).hostname.toLowerCase() === host; } catch { return false; } }) || null;
}
function apiFieldRow(api = {}) {
  const row = document.createElement('div');
  row.className = 'api-field-row';
  row.dataset.slot = String(api.slot || state.apiFields.length + 1);
  row.dataset.saved = api.saved ? 'true' : 'false';
  const matchedProvider = providerForUrl(api.base_url || '');
  const customProvider = Boolean(api.base_url && !matchedProvider);
  const initialProvider = matchedProvider || API_PROVIDERS[0];
  const initialModels = {
    reasoning: api.model_reasoning || (customProvider ? '' : initialProvider.reasoning),
    coding: api.model_coding || (customProvider ? '' : initialProvider.coding),
    validation: api.model_validation || (customProvider ? '' : initialProvider.validation)
  };
  const main = document.createElement('div'); main.className = 'api-field-main';
  const providerLabel = document.createElement('label'); providerLabel.textContent = `API ${row.dataset.slot} · Proveedor`;
  const provider = document.createElement('select'); provider.className = 'api-provider-select';
  provider.setAttribute('aria-label', `Proveedor API ${row.dataset.slot}`);
  API_PROVIDERS.forEach(item => { const option = document.createElement('option'); option.value = item.baseUrl; option.textContent = item.label; provider.append(option); });
  const customOption = document.createElement('option');
  customOption.value = CUSTOM_PROVIDER_VALUE;
  customOption.textContent = 'Otra API compatible con OpenAI';
  provider.append(customOption);
  provider.value = customProvider ? CUSTOM_PROVIDER_VALUE : initialProvider.baseUrl;

  const customUrlLabel = document.createElement('label');
  customUrlLabel.textContent = 'URL base de la API personalizada (HTTPS público)';
  const customUrlInput = document.createElement('input');
  customUrlInput.type = 'url'; customUrlInput.autocomplete = 'off'; customUrlInput.spellcheck = false;
  customUrlInput.className = 'api-custom-url-input';
  customUrlInput.value = customProvider ? api.base_url : '';
  customUrlInput.placeholder = 'https://api.tu-proveedor.com/v1';
  customUrlInput.setAttribute('aria-label', `URL base API personalizada ${row.dataset.slot}`);
  customUrlLabel.append(customUrlInput);
  customUrlLabel.classList.toggle('hidden', !customProvider);

  const keyLabel = document.createElement('label'); keyLabel.textContent = 'Clave API privada';
  const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false;
  input.className = 'api-key-input';
  input.placeholder = api.saved ? 'Clave guardada (oculta; dejá vacío para conservarla)' : 'Pegá tu clave del proveedor elegido';
  input.setAttribute('aria-label', `Clave API ${row.dataset.slot}`);
  const modelInputs = {};
  const modelLabels = {};
  for (const role of ['reasoning','coding','validation']) {
    modelLabels[role] = document.createElement('label');
    modelLabels[role].textContent = ({ reasoning: 'Modelo de razonamiento', coding: 'Modelo de desarrollo', validation: 'Modelo de validación' })[role];
    modelInputs[role] = document.createElement('input');
    modelInputs[role].type = 'text'; modelInputs[role].autocomplete = 'off'; modelInputs[role].spellcheck = false;
    modelInputs[role].className = 'api-model-input';
    modelInputs[role].dataset.modelRole = role;
    modelInputs[role].value = initialModels[role];
    modelInputs[role].placeholder = customProvider ? 'ID de modelo compatible con OpenAI' : initialProvider[role];
    modelInputs[role].setAttribute('aria-label', `Modelo ${role} API ${row.dataset.slot}`);
    modelLabels[role].append(modelInputs[role]);
  }
  const meta = document.createElement('div'); meta.className = 'api-field-meta';
  meta.textContent = customProvider
    ? 'La API personalizada debe ser compatible con OpenAI Chat Completions y usar HTTPS público. No se admiten direcciones privadas.'
    : api.saved ? 'Clave cifrada guardada. Los modelos se pueden cambiar sin volver a pegar la clave.' : 'La clave la proporcionás vos; se cifra en el servidor y nunca se devuelve al navegador.';
  provider.addEventListener('change', () => {
    const isCustom = provider.value === CUSTOM_PROVIDER_VALUE;
    const previousBaseUrl = row.dataset.baseUrl;
    const wasCustom = !API_PROVIDERS.some(item => item.baseUrl === previousBaseUrl);
    const next = API_PROVIDERS.find(item => item.baseUrl === provider.value) || null;
    const previous = API_PROVIDERS.find(item => item.baseUrl === previousBaseUrl) || initialProvider;
    if (isCustom) {
      for (const role of ['reasoning','coding','validation']) {
        if (!modelInputs[role].value.trim() || modelInputs[role].value.trim() === previous[role]) modelInputs[role].value = '';
        modelInputs[role].placeholder = 'ID de modelo compatible con OpenAI';
      }
      customUrlLabel.classList.remove('hidden');
      row.dataset.baseUrl = customUrlInput.value.trim();
      row.dataset.label = customProvider ? (api.label || 'API personalizada') : 'API personalizada';
      meta.textContent = 'La API personalizada debe ser compatible con OpenAI Chat Completions y usar HTTPS público. No se admiten direcciones privadas.';
    } else {
      for (const role of ['reasoning','coding','validation']) {
        if (wasCustom || !modelInputs[role].value.trim() || modelInputs[role].value.trim() === previous[role]) modelInputs[role].value = next[role];
        modelInputs[role].placeholder = next[role];
      }
      customUrlLabel.classList.add('hidden');
      row.dataset.baseUrl = next.baseUrl;
      row.dataset.label = next.label;
      meta.textContent = api.saved && !input.value.trim()
        ? 'La clave guardada se conserva. Para cambiar de proveedor, pegá una clave nueva del proveedor elegido.'
        : 'La clave la proporcionás vos; se cifra en el servidor y nunca se devuelve al navegador.';
    }
  });
  customUrlInput.addEventListener('input', () => {
    if (provider.value === CUSTOM_PROVIDER_VALUE) row.dataset.baseUrl = customUrlInput.value.trim();
  });
  row.dataset.baseUrl = customProvider ? api.base_url : initialProvider.baseUrl;
  row.dataset.label = customProvider ? (api.label || 'API personalizada') : initialProvider.label;
  providerLabel.append(provider); keyLabel.append(input);
  main.append(providerLabel, customUrlLabel, keyLabel, modelLabels.reasoning, modelLabels.coding, modelLabels.validation, meta);
  const actions = document.createElement('div');
  if (api.saved) {
    const test = document.createElement('button'); test.type = 'button'; test.className = 'button button-secondary'; test.textContent = 'Probar conexión';
    test.addEventListener('click', async () => {
      test.disabled = true; test.textContent = 'Probando…';
      $('api-settings-status').textContent = `Verificando la API ${row.dataset.slot} sin generar una tarea…`;
      try {
        const result = await api(`/api/account/apis/${encodeURIComponent(row.dataset.slot)}/test`, { method: 'POST', body: '{}' });
        $('api-settings-status').textContent = `API ${row.dataset.slot} · ${result.provider}: ${result.message} Modelo: ${result.model}.`;
      } catch (error) { $('api-settings-status').textContent = `No se pudo validar la API ${row.dataset.slot}: ${error.message}`; }
      finally { test.disabled = false; test.textContent = 'Probar conexión'; }
    });
    actions.append(test);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button button-secondary'; remove.textContent = 'Quitar';
    remove.addEventListener('click', async () => {
      if (!confirm(`¿Quitar la API ${row.dataset.slot} de tu cuenta? Esta acción no se puede deshacer.`)) return;
      try { await apiCallDelete(row.dataset.slot); await loadApiSettings(); $('api-settings-status').textContent = 'API eliminada de tu cuenta.'; }
      catch (error) { $('api-settings-status').textContent = error.message; }
    });
    actions.append(remove);
  } else if (Number(row.dataset.slot) > 1) {
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button button-secondary'; remove.textContent = 'Quitar campo'; remove.addEventListener('click', () => { row.remove(); updateAddApiButton(); });
    actions.append(remove);
  }
  row.append(main, actions); return row;
}
async function apiCallDelete(slot) { return api(`/api/account/apis/${encodeURIComponent(slot)}`, { method: 'DELETE' }); }
function updateAddApiButton() {
  const count = $('api-fields').children.length;
  $('add-api-field').disabled = count >= 10;
  $('add-api-field').textContent = count >= 10 ? 'Límite de 10 APIs alcanzado' : '＋ Añadir otra API';
}
async function loadApiSettings() {
  const data = await api('/api/account/apis');
  const existing = (data.apis || []).map(item => ({ ...item, saved: true }));
  state.apiFields = existing;
  $('api-fields').replaceChildren();
  const rows = existing.length ? existing : [{ slot: 1, saved: false }];
  rows.forEach(item => $('api-fields').append(apiFieldRow(item)));
  updateAddApiButton();
  $('api-settings-status').textContent = existing.length ? `${existing.length} API(s) guardada(s). Las claves se mantienen ocultas.` : 'Todavía no hay APIs guardadas. Podés probar con una sola.';
}

async function loadManagedUsers() {
  const list = $('managed-users-list');
  const status = $('managed-users-status');
  status.textContent = 'Cargando cuentas…';
  try {
    const data = await api('/api/admin/users');
    const users = Array.isArray(data.users) ? data.users : [];
    list.replaceChildren();
    if (!users.length) {
      const empty = document.createElement('p');
      empty.className = 'muted tiny';
      empty.textContent = 'Todavía no hay cuentas registradas.';
      list.append(empty);
    }
    users.forEach(user => {
      const row = document.createElement('div');
      row.className = 'managed-user-row';
      const main = document.createElement('div');
      main.className = 'job-main';
      const name = document.createElement('div');
      name.className = 'job-name';
      name.textContent = user.username;
      const meta = document.createElement('div');
      meta.className = 'job-meta';
      meta.textContent = `${user.role === 'admin' ? 'Administrador' : 'Usuario'} · Alta: ${dateLabel(user.createdAt)}`;
      const accountStatus = document.createElement('span');
      accountStatus.className = `managed-user-status ${user.disabledAt ? 'disabled' : 'active'}`;
      accountStatus.textContent = user.disabledAt ? 'Desactivada' : 'Activa';
      main.append(name, meta, accountStatus);
      const identifiers = document.createElement('div');
      identifiers.className = 'managed-user-identifiers';
      const addIdentifier = (label, value) => {
        const line = document.createElement('div');
        line.className = 'job-meta';
        const text = document.createElement('span');
        text.textContent = `${label}: ${value || 'No disponible'}`;
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'mini-button';
        copy.textContent = 'Copiar';
        copy.disabled = !value;
        copy.addEventListener('click', async () => {
          try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
            await navigator.clipboard.writeText(String(value));
            status.textContent = `${label} copiado para ${user.username}.`;
          } catch {
            status.textContent = `No se pudo copiar automáticamente. ${label}: ${value}`;
          }
        });
        line.append(text, copy);
        identifiers.append(line);
      };
      addIdentifier('Código de cuenta', user.accountCode);
      addIdentifier('UUID', user.id);
      main.append(identifiers);
      row.append(main);
      if (user.role === 'user') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mini-button';
        button.textContent = user.disabledAt ? 'Reactivar' : 'Desactivar';
        button.addEventListener('click', async () => {
          const disabled = !user.disabledAt;
          const action = disabled ? 'desactivar' : 'reactivar';
          const consequence = disabled
            ? 'Sus sesiones se cerrarán y no podrá entrar hasta reactivarla.'
            : 'Podrá volver a iniciar sesión con su contraseña actual.';
          if (!confirm(`¿Querés ${action} la cuenta “${user.username}”? ${consequence}`)) return;
          button.disabled = true;
          status.textContent = `Actualizando la cuenta ${user.username}…`;
          try {
            await api(`/api/admin/users/${encodeURIComponent(user.id)}/status`, {
              method: 'PATCH',
              body: JSON.stringify({ disabled })
            });
            await loadManagedUsers();
            status.textContent = `Cuenta ${user.username} ${disabled ? 'desactivada' : 'reactivada'}.`;
          } catch (error) {
            status.textContent = error.message || 'No se pudo actualizar la cuenta.';
            button.disabled = false;
          }
        });
        row.append(button);
      }
      list.append(row);
    });
    if (users.length) status.textContent = `${users.length} cuenta(s) cargada(s). Las cuentas administradoras no se pueden desactivar desde este panel.`;
  } catch (error) {
    list.replaceChildren();
    status.textContent = error.message || 'No se pudieron cargar las cuentas.';
  }
}
$('open-account-key').addEventListener('click', async event => {
  event.stopPropagation(); const panel = $('account-key-panel'); const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening); $('open-account-key').setAttribute('aria-expanded', String(opening)); if (!opening) return;
  $('account-key-status').textContent = 'Cargando clave…';
  try { const data = await api('/api/account/key'); state.accountKey = data; $('account-code-value').value = data.accountCode; $('account-key-value').value = data.accessKey; $('account-key-value').type = state.accountKeyVisible ? 'text' : 'password'; $('account-key-status').textContent = 'Guardá tu identificador y tu clave en un lugar seguro.'; }
  catch (error) { $('account-key-status').textContent = error.message || 'No se pudo cargar la clave.'; }
});
$('toggle-account-key').addEventListener('click', event => { event.stopPropagation(); state.accountKeyVisible = !state.accountKeyVisible; $('account-key-value').type = state.accountKeyVisible ? 'text' : 'password'; $('toggle-account-key').setAttribute('aria-label', state.accountKeyVisible ? 'Ocultar clave' : 'Mostrar clave'); $('toggle-account-key').textContent = state.accountKeyVisible ? '◎' : '◉'; });
$('copy-account-code').addEventListener('click', async event => { event.stopPropagation(); try { await navigator.clipboard.writeText($('account-code-value').value); $('account-key-status').textContent = 'Código de cuenta copiado.'; } catch { $('account-key-status').textContent = 'No se pudo copiar automáticamente. Seleccioná el código y copialo manualmente.'; } });
$('copy-account-key').addEventListener('click', async event => { event.stopPropagation(); try { await navigator.clipboard.writeText($('account-key-value').value); $('account-key-status').textContent = 'Clave copiada al portapapeles.'; } catch { $('account-key-status').textContent = 'No se pudo copiar automáticamente. Podés revelarla y copiarla manualmente.'; } });
$('open-api-settings').addEventListener('click', async () => {
  $('account-menu-items').classList.add('hidden'); $('app-content').classList.add('hidden'); $('api-settings-panel').classList.remove('hidden');
  $('api-settings-status').textContent = 'Cargando tus APIs…';
  try { await loadApiSettings(); if (state.user?.role === 'admin') await loadManagedUsers(); } catch (error) { $('api-settings-status').textContent = error.message; }
});
$('refresh-managed-users').addEventListener('click', () => { void loadManagedUsers(); });
$('back-to-app').addEventListener('click', () => { $('api-settings-panel').classList.add('hidden'); $('app-content').classList.remove('hidden'); });
$('add-api-field').addEventListener('click', () => {
  const rows = $('api-fields').children;
  if (rows.length >= 10) return;
  const used = new Set(Array.from(rows, row => Number(row.dataset.slot)));
  let slot = 1; while (used.has(slot) && slot <= 10) slot++;
  if (slot <= 10) $('api-fields').append(apiFieldRow({ slot, saved: false }));
  updateAddApiButton();
});
$('save-api-settings').addEventListener('click', async () => {
  const button = $('save-api-settings'); button.disabled = true; $('api-settings-status').textContent = 'Guardando claves cifradas…';
  try {
    const apis = Array.from($('api-fields').children).map(row => {
      const providerValue = row.querySelector('.api-provider-select').value;
      const customUrl = row.querySelector('.api-custom-url-input').value.trim();
      return {
        slot: Number(row.dataset.slot), label: row.dataset.label || `API ${row.dataset.slot}`,
        baseUrl: providerValue === CUSTOM_PROVIDER_VALUE ? customUrl : providerValue || row.dataset.baseUrl || '',
        models: {
          reasoning: row.querySelector('[data-model-role="reasoning"]').value.trim(),
          coding: row.querySelector('[data-model-role="coding"]').value.trim(),
          validation: row.querySelector('[data-model-role="validation"]').value.trim()
        },
        apiKey: row.querySelector('.api-key-input').value.trim()
      };
    });
    await api('/api/account/apis', { method: 'PUT', body: JSON.stringify({ apis }) });
    await loadApiSettings(); $('api-settings-status').textContent = 'Cambios guardados. Las claves permanecen cifradas y ocultas.';
  } catch (error) { $('api-settings-status').textContent = error.message; }
  finally { button.disabled = false; }
});
$('change-password-form').addEventListener('submit', async event => {
  event.preventDefault();
  const currentPassword = $('current-password').value;
  const newPassword = $('new-password').value;
  const confirmPassword = $('confirm-new-password').value;
  const status = $('password-settings-status');
  const button = $('change-password-submit');
  if (newPassword !== confirmPassword) {
    status.textContent = 'La nueva contraseña y su repetición no coinciden.';
    $('confirm-new-password').focus();
    return;
  }
  if (newPassword.length < 12 || newPassword.length > 512) {
    status.textContent = 'La nueva contraseña debe tener entre 12 y 512 caracteres.';
    return;
  }
  button.disabled = true;
  status.textContent = 'Actualizando contraseña y revocando las demás sesiones…';
  try {
    const result = await api('/api/account/password', {
      method: 'PATCH',
      body: JSON.stringify({ currentPassword, newPassword })
    });
    if (!result.token) throw new Error('El servidor no devolvió una sesión renovada.');
    state.accessKey = result.token;
    sessionStorage.setItem('swarm-session-token', result.token);
    startTaskEventStream();
    $('change-password-form').reset();
    status.textContent = 'Contraseña actualizada. Las demás sesiones fueron cerradas y esta sesión sigue activa.';
  } catch (error) {
    status.textContent = error.message || 'No se pudo cambiar la contraseña.';
  } finally {
    button.disabled = false;
  }
});

$('logout-button').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  stopTaskEventStream(); state.accessKey = ''; state.user = null; sessionStorage.removeItem('swarm-session-token'); location.href = '/?login=1';
});
$('create-invite').addEventListener('click', async () => {
  const button = $('create-invite'); button.disabled = true; $('invite-status').textContent = 'Creando invitación de un solo uso…';
  try {
    const data = await api('/api/admin/invites', { method: 'POST', body: JSON.stringify({ hours: 72 }) });
    const url = `${location.origin}/?invite=${encodeURIComponent(data.code)}`;
    $('invite-result').classList.remove('hidden'); $('invite-result').replaceChildren();
    const note = document.createElement('p'); note.textContent = 'Compartí este enlace con tu amigo. Caduca en 72 horas y solo puede usarse una vez.';
    const link = document.createElement('a'); link.href = url; link.textContent = url; link.className = 'invite-code';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'button button-secondary'; copy.textContent = 'Copiar invitación';
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(url); $('invite-status').textContent = 'Invitación copiada.'; } catch { $('invite-status').textContent = 'Seleccioná y copiá el enlace mostrado.'; } });
    $('invite-result').append(note, link, copy); $('invite-status').textContent = 'Invitación creada.';
  } catch (error) { $('invite-status').textContent = error.message; }
  finally { button.disabled = false; }
});


function syncRegistrationAvailability() {
  const invite = $('register-invite').value.trim();
  const submit = $('register-form').querySelector('button[type="submit"]');
  submit.disabled = invite.length < 20;
  // The invite gate owns its own validation message. Do not show a registration warning
  // while the user is merely entering a code on the first screen.
  if ($('register-form').classList.contains('hidden')) return;
  $('register-status').textContent = invite.length < 20
    ? 'Necesitás un enlace o código de invitación válido. Crear una cuenta nunca otorga permisos de administrador.'
    : '';
}
$('show-register').addEventListener('click', () => {
  $('register-form').classList.toggle('hidden');
  const invite = new URLSearchParams(location.search).get('invite');
  if (invite) $('register-invite').value = invite;
  syncRegistrationAvailability();
});
$('register-invite').addEventListener('input', syncRegistrationAvailability);
$('register-form').addEventListener('submit', async event => {
  event.preventDefault();
  const inviteCode = $('register-invite').value.trim();
  if (inviteCode.length < 20) {
    $('register-status').textContent = 'No se puede crear una cuenta sin invitación válida.';
    syncRegistrationAvailability();
    return;
  }
  const button = $('register-form').querySelector('button[type="submit"]'); button.disabled = true;
  $('register-status').textContent = 'Validando la invitación y creando una cuenta de usuario…';
  try {
    const body = { invite: inviteCode, username: $('register-username').value.trim().toLowerCase(), password: $('register-password').value };
    const response = await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'No se pudo crear la cuenta.');
    state.accessKey = data.token; state.user = data.user;
    sessionStorage.setItem('swarm-session-token', state.accessKey);
    $('register-password').value = ''; $('access-status').textContent = '';
    await enterApp();
  } catch (error) { $('register-status').textContent = error.message; }
  finally { button.disabled = $('register-invite').value.trim().length < 20; }
});
fetch('/api/auth/bootstrap-status').then(response => response.json()).then(data => {
  if (data.initialized) $('access-status').textContent = 'Entrá con tu usuario y contraseña. El registro está disponible solo con invitación.';
}).catch(() => {});
if (new URLSearchParams(location.search).has('invite')) {
  $('register-form').classList.remove('hidden');
  $('register-invite').value = new URLSearchParams(location.search).get('invite') || '';
}
syncRegistrationAvailability();

const objectiveInput = $('objective');
function resizeObjectiveInput() {
  objectiveInput.style.height = 'auto';
  const nextHeight = Math.min(Math.max(objectiveInput.scrollHeight, 44), 120);
  objectiveInput.style.height = nextHeight + 'px';
  objectiveInput.style.overflowY = objectiveInput.scrollHeight > 120 ? 'auto' : 'hidden';
}
objectiveInput.addEventListener('input', resizeObjectiveInput);
objectiveInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('job-form').requestSubmit();
  }
});
resizeObjectiveInput();

$('job-form').addEventListener('submit', async event => {
  event.preventDefault();
  const message = $('objective').value.trim();
  if (!message) return;
  const button = $('submit-job');
  const target = $('chat-target')?.value || 'global';
  button.disabled = true; button.textContent = 'Enviando…';
  try {
    if (target !== 'global') {
      if (!state.currentDetailId) throw new Error('Primero iniciá o abrí una tarea global; después podés hablar directamente con un agente.');
      const result = await api(`/api/jobs/${encodeURIComponent(state.currentDetailId)}/reply`, { method: 'POST', body: JSON.stringify({ agent: target, message }) });
      $('objective').value = ''; resizeObjectiveInput();
      $('job-submit-status').textContent = `Mensaje enviado a ${result.agent || target}; la respuesta aparecerá en esta conversación.`;
      await updateSelectedDetail();
    } else {
      $('job-submit-status').textContent = 'Enviando la orden global al equipo…';
      const tokenBudget = Number($('new-task-budget')?.value) || 1000000;
      const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ objective: message, tokenBudget }) });
      $('objective').value = ''; resizeObjectiveInput();
      $('job-submit-status').textContent = `Orden recibida: ${job.title || 'Nueva tarea'}. Abriendo la conversación…`;
      await showDetail(job.id); await refresh();
    }
  } catch (error) { $('job-submit-status').textContent = `No se pudo enviar: ${error.message}`; }
  finally { button.disabled = false; button.textContent = 'Enviar ↗'; }
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
      return `<div class="history-row"><div class="job-main"><div class="job-name" title="${escapeHtml(job.title || `Tarea ${job.id.slice(0,8)}`)}">${escapeHtml(job.title || `Tarea ${job.id.slice(0,8)}`)}</div><div class="job-meta">${escapeHtml(statusNames[job.status] || job.status)} · ${detail}</div>${progress}</div><button class="mini-button" data-history="${escapeHtml(job.id)}">Abrir</button></div>`;
    }).join('') || '<p class="muted tiny">Sin registros.</p>';
    list.querySelectorAll('[data-history]').forEach(button => button.addEventListener('click', () => { closeHistoryDrawer(); showDetail(button.dataset.history); }));
  } catch (error) { alert(error.message); }
});
function closeHistoryDrawer() {
  const drawer = $('history-drawer');
  if (!drawer) return;
  drawer.classList.add('hidden');
  drawer.setAttribute('aria-hidden', 'true');
  $('open-history-menu')?.setAttribute('aria-expanded', 'false');
  state.historyShown = false;
  $('history-list')?.classList.add('hidden');
  if ($('show-history')) $('show-history').innerHTML = 'Ver registros <span>→</span>';
}
function openHistoryDrawer() {
  const drawer = $('history-drawer');
  if (!drawer) return;
  if (!drawer.classList.contains('hidden')) { closeHistoryDrawer(); return; }
  $('files-drawer')?.classList.add('hidden');
  $('files-drawer')?.setAttribute('aria-hidden', 'true');
  drawer.classList.remove('hidden');
  drawer.setAttribute('aria-hidden', 'false');
  $('open-history-menu')?.setAttribute('aria-expanded', 'true');
  if (!state.historyShown) $('show-history')?.click();
}
$('copy-detail').addEventListener('click', async () => {
  const button = $('copy-detail'); const content = $('detail-content').textContent || '';
  if (!content.trim()) { $('copy-status').textContent = 'No hay diagnóstico para copiar.'; return; }
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(content);
    else { const area = document.createElement('textarea'); area.value = content; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0'; document.body.appendChild(area); area.select(); const copied = document.execCommand('copy'); area.remove(); if (!copied) throw new Error('El navegador no permitió copiar.'); }
    $('copy-status').textContent = 'Diagnóstico copiado. No incluye claves secretas.'; button.textContent = 'Copiado ✓';
  } catch { $('copy-status').textContent = 'No se pudo copiar automáticamente. Mantené pulsado el texto del diagnóstico para seleccionarlo.'; }
});
$('agent-memory-select').addEventListener('change', () => {
  const selected = Object.values(state.agentDocuments || {}).find(doc => doc.agent === $('agent-memory-select').value);
  $('agent-memory-content').textContent = selected?.markdown || 'Todavía no hay checkpoints registrados para agentes.';
});
$('improvement-vote-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.currentDetailId) { $('improvement-vote-status').textContent = 'Primero abrí una tarea del historial.'; return; }
  const proposal = $('improvement-vote-proposal').value.trim();
  if (!proposal) return;
  const button = $('improvement-vote-submit');
  button.disabled = true;
  button.textContent = 'Reuniendo votos…';
  $('improvement-vote-status').textContent = 'Votación iniciada en segundo plano. La tarea principal continúa sin interrupción; consume tokens adicionales.';
  try {
    const response = await api(`/api/jobs/${encodeURIComponent(state.currentDetailId)}/vote-improvement`, {
      method: 'POST', body: JSON.stringify({ proposal })
    });
    $('improvement-vote-status').textContent = response.reused
      ? (response.started ? 'Esa votación ya está en curso; la tarea continúa sin pausa.' : 'Ya existía una votación para esa propuesta; se recuperó sin consumir tokens.')
      : 'Votación iniciada. Podés seguir trabajando mientras los agentes responden.';
    if (!response.reused) $('improvement-vote-proposal').value = '';
    await updateSelectedDetail();
    await loadJobs();
  } catch (error) {
    $('improvement-vote-status').textContent = `No se pudo completar la votación: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = 'Convocar votación en segundo plano ↗';
  }
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
$('close-detail').addEventListener('click', () => { $('detail-panel').classList.add('hidden'); $('welcome-chat')?.classList.remove('hidden'); state.currentDetailId = null; state.lastJobStatus = null; });

function chatStatusLabel(status) {
  return ({ pending: 'En cola · se recuperará al reconectar', running: 'La IA está respondiendo…', completed: '', failed: 'No se pudo completar. Podés enviar otro mensaje para reintentar.' })[status] ?? '';
}
function renderChatList() {
  const list = $('chats-list');
  if (!list) return;
  if (!state.chats.length) {
    list.innerHTML = '<div class="empty-state"><p>Todavía no hay chats.</p><span class="muted tiny">Creá uno para empezar.</span></div>';
    return;
  }
  list.innerHTML = state.chats.map(chat => `<div class="chat-list-item ${chat.id === state.currentChatId ? 'selected' : ''}">
    <button class="chat-list-open" type="button" data-chat-open="${escapeHtml(chat.id)}"><span class="chat-list-title">${escapeHtml(chat.title || 'Nuevo chat')}</span><span class="chat-list-meta">${escapeHtml(dateLabel(chat.updatedAt))}</span></button>
    <button class="mini-button" type="button" data-chat-rename="${escapeHtml(chat.id)}" aria-label="Renombrar ${escapeHtml(chat.title || 'chat')}" title="Renombrar">✎</button>
    <button class="mini-button" type="button" data-chat-archive="${escapeHtml(chat.id)}" aria-label="Archivar ${escapeHtml(chat.title || 'chat')}" title="Archivar">×</button>
  </div>`).join('');
  list.querySelectorAll('[data-chat-open]').forEach(button => button.addEventListener('click', () => { void selectChat(button.dataset.chatOpen); }));
  list.querySelectorAll('[data-chat-rename]').forEach(button => button.addEventListener('click', () => { void renameChat(button.dataset.chatRename); }));
  list.querySelectorAll('[data-chat-archive]').forEach(button => button.addEventListener('click', () => { void archiveChat(button.dataset.chatArchive); }));
}
async function loadChats() {
  try {
    const data = await api('/api/chats?limit=100&offset=0&archived=false');
    state.chats = data.chats || [];
    renderChatList();
    if (state.currentChatId && !state.chats.some(chat => chat.id === state.currentChatId)) {
      state.currentChatId = null; state.currentChat = null; state.chatMessages = [];
      renderChatMessages();
    }
  } catch (error) {
    if ($('chats-status')) $('chats-status').textContent = `No se pudieron cargar los chats: ${error.message}`;
  }
}
function renderChatMessages() {
  const target = $('chat-messages');
  if (!target) return;
  const wasNearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
  if (!state.currentChatId) {
    target.innerHTML = '<div class="empty-state"><p>Creá un chat nuevo o elegí uno de la lista.</p></div>';
  } else if (!state.chatMessages.length) {
    target.innerHTML = '<div class="empty-state"><p>Este chat está listo.</p><span class="muted tiny">Escribí el primer mensaje abajo.</span></div>';
  } else {
    target.innerHTML = state.chatMessages.map(message => {
      const status = message.role === 'user' ? chatStatusLabel(message.metadata?.turnStatus) : '';
      return `<article class="chat-message ${message.role === 'user' ? 'user' : 'assistant'}"><span class="chat-message-role">${message.role === 'user' ? 'Vos' : 'Swarm · asistente'}</span><p class="chat-message-content">${escapeHtml(message.content)}</p>${status ? `<span class="chat-turn-status">${escapeHtml(status)}</span>` : ''}</article>`;
    }).join('');
  }
  if (wasNearBottom) target.scrollTop = target.scrollHeight;
  const enabled = Boolean(state.currentChatId);
  $('chat-message-input').disabled = !enabled;
  $('chat-message-send').disabled = !enabled;
  $('rename-chat-button').disabled = !enabled;
  $('archive-chat-button').disabled = !enabled;
  $('selected-chat-title').textContent = state.currentChat?.title || 'Elegí un chat';
}

async function recoverPendingChatTurns(chatId) {
  const deadline = Date.now() + 180000;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  while (state.currentChatId === chatId && Date.now() < deadline) {
    const pending = state.chatMessages.filter(message =>
      message.role === 'user' && ['pending','running'].includes(message.metadata?.turnStatus) && message.metadata?.turnId
    );
    if (!pending.length) return;
    for (const message of pending) {
      if (state.currentChatId !== chatId) return;
      try {
        await api(`/api/chats/${encodeURIComponent(chatId)}/turns/${encodeURIComponent(message.metadata.turnId)}`);
      } catch (error) {
        if ($('chats-status')) $('chats-status').textContent = `Intentando recuperar un turno guardado: ${error.message}`;
      }
    }
    await delay(1800);
    try { await loadChatMessages(); } catch {}
  }
  if (state.currentChatId === chatId && $('chats-status')) {
    $('chats-status').textContent = 'El turno sigue guardado. Actualizá el chat en unos instantes para consultar su estado.';
  }
}
async function loadChatMessages() {
  if (!state.currentChatId) return;
  const chatId = state.currentChatId;
  const data = await api(`/api/chats/${encodeURIComponent(chatId)}/messages?limit=100`);
  if (state.currentChatId !== chatId) return;
  state.chatMessages = data.messages || [];
  renderChatMessages();
}
async function selectChat(chatId) {
  try {
    const data = await api(`/api/chats/${encodeURIComponent(chatId)}`);
    state.currentChatId = chatId;
    state.currentChat = data.chat;
    await loadChatMessages();
    renderChatList();
    renderChatMessages();
    void recoverPendingChatTurns(chatId);
    if ($('chats-status')) $('chats-status').textContent = 'Chat guardado en la nube. Los mensajes se recuperan al reconectar.';
  } catch (error) {
    if ($('chats-status')) $('chats-status').textContent = `No se pudo abrir el chat: ${error.message}`;
  }
}
async function createNewChat() {
  const button = $('new-chat-button');
  button.disabled = true;
  try {
    const data = await api('/api/chats', { method: 'POST', body: JSON.stringify({}) });
    await loadChats();
    await selectChat(data.chat.id);
    $('chat-message-input').focus();
    if ($('chats-status')) $('chats-status').textContent = 'Chat creado.';
  } catch (error) {
    if ($('chats-status')) $('chats-status').textContent = `No se pudo crear el chat: ${error.message}`;
  } finally { button.disabled = false; }
}
async function renameChat(chatId) {
  const chat = state.chats.find(item => item.id === chatId);
  const title = window.prompt('Nuevo nombre del chat:', chat?.title || 'Nuevo chat');
  if (title === null) return;
  try {
    const data = await api(`/api/chats/${encodeURIComponent(chatId)}`, { method: 'PATCH', body: JSON.stringify({ title }) });
    if (state.currentChatId === chatId) state.currentChat = data.chat;
    await loadChats(); renderChatMessages();
    if ($('chats-status')) $('chats-status').textContent = 'Nombre actualizado.';
  } catch (error) { if ($('chats-status')) $('chats-status').textContent = `No se pudo renombrar: ${error.message}`; }
}
async function archiveChat(chatId) {
  if (!window.confirm('¿Archivar este chat? No se borrarán sus mensajes.')) return;
  try {
    await api(`/api/chats/${encodeURIComponent(chatId)}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
    if (state.currentChatId === chatId) { state.currentChatId = null; state.currentChat = null; state.chatMessages = []; renderChatMessages(); }
    await loadChats();
    if ($('chats-status')) $('chats-status').textContent = 'Chat archivado. No se borró.';
  } catch (error) { if ($('chats-status')) $('chats-status').textContent = `No se pudo archivar: ${error.message}`; }
}
function openChatsDrawer() {
  $('files-drawer')?.classList.add('hidden');
  $('history-drawer')?.classList.add('hidden');
  const drawer = $('chats-drawer');
  drawer.classList.remove('hidden');
  drawer.setAttribute('aria-hidden', 'false');
  $('open-chats-menu')?.setAttribute('aria-expanded', 'true');
  void loadChats();
  if (state.currentChatId) void loadChatMessages().catch(() => {});
}
function closeChatsDrawer() {
  const drawer = $('chats-drawer');
  drawer.classList.add('hidden');
  drawer.setAttribute('aria-hidden', 'true');
  $('open-chats-menu')?.setAttribute('aria-expanded', 'false');
}
$('open-chats-menu').addEventListener('click', () => { $('account-menu-items').classList.add('hidden'); $('account-menu-toggle').setAttribute('aria-expanded', 'false'); openChatsDrawer(); });
$('close-chats-drawer').addEventListener('click', closeChatsDrawer);
$('new-chat-button').addEventListener('click', () => { void createNewChat(); });
$('refresh-chats-button').addEventListener('click', () => { void loadChats(); if (state.currentChatId) void loadChatMessages().catch(error => { $('chats-status').textContent = error.message; }); });
$('rename-chat-button').addEventListener('click', () => { if (state.currentChatId) void renameChat(state.currentChatId); });
$('archive-chat-button').addEventListener('click', () => { if (state.currentChatId) void archiveChat(state.currentChatId); });
$('chat-message-form').addEventListener('submit', async event => {
  event.preventDefault();
  const chatId = state.currentChatId;
  const input = $('chat-message-input');
  const message = input.value.trim();
  if (!chatId || !message) return;
  const button = $('chat-message-send');
  const idempotencyKey = crypto.randomUUID();
  button.disabled = true; input.disabled = true; button.textContent = 'Enviando…';
  if ($('chats-status')) $('chats-status').textContent = 'Guardando el mensaje y conectando con la IA…';
  try {
    const created = await api(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ message })
    });
    input.value = '';
    await loadChatMessages();
    const turnId = created.turn?.id;
    if (!turnId) throw new Error('El servidor no devolvió el identificador del turno.');
    const startedAt = Date.now();
    let status = created.turn.status || 'pending';
    while (state.currentChatId === chatId && Date.now() - startedAt < 240000 && !['completed','failed'].includes(status)) {
      await new Promise(resolve => setTimeout(resolve, 1800));
      const stateResult = await api(`/api/chats/${encodeURIComponent(chatId)}/turns/${encodeURIComponent(turnId)}`);
      status = stateResult.turn?.status || status;
      await loadChatMessages();
    }
    await loadChats();
    if (status === 'completed') {
      if ($('chats-status')) $('chats-status').textContent = 'Respuesta guardada. Podés seguir conversando.';
    } else if (status === 'failed') {
      const turnState = await api(`/api/chats/${encodeURIComponent(chatId)}/turns/${encodeURIComponent(turnId)}`);
      if ($('chats-status')) $('chats-status').textContent = `La IA no pudo responder: ${turnState.turn?.lastError || 'fallo temporal'}. Enviá otro mensaje para reintentar.`;
    } else if ($('chats-status')) $('chats-status').textContent = 'El turno sigue guardado y puede continuar en segundo plano. Podés cerrar y volver al chat.';
  } catch (error) {
    if ($('chats-status')) $('chats-status').textContent = `No se pudo enviar el mensaje: ${error.message}. Si quedó guardado, actualizá el chat para recuperar el estado.`;
    await loadChatMessages().catch(() => {});
  } finally {
    button.disabled = !state.currentChatId; input.disabled = !state.currentChatId; button.textContent = 'Enviar ↗';
  }
});

async function boot() {
  try { const health = await fetch('/healthz'); if (!health.ok) throw new Error(); setConnection(true, 'Puente disponible'); }
  catch { setConnection(false, 'Puente no disponible'); }
  if (!state.accessKey) { showAccess(); return; }
  try { await enterApp(); } catch (error) { showAccess(); $('access-status').textContent = error.message; }
}
// Unificamos los archivos en el cajón inferior sin duplicar ni reconstruir el contenido.
const artifactsPanel = $('artifacts-panel');
if (artifactsPanel && $('files-drawer-slot')) $('files-drawer-slot').append(artifactsPanel);
const historyPanel = document.querySelector('#dashboard-grid .history-panel') || document.querySelector('.history-panel');
if (historyPanel && $('history-drawer-slot')) $('history-drawer-slot').append(historyPanel);
$('account-menu-toggle').setAttribute('aria-expanded', 'false');
$('open-history-menu').addEventListener('click', () => {
  $('account-menu-items').classList.add('hidden');
  $('account-menu-toggle').setAttribute('aria-expanded', 'false');
  openHistoryDrawer();
});
$('close-history-drawer').addEventListener('click', closeHistoryDrawer);
$('account-menu-toggle').addEventListener('click', event => {
  event.preventDefault();
  event.stopPropagation();
  const items = $('account-menu-items');
  const opening = items.classList.contains('hidden');
  items.classList.toggle('hidden', !opening);
  $('account-menu-toggle').setAttribute('aria-expanded', String(opening));
  if (opening) items.querySelector('button:not(.hidden)')?.focus({ preventScroll: true });
});
$('account-menu-items').addEventListener('click', event => {
  if (event.target.closest('button') && !event.target.closest('#open-account-key, #toggle-account-key, #copy-account-key')) {
    $('account-menu-items').classList.add('hidden');
    $('account-menu-toggle').setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('click', event => {
  if (!$('account-menu')?.contains(event.target)) {
    $('account-menu-items')?.classList.add('hidden');
    $('account-menu-toggle')?.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    $('account-menu-items')?.classList.add('hidden');
    $('account-menu-toggle')?.setAttribute('aria-expanded', 'false');
    $('files-drawer')?.classList.add('hidden');
    $('files-drawer')?.setAttribute('aria-hidden', 'true');
    closeHistoryDrawer();
  }
});
$('open-technical-diagnostic').addEventListener('click', () => {
  $('account-menu-items').classList.add('hidden');
  if (!state.currentDetailId) { $('job-submit-status').textContent = 'Abrí una tarea para consultar su diagnóstico técnico.'; return; }
  const diagnostic = document.querySelector('.diagnostic');
  if (diagnostic) { diagnostic.open = true; diagnostic.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
});
$('files-menu-toggle').addEventListener('click', () => {
  const opening = $('files-drawer').classList.contains('hidden');
  $('files-drawer').classList.toggle('hidden', !opening);
  $('files-drawer').setAttribute('aria-hidden', String(!opening));
  if (opening) {
    closeHistoryDrawer();
    const count = $('artifacts-count')?.textContent || '0 archivos';
    $('files-drawer-status').textContent = state.currentDetailId ? count + ' · pertenecen a la tarea abierta.' : 'Abrí una tarea para ver sus archivos.';
  }
});
$('close-files-drawer').addEventListener('click', () => { $('files-drawer').classList.add('hidden'); $('files-drawer').setAttribute('aria-hidden', 'true'); });
$('files-download-button').addEventListener('click', () => {
  const button = $('download-bundle');
  if (!button || button.disabled) { $('files-drawer-status').textContent = 'Todavía no hay archivos guardados para empaquetar.'; return; }
  button.click();
});
$('files-preview-button').addEventListener('click', () => {
  const preview = $('artifacts-list')?.querySelector('[data-preview-index]');
  if (!preview) { $('files-drawer-status').textContent = 'Todavía no hay un HTML listo para previsualizar.'; return; }
  preview.click();
});

function initFloatingArtifactPreview() {
  const preview = $('artifact-preview');
  if (!preview || preview.dataset.floatingReady === 'true') return;
  preview.dataset.floatingReady = 'true'; document.body.append(preview);
  preview.classList.add('preview-window'); preview.setAttribute('role', 'dialog'); preview.setAttribute('aria-label', 'Vista previa del artefacto');
  const header = preview.querySelector('.section-head'), close = $('close-artifact-preview');
  if (!header || !close) return;
  const controls = document.createElement('div'); controls.className = 'preview-window-controls';
  const minimize = document.createElement('button'); minimize.type = 'button'; minimize.className = 'icon-button'; minimize.textContent = '−';
  minimize.setAttribute('aria-label', 'Minimizar vista previa'); minimize.title = 'Minimizar';
  const maximize = document.createElement('button'); maximize.type = 'button'; maximize.className = 'icon-button'; maximize.textContent = '⛶';
  maximize.setAttribute('aria-label', 'Pantalla completa'); maximize.title = 'Pantalla completa';
  close.textContent = '×'; close.setAttribute('aria-label', 'Cerrar vista previa'); close.title = 'Cerrar';
  controls.append(minimize, maximize, close); header.append(controls);
  const launcher = document.createElement('button'); launcher.type = 'button'; launcher.className = 'preview-window-launcher hidden';
  launcher.textContent = '▣ Vista previa'; launcher.setAttribute('aria-label', 'Restaurar vista previa'); launcher.title = 'Arrastrá para mover · tocá para restaurar'; document.body.append(launcher);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const placeDefault = () => { preview.style.left = Math.max(8, Math.round((window.innerWidth - Math.min(900, window.innerWidth - 24))/2))+'px'; preview.style.top = Math.max(8, Math.round(window.innerHeight*.06))+'px'; preview.style.right='auto'; preview.style.bottom='auto'; };
  const openWindow = () => { preview.classList.remove('hidden','preview-minimized'); launcher.classList.add('hidden'); if(!preview.dataset.positioned) placeDefault(); preview.dataset.positioned='true'; };
  minimize.addEventListener('click', () => { preview.classList.add('preview-minimized'); launcher.classList.remove('hidden'); launcher.style.left=preview.style.left||'16px'; launcher.style.top=preview.style.top||'16px'; launcher.style.right='auto'; launcher.style.bottom='auto'; });
  maximize.addEventListener('click', () => { const max=preview.classList.toggle('preview-maximized'); maximize.textContent=max?'❐':'⛶'; maximize.title=max?'Restaurar tamaño':'Pantalla completa'; maximize.setAttribute('aria-label',max?'Restaurar tamaño':'Pantalla completa'); if(max){preview.dataset.restoreLeft=preview.style.left||'';preview.dataset.restoreTop=preview.style.top||'';preview.style.left='';preview.style.top='';preview.style.right='';preview.style.bottom='';}else{preview.style.left=preview.dataset.restoreLeft||'';preview.style.top=preview.dataset.restoreTop||'';preview.style.right='auto';preview.style.bottom='auto';} });
  close.addEventListener('click', () => { preview.classList.remove('preview-maximized','preview-minimized'); launcher.classList.add('hidden'); preview.style.left='';preview.style.top='';preview.style.right='';preview.style.bottom='';preview.dataset.positioned='';maximize.textContent='⛶'; });
  const drag=(el,handle,onEnd=()=>{})=>{let sx=0,sy=0,ox=0,oy=0,moved=false,pid=null;
    handle.addEventListener('pointerdown',e=>{if(e.target.closest('button')||(el===preview&&preview.classList.contains('preview-maximized')))return;pid=e.pointerId;sx=e.clientX;sy=e.clientY;const r=el.getBoundingClientRect();ox=r.left;oy=r.top;moved=false;handle.setPointerCapture?.(pid);e.preventDefault();});
    handle.addEventListener('pointermove',e=>{if(pid!==e.pointerId)return;const dx=e.clientX-sx,dy=e.clientY-sy;if(Math.abs(dx)+Math.abs(dy)>5)moved=true;if(!moved)return;const r=el.getBoundingClientRect();el.style.left=clamp(ox+dx,0,Math.max(0,window.innerWidth-Math.min(72,r.width)))+'px';el.style.top=clamp(oy+dy,0,Math.max(0,window.innerHeight-Math.min(48,r.height)))+'px';el.style.right='auto';el.style.bottom='auto';});
    const end=e=>{if(pid!==e.pointerId)return;pid=null;onEnd(moved);};handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);};
  drag(preview,header);let launcherMoved=false;drag(launcher,launcher,m=>{launcherMoved=m;});
  launcher.addEventListener('click',e=>{if(launcherMoved){launcherMoved=false;e.preventDefault();return;}openWindow();});
  window.addEventListener('resize',()=>{if(preview.classList.contains('hidden')||preview.classList.contains('preview-minimized')||preview.classList.contains('preview-maximized'))return;const r=preview.getBoundingClientRect();preview.style.left=clamp(r.left,0,Math.max(0,window.innerWidth-80))+'px';preview.style.top=clamp(r.top,0,Math.max(0,window.innerHeight-60))+'px';},{passive:true});
  window.SwarmPreviewWindow={open:openWindow,minimize:()=>minimize.click(),close:()=>close.click()};
}

function syncViewportAfterChange({ resetScroll = false } = {}) {
  const viewport = window.visualViewport;
  const viewportHeight = viewport?.height || window.innerHeight;
  if (Number.isFinite(viewportHeight) && viewportHeight > 0) {
    document.documentElement.style.setProperty('--swarm-viewport-height', `${Math.round(viewportHeight)}px`);
    document.documentElement.style.setProperty('--swarm-viewport-top', `${Math.max(0, Math.round(viewport?.offsetTop || 0))}px`);
  }
  // Resizing the visual viewport also happens when the mobile keyboard opens.
  // Only reset the document position after an actual orientation change.
  if (resetScroll && !document.body.classList.contains('auth-gate')) {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }
}
let viewportSyncScheduled = false;
let viewportResetScrollPending = false;
function scheduleViewportSync(resetScroll = false) {
  viewportResetScrollPending = viewportResetScrollPending || resetScroll;
  if (viewportSyncScheduled) return;
  viewportSyncScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const shouldResetScroll = viewportResetScrollPending;
    viewportResetScrollPending = false;
    viewportSyncScheduled = false;
    syncViewportAfterChange({ resetScroll: shouldResetScroll });
  }));
}
window.addEventListener('resize', () => scheduleViewportSync(), { passive: true });
window.addEventListener('orientationchange', () => scheduleViewportSync(true), { passive: true });
window.visualViewport?.addEventListener('resize', () => scheduleViewportSync(), { passive: true });
syncViewportAfterChange();
initFloatingArtifactPreview();
boot();