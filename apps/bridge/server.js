import { timingSafeEqual } from 'node:crypto';
import 'dotenv/config';
import express from 'express';
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
  if (!WORKER_BASE_URL || !WORKER_SHARED_SECRET) { const error = new Error('El motor externo no está configurado.'); error.status = 503; throw error; }
  const response = await fetch(`${WORKER_BASE_URL}${route}`, {
    ...options, signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', 'x-swarm-bridge-secret': WORKER_SHARED_SECRET, ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `El motor externo respondió HTTP ${response.status}.`); error.status = response.status >= 500 ? 502 : response.status; throw error; }
  return data;
}
app.get('/api/history', async (_req, res) => { try { res.json(await workerRequest('/internal/history')); } catch (error) { res.status(error.status || 502).json({ error: error.message }); } });
app.get('/api/jobs', async (_req, res) => { try { res.json(await workerRequest('/internal/jobs')); } catch (error) { res.status(error.status || 502).json({ error: error.message }); } });
app.post('/api/jobs', limitJobCreation, async (req, res) => {
  const objective = typeof req.body?.objective === 'string' ? req.body.objective.trim() : '';
  if (!objective) return res.status(400).json({ error: 'Escribí un objetivo para el comité.' });
  if (objective.length > 20000) return res.status(413).json({ error: 'El objetivo supera los 20.000 caracteres.' });
  try { const result = await workerRequest('/internal/jobs', { method: 'POST', body: JSON.stringify({ objective }) }); res.status(202).json(result); }
  catch (error) { res.status(error.status || 502).json({ error: error.message }); }
});
app.get('/api/jobs/:id', async (req, res) => { try { res.json(await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}`)); } catch (error) { res.status(error.status || 502).json({ error: error.message }); } });
app.post('/api/jobs/:id/retry', async (req, res) => { try { res.status(202).json(await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}/retry`, { method: 'POST', body: '{}' })); } catch (error) { res.status(error.status || 502).json({ error: error.message }); } });
app.get('/api/jobs/:id/history', async (req, res) => { try { res.json(await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}/history`)); } catch (error) { res.status(error.status || 502).json({ error: error.message }); } });
app.use((error, _req, res, _next) => { console.error('[bridge]', error.message); res.status(400).json({ error: 'No se pudo procesar la solicitud.' }); });
app.listen(PORT, '0.0.0.0', () => console.log(`[bridge] escuchando en 0.0.0.0:${PORT}`));