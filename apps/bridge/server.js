import { timingSafeEqual, randomBytes } from 'node:crypto';
import 'dotenv/config';
import express from 'express';
import { pool, hashPassword, verifyPassword, createSession, findSession, revokeSession, importLegacyApiKeys, listApiKeys, saveApiKeys, deleteApiKey, createInvite, registerFromInvite } from './services/accountStore.js';
import { createZip } from './services/zipBundle.js';
import { parsePreviewZip, previewMimeType } from './services/zipPreview.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const WORKER_BASE_URL = (process.env.WORKER_BASE_URL || '').replace(/\/$/, '');
const WORKER_SHARED_SECRET = process.env.WORKER_SHARED_SECRET || '';
const APP_ACCESS_KEY = process.env.APP_ACCESS_KEY || '';
const IS_PROD = process.env.NODE_ENV === 'production';
const failedAuth = new Map();
const jobCreateWindows = new Map();
const previewSessions = new Map();
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, '../web/public');

if (IS_PROD && (!WORKER_BASE_URL || WORKER_SHARED_SECRET.length < 32 || APP_ACCESS_KEY.length < 32 || /replace-with|your-/i.test(WORKER_SHARED_SECRET + APP_ACCESS_KEY))) {
  throw new Error('En producción configura WORKER_BASE_URL y genera WORKER_SHARED_SECRET y APP_ACCESS_KEY aleatorios de al menos 32 caracteres.');
}
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use(express.static(webDir, { etag: true, maxAge: IS_PROD ? '1h' : 0 }));
app.get('/healthz', (_req, res) => res.json({ ok: true, role: 'bridge', workerConfigured: Boolean(WORKER_BASE_URL && WORKER_SHARED_SECRET) }));
function windowLimit(map, key, limit, windowMs) {
  const now = Date.now();
  if (map.size > 5000) for (const [itemKey, item] of map) if (item.until <= now) map.delete(itemKey);
  let item = map.get(key);
  if (!item || item.until <= now) item = { count: 0, until: now + windowMs };
  item.count += 1; map.set(key, item);
  return { allowed: item.count <= limit, retryAfter: Math.max(1, Math.ceil((item.until - now) / 1000)) };
}
app.get('/api/auth/bootstrap-status', async (_req, res) => {
  try { const { rows } = await pool.query('SELECT EXISTS(SELECT 1 FROM app_users) AS initialized'); res.json({ initialized: rows[0].initialized }); }
  catch { res.status(503).json({ error: 'No se pudo consultar el estado de la cuenta.' }); }
});
app.post('/api/auth/login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const limit = windowLimit(failedAuth, ip, 8, 15 * 60 * 1000);
  if (!limit.allowed) { res.set('Retry-After', String(limit.retryAfter)); return res.status(429).json({ error: 'Demasiados intentos. Probá más tarde.' }); }
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username) || password.length < 12 || password.length > 512) return res.status(400).json({ error: 'Ingresá usuario y contraseña válidos.' });
  try {
    let { rows } = await pool.query('SELECT id,username,password_hash,role FROM app_users WHERE username=$1 AND disabled_at IS NULL', [username]);
    let user = rows[0];
    if (!user) {
      const count = await pool.query('SELECT count(*)::int AS total FROM app_users');
      if (count.rows[0].total !== 0 || username !== 'admin' || !APP_ACCESS_KEY || !safeEqual(password, APP_ACCESS_KEY)) {
        return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
      }
      const created = await pool.query("INSERT INTO app_users(username,password_hash,role) VALUES('admin',$1,'admin') RETURNING id,username,password_hash,role", [hashPassword(password)]);
      user = created.rows[0];
      const imported = await importLegacyApiKeys(user.id);
      console.info('[bridge][legacy_api_migration]', JSON.stringify({ userId: user.id, imported }));
    } else if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }
    failedAuth.delete(ip);
    const token = await createSession(user.id);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) { console.error('[bridge][login_error]', error?.code || 'internal'); res.status(503).json({ error: 'No se pudo iniciar sesión. Revisá la conexión de la base de datos.' }); }
});
app.post('/api/auth/register', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const invite = typeof req.body?.invite === 'string' ? req.body.invite.trim() : '';
  if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username) || password.length < 12 || password.length > 512 || invite.length < 20 || invite.length > 200) return res.status(400).json({ error: 'Usuario, contraseña o invitación inválidos.' });
  try {
    const user = await registerFromInvite(username, password, invite);
    const token = await createSession(user.id);
    res.status(201).json({ token, user });
  } catch (error) {
    const message = String(error?.message || '');
    res.status(message.includes('invitación') ? 400 : message.includes('duplicate') ? 409 : 400).json({ error: message.includes('invitación') ? message : 'No se pudo crear la cuenta. Revisá el usuario o la invitación.' });
  }
});
app.use('/api', async (req, res, next) => {
  if (['/auth/login','/auth/register','/auth/bootstrap-status'].includes(req.path)) return next();
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  try {
    const user = await findSession(token);
    if (!user) return res.status(401).json({ error: 'La sesión venció. Volvé a iniciar sesión.' });
    req.user = user; req.sessionToken = token;
    next();
  } catch { res.status(503).json({ error: 'No se pudo validar la sesión.' }); }
});
app.post('/api/auth/logout', async (req, res) => { try { await revokeSession(req.sessionToken); res.json({ ok: true }); } catch { res.status(503).json({ error: 'No se pudo cerrar la sesión.' }); } });
app.get('/api/account', (req, res) => res.json({ user: req.user }));
app.get('/api/account/apis', async (req, res) => { try { res.json({ apis: await listApiKeys(req.user.id) }); } catch { res.status(503).json({ error: 'No se pudieron cargar las APIs.' }); } });
app.put('/api/account/apis', async (req, res) => {
  try {
    const apis = await saveApiKeys(req.user.id, req.body?.apis);
    res.json({ apis });
  } catch (error) { res.status(400).json({ error: error?.message || 'No se pudieron guardar las APIs.' }); }
});
app.delete('/api/account/apis/:slot', async (req, res) => {
  const slot = Number(req.params.slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > 10) return res.status(400).json({ error: 'Campo de API inválido.' });
  try { await deleteApiKey(req.user.id, slot); res.json({ ok: true }); } catch { res.status(503).json({ error: 'No se pudo quitar la API.' }); }
});
app.post('/api/admin/invites', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo el administrador puede crear invitaciones.' });
  try { const invite = await createInvite(req.user.id, req.body?.hours); res.status(201).json(invite); }
  catch { res.status(503).json({ error: 'No se pudo crear la invitación.' }); }
});
app.param('id', async (req, res, next, id) => {
  try {
    const owned = await pool.query('SELECT 1 FROM user_job_ownership WHERE job_id=$1 AND user_id=$2', [String(id), req.user.id]);
    if (!owned.rows.length) return res.status(404).json({ error: 'No se encontró esa tarea en tu espacio.' });
    next();
  } catch { res.status(503).json({ error: 'No se pudo verificar la propiedad de la tarea.' }); }
});
function limitJobCreation(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const limit = windowLimit(jobCreateWindows, ip, 5, 10 * 60 * 1000);
  if (!limit.allowed) { res.set('Retry-After', String(limit.retryAfter)); return res.status(429).json({ error: 'Alcanzaste el límite temporal de creación de tareas. Probá más tarde.' }); }
  next();
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && aa.length > 0 && timingSafeEqual(aa, bb);
}
async function workerRequest(route, options = {}) {
  if (!WORKER_BASE_URL || !WORKER_SHARED_SECRET) {
    const error = new Error('El motor externo no está configurado.');
    error.status = 503;
    throw error;
  }
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(`${WORKER_BASE_URL}${route}`, {
      ...options,
      signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', 'x-swarm-bridge-secret': WORKER_SHARED_SECRET, ...(options.headers || {}) }
    });
  } catch (cause) {
    const detail = cause?.name === 'TimeoutError' || cause?.name === 'AbortError'
      ? 'timeout después de 15 segundos'
      : String(cause?.cause?.code || cause?.message || cause || 'error de red').slice(0, 300);
    console.error('[bridge][worker_network_error]', JSON.stringify({ route, durationMs: Date.now() - startedAt, detail }));
    const error = new Error(`No se pudo conectar con el motor externo (${detail}). Revisá que swarm-worker esté activo y que WORKER_BASE_URL sea correcto.`);
    error.status = 502;
    throw error;
  }
  const rawBody = await response.text().catch(() => '');
  let data = {};
  try { data = rawBody ? JSON.parse(rawBody) : {}; } catch {}
  if (!response.ok) {
    const detail = String(data?.error || rawBody || response.statusText || 'el motor no envió detalles').slice(0, 1200);
    console.error('[bridge][worker_http_error]', JSON.stringify({ route, status: response.status, durationMs: Date.now() - startedAt, detail }));
    const error = new Error(`El motor externo respondió HTTP ${response.status}: ${detail}`);
    error.status = response.status >= 500 ? 502 : response.status;
    throw error;
  }
  console.info('[bridge][worker_ok]', JSON.stringify({ route, status: response.status, durationMs: Date.now() - startedAt }));
  return data;
}
app.get('/api/access-check', (req, res) => res.json({ ok: true, user: req.user }));
app.get('/api/history', async (req, res) => { if (req.user.role !== 'admin') return res.json({ history: [], isolated: true }); try { res.json(await workerRequest('/internal/history')); } catch (error) { res.status(error.status || 502).json({ error: error.message }); } });
app.get('/api/jobs', async (req, res) => {
  const params = new URLSearchParams();
  for (const key of ['limit', 'offset', 'status']) {
    const value = String(req.query[key] ?? '');
    if (value) params.set(key, value);
  }
  const suffix = params.size ? `?${params.toString()}` : '';
  try { res.json(await workerRequest(`/internal/jobs${suffix}`)); }
  catch (error) { res.status(error.status || 502).json({ error: error.message }); }
});
app.post('/api/jobs', limitJobCreation, async (req, res) => {
  const objective = typeof req.body?.objective === 'string' ? req.body.objective.trim() : '';
  if (!objective) return res.status(400).json({ error: 'Escribí un objetivo para el comité.' });
  if (objective.length > 20000) return res.status(413).json({ error: 'El objetivo supera los 20.000 caracteres.' });
  const requestedBudget = Number(req.body?.tokenBudget);
  const tokenBudget = Number.isFinite(requestedBudget) ? Math.min(100000, Math.max(4000, Math.round(requestedBudget / 1000) * 1000)) : undefined;
  try { const result = await workerRequest('/internal/jobs', { method: 'POST', body: JSON.stringify({ objective, tokenBudget }) }); const jobId = String(result?.job?.id || result?.id || result?.jobId || ''); if (jobId) await pool.query('INSERT INTO user_job_ownership(job_id,user_id) VALUES($1,$2) ON CONFLICT(job_id) DO NOTHING', [jobId, req.user.id]); res.status(202).json(result); }
  catch (error) { res.status(error.status || 502).json({ error: error.message }); }
});
app.get('/api/jobs/:id', async (req, res) => { try { res.json(await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}`)); } catch (error) { res.status(error.status || 502).json({ error: error.message }); } });
app.post('/api/jobs/:id/budget', async (req, res) => {
  const requested = Number(req.body?.tokenBudget);
  if (!Number.isFinite(requested)) return res.status(400).json({ error: 'Indicá un límite de tokens válido.' });
  const tokenBudget = Math.min(100000, Math.max(4000, Math.round(requested / 1000) * 1000));
  try { res.json(await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}/budget`, { method: 'POST', body: JSON.stringify({ tokenBudget }) })); }
  catch (error) { res.status(error.status || 502).json({ error: error.message }); }
});
app.post('/api/jobs/:id/continue-budget', async (req, res) => {
  try { res.status(202).json(await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}/continue-budget`, { method: 'POST', body: '{}' })); }
  catch (error) { res.status(error.status || 502).json({ error: error.message }); }
});
app.post('/api/jobs/:id/vote-improvement', async (req, res) => {
  const proposal = typeof req.body?.proposal === 'string' ? req.body.proposal.trim() : '';
  if (!proposal) return res.status(400).json({ error: 'Escribí una mejora concreta para someterla a votación.' });
  if (proposal.length > 1800) return res.status(413).json({ error: 'La propuesta supera los 1.800 caracteres.' });
  try {
    res.json(await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}/vote-improvement`, {
      method: 'POST', body: JSON.stringify({ proposal })
    }));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message });
  }
});
app.post('/api/jobs/:id/retry', async (req, res) => { try { res.status(202).json(await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}/retry`, { method: 'POST', body: '{}' })); } catch (error) { res.status(error.status || 502).json({ error: error.message }); } });
app.get('/api/jobs/:id/bundle', async (req, res) => {
  try {
    const jobId = encodeURIComponent(req.params.id);
    const task = await workerRequest(`/internal/jobs/${jobId}/history`);
    if (task.job?.status !== 'completed' || task.validation?.verdict === 'NEEDS_CHANGES' || task.syntax?.ok === false) {
      return res.status(409).json({ error: 'El ZIP final se habilita cuando Swarm complete y valide la tarea. Los archivos individuales siguen disponibles para revisión técnica.' });
    }
    const listing = await workerRequest(`/internal/jobs/${jobId}/files`);
    const metadata = Array.isArray(listing.files) ? listing.files : [];
    if (!metadata.length) return res.status(409).json({ error: 'La tarea terminó, pero no contiene archivos empaquetables. Pedile al Desarrollador que entregue los archivos completos.' });
    if (metadata.length > 40) return res.status(413).json({ error: 'La entrega supera el límite de 40 archivos por paquete.' });
    const contents = await Promise.all(metadata.map(async item => {
      const result = await workerRequest(`/internal/jobs/${jobId}/files/${encodeURIComponent(item.index)}`);
      if (!result.file || typeof result.file.content !== 'string') throw new Error(`No se pudo recuperar el archivo ${item.path || item.index}.`);
      return { path: result.file.path, content: result.file.content };
    }));
    const existingReadme = contents.some(file => file.path.toLowerCase() === 'readme-swarm.txt');
    if (!existingReadme) {
      const inventory = contents.map(file => `- ${file.path}`).join('\n');
      contents.push({ path: 'README-SWARM.txt', content: [
        'Entrega generada por Swarm',
        `Tarea: ${req.params.id}`,
        '',
        'Contenido del paquete:',
        inventory,
        '',
        'Abrí el archivo HTML principal en un navegador para probar una web estática.',
        'Si el proyecto requiere dependencias o un servidor, consultá su README y ejecutá el comando de instalación en un entorno de desarrollo.'
      ].join('\n') + '\n' });
    }
    const archive = createZip(contents);
    const filename = `swarm-${String(req.params.id).slice(0, 8)}.zip`;
    res.status(200).set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(archive.length),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    }).send(archive);
  } catch (error) {
    console.error('[bridge][bundle_error]', JSON.stringify({ taskId: req.params.id, detail: String(error.message || error).slice(0, 500) }));
    res.status(error.status || 502).json({ error: `No se pudo crear el ZIP completo: ${String(error.message || 'error desconocido').slice(0, 700)}` });
  }
});
function prunePreviewSessions() {
  const now = Date.now();
  for (const [token, session] of previewSessions) if (session.expiresAt <= now) previewSessions.delete(token);
  while (previewSessions.size > 5000) previewSessions.delete(previewSessions.keys().next().value);
}
function validPreviewSession(token) {
  prunePreviewSessions();
  const session = previewSessions.get(String(token || ''));
  return session && session.expiresAt > Date.now() ? session : null;
}
function safePreviewPath(value) {
  const candidate = String(value || '').split(String.fromCharCode(92)).join('/');
  if (!candidate || candidate.startsWith('/') || candidate.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return candidate;
}
function resolvePreviewReference(htmlPath, reference) {
  const raw = String(reference || '').trim();
  const lower = raw.toLowerCase();
  if (!raw || raw.startsWith('//') || raw.startsWith('#') || lower.startsWith('http:') || lower.startsWith('https:') || lower.startsWith('data:') || lower.startsWith('blob:') || lower.startsWith('javascript:') || lower.startsWith('mailto:') || lower.startsWith('tel:')) return null;
  let pathname = raw.split(/[?#]/, 1)[0];
  try { pathname = decodeURIComponent(pathname); } catch { return null; }
  const parts = pathname.startsWith('/') ? [] : htmlPath.split('/').slice(0, -1);
  const relative = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return safePreviewPath(parts.join('/'));
}
function rewritePreviewHtml(html, htmlPath, token) {
  const tokenPart = encodeURIComponent(token);
  const prefix = `/preview/${tokenPart}/assets/`;
  const directory = String(htmlPath).includes('/') ? String(htmlPath).split('/').slice(0, -1).map(encodeURIComponent).join('/') + '/' : '';
  const baseTag = `<base href="${prefix}${directory}">`;
  let output = String(html).replace(/<base\b[^>]*>/gi, '');
  output = output.replace(/<(script|link|img|source|video|audio|track)\b[^>]*>/gi, tag =>
    tag.replace(/\b(src|href|poster)\s*=\s*(["'])(.*?)\2/gi, (whole, attribute, quote, value) => {
      const resolved = resolvePreviewReference(htmlPath, value);
      if (!resolved) return whole;
      return `${attribute}=${quote}${prefix}${resolved.split('/').map(encodeURIComponent).join('/')}${quote}`;
    })
  );
  if (/<head\b[^>]*>/i.test(output)) return output.replace(/<head\b[^>]*>/i, match => match + baseTag);
  if (/<html\b[^>]*>/i.test(output)) return output.replace(/<html\b[^>]*>/i, match => match + '<head>' + baseTag + '</head>');
  return baseTag + output;
}
async function previewFile(session, index) {
  if (Array.isArray(session.files)) {
    const item = session.files.find(file => Number(file.index) === Number(index));
    if (!item) { const error = new Error('No existe ese archivo de la vista previa.'); error.status = 404; throw error; }
    return { item, file: { path: item.path, content: item.content }, files: session.files };
  }
  const listing = await workerRequest(`/internal/jobs/${encodeURIComponent(session.jobId)}/files`);
  const files = Array.isArray(listing.files) ? listing.files : [];
  const item = files.find(file => Number(file.index) === Number(index));
  if (!item) { const error = new Error('No existe ese archivo de la vista previa.'); error.status = 404; throw error; }
  const result = await workerRequest(`/internal/jobs/${encodeURIComponent(session.jobId)}/files/${encodeURIComponent(item.index)}`);
  if (!result.file || (typeof result.file.content !== 'string' && !Buffer.isBuffer(result.file.content))) { const error = new Error('No se pudo recuperar el archivo de la vista previa.'); error.status = 404; throw error; }
  return { item, file: result.file, files };
}
app.post('/api/preview-zip', express.raw({ type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], limit: '32mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Seleccioná un archivo ZIP válido.' });
  try {
    const parsed = parsePreviewZip(req.body);
    prunePreviewSessions();
    const uploadedTokens = [...previewSessions.entries()].filter(([, session]) => session.uploaded);
    while (uploadedTokens.length >= 2) {
      const [oldestToken] = uploadedTokens.shift();
      previewSessions.delete(oldestToken);
    }
    const token = randomBytes(24).toString('base64url');
    previewSessions.set(token, { files: parsed.files, uploaded: true, expiresAt: Date.now() + PREVIEW_TTL_MS });
    const first = parsed.pages[0];
    res.set('Cache-Control', 'no-store').json({
      url: `/preview/${token}/${first.index}`,
      pages: parsed.pages,
      filesCount: parsed.files.length,
      expandedBytes: parsed.totalExpandedBytes,
      expiresInSeconds: Math.floor(PREVIEW_TTL_MS / 1000),
      skippedFiles: 'Los ejecutables, instaladores y formatos no compatibles se excluyen.'
    });
  } catch (error) {
    res.status(422).json({ error: String(error?.message || 'No se pudo leer el ZIP.').slice(0, 500) });
  }
});
app.post('/api/jobs/:id/preview-session', async (req, res) => {
  try {
    const index = Number(req.body?.index);
    if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Índice de vista previa inválido.' });
    const listing = await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}/files`);
    const file = (Array.isArray(listing.files) ? listing.files : []).find(item => Number(item.index) === index);
    if (!file || !String(file.path || '').toLowerCase().endsWith('.html')) return res.status(400).json({ error: 'Solo se pueden previsualizar archivos HTML.' });
    prunePreviewSessions();
    const token = randomBytes(24).toString('base64url');
    previewSessions.set(token, { jobId: req.params.id, expiresAt: Date.now() + PREVIEW_TTL_MS });
    res.json({ url: `/preview/${token}/${index}`, expiresInSeconds: Math.floor(PREVIEW_TTL_MS / 1000) });
  } catch (error) { res.status(error.status || 502).json({ error: error.message }); }
});
app.get('/preview/:token/assets/*', async (req, res) => {
  const session = validPreviewSession(req.params.token);
  if (!session) return res.status(404).type('text/plain').send('La vista previa expiró. Volvé a abrirla desde Swarm.');
  try {
    const assetPath = safePreviewPath(req.params[0]);
    if (!assetPath) return res.status(400).type('text/plain').send('Ruta de recurso inválida.');
    if (Array.isArray(session.files)) {
      const item = session.files.find(file => file.path === assetPath);
      if (!item) return res.status(404).type('text/plain').send('Recurso no incluido en el paquete.');
      res.set({ 'Content-Type': item.contentType || previewMimeType(item.path), 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      return res.send(item.content);
    }
    const listing = await workerRequest(`/internal/jobs/${encodeURIComponent(session.jobId)}/files`);
    const item = (Array.isArray(listing.files) ? listing.files : []).find(file => file.path === assetPath);
    if (!item) return res.status(404).type('text/plain').send('Recurso no incluido en el paquete.');
    const result = await workerRequest(`/internal/jobs/${encodeURIComponent(session.jobId)}/files/${encodeURIComponent(item.index)}`);
    if (!result.file || typeof result.file.content !== 'string') return res.status(404).type('text/plain').send('Recurso no disponible.');
    res.set({ 'Content-Type': item.contentType || 'text/plain; charset=utf-8', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.send(result.file.content);
  } catch (error) { res.status(error.status || 502).type('text/plain').send('No se pudo cargar el recurso local.'); }
});
app.get('/preview/:token/:index', async (req, res) => {
  const session = validPreviewSession(req.params.token);
  if (!session) return res.status(404).type('text/plain').send('La vista previa expiró. Volvé a abrirla desde Swarm.');
  try {
    const result = await previewFile(session, req.params.index);
    if (!String(result.item.path || '').toLowerCase().endsWith('.html')) return res.status(400).type('text/plain').send('Solo se pueden previsualizar archivos HTML.');
    const html = rewritePreviewHtml(result.file.content, result.item.path, req.params.token);
    const previewOrigin = `${req.protocol}://${req.get('host')}`;
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `sandbox allow-scripts allow-pointer-lock; default-src ${previewOrigin} data: blob:; script-src ${previewOrigin} 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src ${previewOrigin} 'unsafe-inline'; img-src ${previewOrigin} data: blob:; font-src ${previewOrigin} data:; media-src ${previewOrigin} data: blob:; connect-src ${previewOrigin} data: blob:; form-action 'none'; object-src 'none'; frame-src 'none'; worker-src ${previewOrigin} blob:; manifest-src 'none'; base-uri ${previewOrigin}; navigate-to ${previewOrigin}; frame-ancestors 'self'`
    });
    res.send(html);
  } catch (error) { res.status(error.status || 502).type('text/plain').send('No se pudo preparar la vista previa.'); }
});
app.get('/api/jobs/:id/files', async (req, res) => {
  try { res.json(await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}/files`)); }
  catch (error) { res.status(error.status || 502).json({ error: error.message }); }
});
app.get('/api/jobs/:id/files/:index', async (req, res) => {
  try {
    const data = await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}/files/${encodeURIComponent(req.params.index)}`);
    const file = data.file;
    if (!file || typeof file.content !== 'string') return res.status(404).json({ error: 'No existe ese archivo.' });
    const safeName = String(file.path || 'archivo.txt').split('/').pop().replace(/[^a-zA-Z0-9._-]/g, '_') || 'archivo.txt';
    res.set('Content-Type', file.contentType || 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${safeName}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(file.content);
  } catch (error) { res.status(error.status || 502).json({ error: error.message }); }
});
app.post('/api/jobs/:id/reply', async (req, res) => {
  const agent = typeof req.body?.agent === 'string' ? req.body.agent : '';
  const message = typeof req.body?.message === 'string' ? req.body.message : '';
  if (!message.trim()) return res.status(400).json({ error: 'Escribí un mensaje para el agente.' });
  if (message.length > 6000) return res.status(413).json({ error: 'El mensaje supera los 6.000 caracteres.' });
  try { res.json(await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}/reply`, { method: 'POST', body: JSON.stringify({ agent, message }) })); }
  catch (error) { res.status(error.status || 502).json({ error: error.message }); }
});
app.get('/api/jobs/:id/history', async (req, res) => { try { res.json(await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}/history`)); } catch (error) { res.status(error.status || 502).json({ error: error.message }); } });
app.use((error, _req, res, _next) => { console.error('[bridge]', error.message); res.status(400).json({ error: 'No se pudo procesar la solicitud.' }); });
app.listen(PORT, '0.0.0.0', () => console.log(`[bridge] escuchando en 0.0.0.0:${PORT}`));