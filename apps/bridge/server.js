import { timingSafeEqual, randomBytes } from 'node:crypto';
import 'dotenv/config';
import express from 'express';
import { createZip } from './services/zipBundle.js';
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
app.use('/api', (req, res, next) => {
  if (!APP_ACCESS_KEY) {
    if (IS_PROD) return res.status(503).json({ error: 'La aplicación no tiene configurada su clave de acceso.' });
    return next();
  }
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const prior = failedAuth.get(ip);
  if (prior && prior.count >= 10 && prior.until > Date.now()) {
    res.set('Retry-After', String(Math.ceil((prior.until - Date.now()) / 1000)));
    return res.status(429).json({ error: 'Demasiados intentos de acceso. Probá más tarde.' });
  }
  const auth = req.get('authorization') || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!safeEqual(supplied, APP_ACCESS_KEY)) {
    const limit = windowLimit(failedAuth, ip, 10, 15 * 60 * 1000);
    res.set('Retry-After', String(limit.retryAfter));
    return res.status(limit.allowed ? 401 : 429).json({ error: 'Clave de acceso inválida.' });
  }
  failedAuth.delete(ip); next();
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
app.get('/api/history', async (_req, res) => { try { res.json(await workerRequest('/internal/history')); } catch (error) { res.status(error.status || 502).json({ error: error.message }); } });
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
  try { const result = await workerRequest('/internal/jobs', { method: 'POST', body: JSON.stringify({ objective }) }); res.status(202).json(result); }
  catch (error) { res.status(error.status || 502).json({ error: error.message }); }
});
app.get('/api/jobs/:id', async (req, res) => { try { res.json(await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}`)); } catch (error) { res.status(error.status || 502).json({ error: error.message }); } });
app.post('/api/jobs/:id/retry', async (req, res) => { try { res.status(202).json(await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}/retry`, { method: 'POST', body: '{}' })); } catch (error) { res.status(error.status || 502).json({ error: error.message }); } });
app.get('/api/jobs/:id/bundle', async (req, res) => {
  try {
    const jobId = encodeURIComponent(req.params.id);
    const listing = await workerRequest(`/internal/jobs/${jobId}/files`);
    const metadata = Array.isArray(listing.files) ? listing.files : [];
    if (!metadata.length) return res.status(409).json({ error: 'Esta tarea todavía no tiene archivos empaquetables. Esperá a que genere la entrega o pedile al Desarrollador que entregue archivos completos.' });
    if (metadata.length > 40) return res.status(413).json({ error: 'La entrega supera el límite de 40 archivos por paquete.' });
    const contents = await Promise.all(metadata.map(async item => {
      const result = await workerRequest(`/internal/jobs/${jobId}/files/${encodeURIComponent(item.index)}`);
      if (!result.file || typeof result.file.content !== 'string') throw new Error(`No se pudo recuperar el archivo ${item.path || item.index}.`);
      return { path: result.file.path, content: result.file.content };
    }));
    const existingReadme = contents.some(file => file.path.toLowerCase() === 'readme-swarm.txt');
    if (!existingReadme) {
      const inventory = contents.map(file => `- ${file.path}`).join('\\n');
      contents.push({ path: 'README-SWARM.txt', content: `Entrega generada por Swarm\\nTarea: ${req.params.id}\\n\\nContenido del paquete:\\n${inventory}\\n\\nAbrí el archivo HTML principal en un navegador para probar una web estática. Si el proyecto requiere dependencias o un servidor, consultá su README y ejecutá el comando de instalación en un entorno de desarrollo.\\n` });
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
  const prefix = `/preview/${encodeURIComponent(token)}/assets/`;
  return String(html).replace(/<(script|link|img|source|video|audio|track)\\b[^>]*>/gi, tag =>
    tag.replace(/\\b(src|href|poster)\\s*=\\s*(["'])(.*?)\\2/gi, (whole, attribute, quote, value) => {
      const resolved = resolvePreviewReference(htmlPath, value);
      if (!resolved) return whole;
      return `${attribute}=${quote}${prefix}${resolved.split('/').map(encodeURIComponent).join('/')}${quote}`;
    })
  );
}
async function previewFile(session, index) {
  const listing = await workerRequest(`/internal/jobs/${encodeURIComponent(session.jobId)}/files`);
  const files = Array.isArray(listing.files) ? listing.files : [];
  const item = files.find(file => Number(file.index) === Number(index));
  if (!item) { const error = new Error('No existe ese archivo de la vista previa.'); error.status = 404; throw error; }
  const result = await workerRequest(`/internal/jobs/${encodeURIComponent(session.jobId)}/files/${encodeURIComponent(item.index)}`);
  if (!result.file || typeof result.file.content !== 'string') { const error = new Error('No se pudo recuperar el archivo de la vista previa.'); error.status = 404; throw error; }
  return { item, file: result.file, files };
}
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
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"
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