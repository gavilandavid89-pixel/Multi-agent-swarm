import { timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import 'dotenv/config';
import express from 'express';
import { pool, initAccountStore, hashPassword, verifyPassword, createSession, findSession, revokeSession, changePassword, listApiKeys, saveApiKeys, deleteApiKey, createInvite, validateInvite, registerFromInvite, ensureAccountKey, loginWithAccountKey, listManagedUsers, setManagedUserDisabled } from './services/accountStore.js';
import { createZip } from './services/zipBundle.js';
import { initConversationStore, listConversations, createConversation, getConversation, renameConversation, setConversationArchived, listConversationMessages } from './services/conversationStore.js';
import { parsePreviewZip, previewMimeType } from './services/zipPreview.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const WORKER_BASE_URL = (process.env.WORKER_BASE_URL || '').replace(/\/$/, '');
const WORKER_SHARED_SECRET = process.env.WORKER_SHARED_SECRET || '';
const APP_ACCESS_KEY = process.env.APP_ACCESS_KEY || '';
const IS_PROD = process.env.NODE_ENV === 'production';
const configuredShutdownGrace = Number.parseInt(process.env.SHUTDOWN_GRACE_MS || '20000', 10);
const SHUTDOWN_GRACE_MS = Number.isFinite(configuredShutdownGrace) ? Math.min(30000, Math.max(1000, configuredShutdownGrace)) : 20000;
const WORKER_WAKE_RETRY_DELAYS_MS = [2000, 4000, 6000, 8000, 10000, 10000, 10000, 10000];
let workerReadyUntil = 0;
let workerWakePromise = null;
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
app.get('/readyz', async (_req, res) => {
  const workerConfigured = Boolean(WORKER_BASE_URL && WORKER_SHARED_SECRET);
  try {
    await pool.query('SELECT 1');
    const ok = workerConfigured;
    res.status(ok ? 200 : 503).json({ ok, role: 'bridge', database: 'ready', workerConfigured });
  } catch {
    res.status(503).json({ ok: false, role: 'bridge', database: 'unavailable', workerConfigured });
  }
});
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function ensureWorkerAwake() {
  if (Date.now() < workerReadyUntil) return;
  if (workerWakePromise) return workerWakePromise;
  workerWakePromise = (async () => {
    let lastDetail = 'sin respuesta del endpoint de disponibilidad';
    for (let attempt = 0; attempt <= WORKER_WAKE_RETRY_DELAYS_MS.length; attempt++) {
      try {
        const response = await fetch(`${WORKER_BASE_URL}/readyz`, { signal: AbortSignal.timeout(6000) });
        const rawBody = await response.text().catch(() => '');
        let data = {};
        try { data = rawBody ? JSON.parse(rawBody) : {}; } catch {}
        if (response.ok && data?.ok === true && data?.role === 'worker') {
          workerReadyUntil = Date.now() + 5000;
          console.info('[bridge][worker_ready_after_wake]', JSON.stringify({ attempts: attempt + 1 }));
          return;
        }
        lastDetail = `HTTP ${response.status}${data?.database === 'unavailable' ? ' (PostgreSQL aún no está listo)' : ''}`;
      } catch (cause) {
        lastDetail = String(cause?.cause?.code || cause?.message || cause || 'error de red').slice(0, 180);
      }
      if (attempt < WORKER_WAKE_RETRY_DELAYS_MS.length) await sleep(WORKER_WAKE_RETRY_DELAYS_MS[attempt]);
    }
    const error = new Error(`El motor de agentes no volvió a estar listo después de intentar despertarlo durante hasta dos minutos (${lastDetail}). Esta operación no quedó confirmada; revisá el worker e intentá nuevamente.`);
    error.status = 503;
    throw error;
  })();
  try { return await workerWakePromise; }
  finally { workerWakePromise = null; }
}
function windowLimit(map, key, limit, windowMs) {
  const now = Date.now();
  if (!map.has(key) && map.size >= 5000) {
    for (const [itemKey, item] of map) if (item.until <= now) map.delete(itemKey);
    // Keep the in-process limiter bounded under high-cardinality IP/user traffic.
    while (map.size >= 5000) map.delete(map.keys().next().value);
  }
  let item = map.get(key);
  if (!item || item.until <= now) item = { count: 0, until: now + windowMs };
  item.count += 1; map.set(key, item);
  return { allowed: item.count <= limit, retryAfter: Math.max(1, Math.ceil((item.until - now) / 1000)) };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = await mapper(items[index], index); }
      catch { results[index] = null; }
    }
  }));
  return results;
}
app.get('/api/auth/bootstrap-status', async (_req, res) => {
  try { const { rows } = await pool.query('SELECT EXISTS(SELECT 1 FROM app_users) AS initialized'); res.json({ initialized: rows[0].initialized }); }
  catch { res.status(503).json({ error: 'No se pudo consultar el estado de la cuenta.' }); }
});
app.post('/api/auth/validate-invite', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const limit = windowLimit(failedAuth, `invite:${ip}`, 12, 15 * 60 * 1000);
  if (!limit.allowed) {
    res.set('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ valid: false, error: 'Demasiados intentos. Probá más tarde.' });
  }
  const invite = typeof req.body?.invite === 'string' ? req.body.invite.trim() : '';
  if (invite.length < 20 || invite.length > 200) return res.status(400).json({ valid: false, error: 'Pegá un código de invitación válido.' });
  try {
    const valid = await validateInvite(invite);
    res.status(valid ? 200 : 400).json(valid
      ? { valid: true }
      : { valid: false, error: 'La invitación no es válida, venció o ya fue utilizada.' });
  } catch {
    res.status(503).json({ valid: false, error: 'No se pudo validar la invitación. Intentá nuevamente.' });
  }
});
app.post('/api/auth/login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const username = String(req.body?.username || '').trim().toLowerCase();
  const ipLimit = windowLimit(failedAuth, `ip:${ip}`, 8, 15 * 60 * 1000);
  const usernameLimit = windowLimit(failedAuth, `user:${username}`, 8, 15 * 60 * 1000);
  if (!ipLimit.allowed || !usernameLimit.allowed) {
    res.set('Retry-After', String(Math.max(ipLimit.retryAfter, usernameLimit.retryAfter)));
    return res.status(429).json({ error: 'Demasiados intentos. Probá más tarde.' });
  }
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

    } else if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }
    if (user.role === 'admin') {
      try {
        const migrated = await workerRequest('/internal/admin/import-legacy-apis', { method: 'POST', body: JSON.stringify({ userId: user.id }) });
        console.info('[bridge][legacy_api_migration]', JSON.stringify({ userId: user.id, imported: Number(migrated?.imported) || 0, skipped: Number(migrated?.skipped) || 0, alreadyMigrated: Boolean(migrated?.alreadyMigrated) }));
      } catch { console.warn('[bridge][legacy_api_migration] deferred'); }
      try {
        let offset = 0; let total = 0;
        do {
          const legacy = await workerRequest(`/internal/jobs?limit=100&offset=${offset}`);
          const jobs = Array.isArray(legacy) ? legacy : (Array.isArray(legacy?.jobs) ? legacy.jobs : []);
          total = Number(legacy?.total) || jobs.length;
          for (const job of jobs) if (job?.id) await pool.query('INSERT INTO user_job_ownership(job_id,user_id,created_at) VALUES($1,$2,COALESCE($3::timestamptz,now())) ON CONFLICT(job_id) DO NOTHING', [String(job.id), user.id, job.createdAt || null]);
          offset += jobs.length;
          if (!jobs.length) break;
        } while (offset < total);
      } catch { console.warn('[bridge][legacy_job_migration] deferred'); }
    }
    failedAuth.delete(`ip:${ip}`); failedAuth.delete(`user:${username}`);
    const token = await createSession(user.id);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) { console.error('[bridge][login_error]', error?.code || 'internal'); res.status(503).json({ error: 'No se pudo iniciar sesión. Revisá la conexión de la base de datos.' }); }
});
app.post('/api/auth/key-login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const accountCode = typeof req.body?.accountCode === 'string' ? req.body.accountCode.trim() : '';
  const ipLimit = windowLimit(failedAuth, `key-login-ip:${ip}`, 20, 15 * 60 * 1000);
  const limitKey = `key-login:${ip}:${accountCode}`;
  const accountLimit = windowLimit(failedAuth, limitKey, 8, 15 * 60 * 1000);
  if (!ipLimit.allowed || !accountLimit.allowed) { res.set('Retry-After', String(Math.max(ipLimit.retryAfter, accountLimit.retryAfter))); return res.status(429).json({ error: 'Demasiados intentos. Probá más tarde.' }); }
  const accessKey = typeof req.body?.accessKey === 'string' ? req.body.accessKey : '';
  try {
    const user = await loginWithAccountKey(accountCode, accessKey);
    if (!user) return res.status(401).json({ error: 'Identificador o clave incorrectos.' });
    failedAuth.delete(limitKey);
    const token = await createSession(user.id);
    res.set('Cache-Control', 'no-store').json({ token, user });
  } catch { res.status(503).json({ error: 'No se pudo iniciar sesión. Revisá la conexión de la base de datos.' }); }
});
app.post('/api/auth/register', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const invite = typeof req.body?.invite === 'string' ? req.body.invite.trim() : '';
  if (username === 'admin') return res.status(400).json({ error: 'El nombre admin está reservado para la cuenta administradora inicial.' });
  if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username) || password.length < 12 || password.length > 512 || invite.length < 20 || invite.length > 200) return res.status(400).json({ error: 'Usuario, contraseña o invitación inválidos.' });
  try {
    const user = await registerFromInvite(username, password, invite);
    const token = await createSession(user.id);
    res.set('Cache-Control', 'no-store').status(201).json({ token, user: { id: user.id, username: user.username, role: user.role, accountCode: user.accountCode }, accountKey: user.accessKey });
  } catch (error) {
    const message = String(error?.message || '');
    res.status(message.includes('invitación') ? 400 : message.includes('duplicate') ? 409 : 400).json({ error: message.includes('invitación') ? message : 'No se pudo crear la cuenta. Revisá el usuario o la invitación.' });
  }
});
app.use('/api', async (req, res, next) => {
  if (['/auth/login','/auth/key-login','/auth/register','/auth/validate-invite','/auth/bootstrap-status'].includes(req.path)) return next();
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
app.get('/api/account/key', async (req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await ensureAccountKey(req.user.id)); }
  catch (error) { res.status(error.status || 503).json({ error: 'No se pudo cargar la clave de la cuenta.' }); }
});
app.patch('/api/account/password', async (req, res) => {
  const limitKey = `password:${req.user.id}`;
  const passwordLimit = windowLimit(failedAuth, limitKey, 6, 15 * 60 * 1000);
  if (!passwordLimit.allowed) {
    res.set('Retry-After', String(passwordLimit.retryAfter));
    return res.status(429).json({ error: 'Demasiados intentos de cambio de contraseña. Probá más tarde.' });
  }
  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  if (newPassword.length < 12 || newPassword.length > 512) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener entre 12 y 512 caracteres.' });
  }
  try {
    const token = await changePassword(req.user.id, currentPassword, newPassword, req.sessionToken);
    failedAuth.delete(limitKey);
    res.json({ ok: true, token });
  } catch (error) {
    res.status(error.status || 503).json({ error: error.message || 'No se pudo cambiar la contraseña.' });
  }
});
app.get('/api/account/apis', async (req, res) => { try { res.json({ apis: await listApiKeys(req.user.id) }); } catch { res.status(503).json({ error: 'No se pudieron cargar las APIs.' }); } });
app.put('/api/account/apis', async (req, res) => {
  try {
    const apis = await saveApiKeys(req.user.id, req.body?.apis);
    res.json({ apis });
  } catch (error) { res.status(400).json({ error: error?.message || 'No se pudieron guardar las APIs.' }); }
});
app.post('/api/account/apis/:slot/test', async (req, res) => {
  const slot = Number(req.params.slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > 10) return res.status(400).json({ error: 'Campo de API inválido.' });
  const limitKey = `provider-test:${req.user.id}`;
  const testLimit = windowLimit(jobCreateWindows, limitKey, 20, 5 * 60 * 1000);
  if (!testLimit.allowed) {
    res.set('Retry-After', String(testLimit.retryAfter));
    return res.status(429).json({ error: 'Demasiadas pruebas de conexión. Probá de nuevo en unos minutos.' });
  }
  try {
    res.json(await workerRequest(`/internal/account/apis/${encodeURIComponent(slot)}/test`, { method: 'POST', body: JSON.stringify({ userId: req.user.id }) }));
  } catch (error) { res.status(error.status || 502).json({ error: error.message }); }
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
app.get('/api/admin/users', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo el administrador puede gestionar cuentas.' });
  try { res.json({ users: await listManagedUsers() }); }
  catch { res.status(503).json({ error: 'No se pudieron cargar las cuentas.' }); }
});
app.patch('/api/admin/users/:userId/status', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo el administrador puede gestionar cuentas.' });
  if (typeof req.body?.disabled !== 'boolean') return res.status(400).json({ error: 'El estado de la cuenta no es válido.' });
  try { res.json({ user: await setManagedUserDisabled(req.params.userId, req.body.disabled) }); }
  catch (error) { res.status(error.status || 503).json({ error: error.message || 'No se pudo actualizar la cuenta.' }); }
});

function parsePageInteger(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(max, parsed) : fallback;
}
function validConversationId(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '')); }

app.get('/api/chats', async (req, res) => {
  const limit = Math.max(1, parsePageInteger(req.query.limit, 25, 100));
  const offset = parsePageInteger(req.query.offset, 0, 1000000);
  const archivedRaw = String(req.query.archived || 'false');
  if (!['true', 'false'].includes(archivedRaw)) return res.status(400).json({ error: 'El filtro de archivo no es válido.' });
  try {
    const chats = await listConversations(req.user.id, { archived: archivedRaw === 'true', limit, offset });
    res.set('Cache-Control', 'no-store').json({ chats, limit, offset, hasMore: chats.length === limit });
  } catch { res.status(503).json({ error: 'No se pudieron cargar los chats.' }); }
});

app.post('/api/chats', async (req, res) => {
  const title = req.body?.title === undefined ? 'Nuevo chat' : req.body.title;
  if (typeof title !== 'string') return res.status(400).json({ error: 'El título del chat debe ser texto.' });
  try {
    const chat = await createConversation(req.user.id, title);
    res.set('Cache-Control', 'no-store').status(201).json({ chat });
  } catch (error) { res.status(error.status || 503).json({ error: error.status === 400 ? error.message : 'No se pudo crear el chat.' }); }
});

app.get('/api/chats/:chatId', async (req, res) => {
  if (!validConversationId(req.params.chatId)) return res.status(400).json({ error: 'Identificador de chat inválido.' });
  try {
    const chat = await getConversation(req.user.id, req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'No se encontró ese chat.' });
    res.set('Cache-Control', 'no-store').json({ chat });
  } catch { res.status(503).json({ error: 'No se pudo cargar el chat.' }); }
});

app.patch('/api/chats/:chatId', async (req, res) => {
  if (!validConversationId(req.params.chatId)) return res.status(400).json({ error: 'Identificador de chat inválido.' });
  const hasTitle = Object.prototype.hasOwnProperty.call(req.body || {}, 'title');
  const hasArchived = Object.prototype.hasOwnProperty.call(req.body || {}, 'archived');
  if (hasTitle === hasArchived || (hasTitle && typeof req.body.title !== 'string') || (hasArchived && typeof req.body.archived !== 'boolean')) {
    return res.status(400).json({ error: 'Indicá un título o el estado de archivo válido.' });
  }
  try {
    const chat = hasTitle
      ? await renameConversation(req.user.id, req.params.chatId, req.body.title)
      : await setConversationArchived(req.user.id, req.params.chatId, req.body.archived);
    if (!chat) {
      const exists = await getConversation(req.user.id, req.params.chatId);
      return res.status(exists ? 409 : 404).json({ error: exists ? 'No se puede renombrar un chat archivado.' : 'No se encontró ese chat.' });
    }
    res.set('Cache-Control', 'no-store').json({ chat });
  } catch (error) { res.status(error.status || 503).json({ error: error.status === 400 ? error.message : 'No se pudo actualizar el chat.' }); }
});

app.get('/api/chats/:chatId/messages', async (req, res) => {
  if (!validConversationId(req.params.chatId)) return res.status(400).json({ error: 'Identificador de chat inválido.' });
  const limit = Math.max(1, parsePageInteger(req.query.limit, 50, 100));
  const beforeId = req.query.beforeId === undefined ? null : String(req.query.beforeId);
  if (beforeId !== null && !/^\d{1,18}$/.test(beforeId)) return res.status(400).json({ error: 'Cursor de mensajes inválido.' });
  try {
    const chat = await getConversation(req.user.id, req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'No se encontró ese chat.' });
    const messages = await listConversationMessages(req.user.id, req.params.chatId, { limit, beforeId });
    res.set('Cache-Control', 'no-store').json({ messages, limit, hasMore: messages.length === limit });
  } catch { res.status(503).json({ error: 'No se pudieron cargar los mensajes.' }); }
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
  const limiterKey = req.user?.id ? `user:${req.user.id}` : `ip:${ip}`;
  const limit = windowLimit(jobCreateWindows, limiterKey, 5, 10 * 60 * 1000);
  if (!limit.allowed) { res.set('Retry-After', String(limit.retryAfter)); return res.status(429).json({ error: 'Alcanzaste el límite temporal de creación de tareas. Probá más tarde.' }); }
  next();
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && aa.length > 0 && timingSafeEqual(aa, bb);
}
async function workerRequest(route, options = {}, mayWake = true) {
  if (!WORKER_BASE_URL || !WORKER_SHARED_SECRET) {
    const error = new Error('El motor externo no está configurado.');
    error.status = 503;
    throw error;
  }
  const startedAt = Date.now();
  const method = String(options.method || 'GET').toUpperCase();
  const idempotencyKey = options.headers?.['x-swarm-idempotency-key'] || options.headers?.['X-Swarm-Idempotency-Key'];
  const replaySafe = ['GET', 'HEAD', 'OPTIONS'].includes(method) || Boolean(idempotencyKey);
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
    if (mayWake && replaySafe) {
      console.warn('[bridge][worker_network_recovery]', JSON.stringify({ route, method, idempotentPost: method === 'POST' && Boolean(idempotencyKey) }));
      await ensureWorkerAwake();
      return workerRequest(route, options, false);
    }
    const error = new Error(`No se pudo conectar con el motor externo (${detail}). Revisá que swarm-worker esté activo y que WORKER_BASE_URL sea correcto.`);
    error.status = 502;
    throw error;
  }
  const rawBody = await response.text().catch(() => '');
  let data = {};
  try { data = rawBody ? JSON.parse(rawBody) : {}; } catch {}
  if (!response.ok) {
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const isHtmlGatewayPage = contentType.includes('text/html') || /^\s*<(?:!doctype html|html)\b/i.test(rawBody);
    if (mayWake && replaySafe && isHtmlGatewayPage && [502, 503, 504].includes(response.status)) {
      console.warn('[bridge][worker_cold_start]', JSON.stringify({ route, status: response.status }));
      await ensureWorkerAwake();
      return workerRequest(route, options, false);
    }
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
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '25'), 10) || 25));
  const offset = Math.max(0, Number.parseInt(String(req.query.offset || '0'), 10) || 0);
  const requestedStatus = String(req.query.status || '');
  if (requestedStatus && !['all','queued','running','completed','failed','needs_review'].includes(requestedStatus)) return res.status(400).json({ error: 'Filtro de estado inválido.' });
  try {
    if (!requestedStatus || requestedStatus === 'all') {
      const [countResult, pageResult] = await Promise.all([
        pool.query('SELECT count(*)::int AS total FROM user_job_ownership WHERE user_id=$1', [req.user.id]),
        pool.query('SELECT job_id FROM user_job_ownership WHERE user_id=$1 ORDER BY created_at DESC, job_id DESC LIMIT $2 OFFSET $3', [req.user.id, limit, offset])
      ]);
      const jobs = (await mapWithConcurrency(pageResult.rows, 8, row =>
        workerRequest(`/internal/jobs/${encodeURIComponent(row.job_id)}`)
      )).filter(Boolean);
      jobs.sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const total = countResult.rows[0]?.total || 0;
      return res.json({ jobs, total, limit, offset, hasMore: offset + limit < total, status: 'all' });
    }
    // Status filtering still needs worker status, but concurrent requests are bounded to avoid
    // flooding the worker when an account has a long history.
    const owned = await pool.query('SELECT job_id FROM user_job_ownership WHERE user_id=$1 ORDER BY created_at DESC, job_id DESC', [req.user.id]);
    const jobs = (await mapWithConcurrency(owned.rows, 8, row =>
      workerRequest(`/internal/jobs/${encodeURIComponent(row.job_id)}`)
    )).filter(Boolean).filter(job => job.status === requestedStatus);
    jobs.sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json({ jobs: jobs.slice(offset, offset + limit), total: jobs.length, limit, offset, hasMore: offset + limit < jobs.length, status: requestedStatus });
  } catch (error) { res.status(error.status || 502).json({ error: error.message }); }
});

// Authenticated server-to-browser event stream. PostgreSQL ownership remains authoritative;
// the stream only reports status changes and never exposes another user's job IDs.
const eventStreamClients = new Map();
app.get('/api/events', async (req, res) => {
  const userId = String(req.user?.id || '');
  const currentClients = eventStreamClients.get(userId) || 0;
  if (currentClients >= 2) return res.status(429).json({ error: 'Ya hay demasiadas conexiones de eventos para esta cuenta.' });
  eventStreamClients.set(userId, currentClients + 1);
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  let closed = false;
  let polling = false;
  let lastHeartbeat = Date.now();
  const knownStatuses = new Map();
  const send = (event, payload) => {
    if (closed || res.destroyed || res.writableEnded) return false;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); return true; }
    catch { return false; }
  };
  const poll = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      // Re-check session validity so revoked/disabled accounts don't retain a stream.
      const sessionUser = await findSession(req.sessionToken);
      if (!sessionUser || String(sessionUser.id) !== userId) {
        send('session.expired', { reason: 'session_expired' });
        cleanup();
        return;
      }
      const owned = await pool.query(
        'SELECT job_id FROM user_job_ownership WHERE user_id=$1 ORDER BY created_at DESC LIMIT 25',
        [userId]
      );
      const ids = new Set(owned.rows.map(row => String(row.job_id)));
      for (const [jobId, status] of knownStatuses) if (['queued', 'running'].includes(status)) ids.add(jobId);
      const jobs = (await mapWithConcurrency([...ids], 5, async jobId => {
        try { return await workerRequest(`/internal/jobs/${encodeURIComponent(jobId)}`); }
        catch (error) {
          if (error.status === 404) knownStatuses.delete(jobId);
          return null;
        }
      })).filter(job => job && job.id);
      for (const job of jobs) {
        const previousStatus = knownStatuses.get(job.id);
        if (previousStatus === job.status) continue;
        knownStatuses.set(job.id, job.status);
        if (previousStatus !== undefined) {
          send('task.status', {
            jobId: job.id,
            title: String(job.title || '').slice(0, 240),
            stage: String(job.stage || '').slice(0, 240),
            previousStatus,
            status: job.status,
            wasActive: ['queued', 'running'].includes(previousStatus),
            terminal: ['completed', 'failed', 'needs_review'].includes(job.status)
          });
        }
      }
      // Bound per-connection memory while retaining active tasks for follow-up polling.
      while (knownStatuses.size > 150) {
        const removable = [...knownStatuses].find(([, status]) => !['queued', 'running'].includes(status));
        if (!removable) break;
        knownStatuses.delete(removable[0]);
      }
      if (Date.now() - lastHeartbeat >= 15000) {
        send('heartbeat', { at: new Date().toISOString() });
        lastHeartbeat = Date.now();
      }
    } catch (error) {
      console.warn('[bridge][event_stream_poll_failed]', JSON.stringify({ userId, reason: error?.code || error?.status || 'poll_failed' }));
      send('stream.warning', { retrying: true });
    } finally { polling = false; }
  };
  let interval;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    const remaining = Math.max(0, (eventStreamClients.get(userId) || 1) - 1);
    if (remaining) eventStreamClients.set(userId, remaining);
    else eventStreamClients.delete(userId);
    if (!res.destroyed && !res.writableEnded) res.end();
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
  interval = setInterval(() => { void poll(); }, 10000);
  interval.unref?.();
  void poll();
});

app.post('/api/jobs', limitJobCreation, async (req, res) => {
  const objective = typeof req.body?.objective === 'string' ? req.body.objective.trim() : '';
  if (!objective) return res.status(400).json({ error: 'Escribí un objetivo para el comité.' });
  if (objective.length > 20000) return res.status(413).json({ error: 'El objetivo supera los 20.000 caracteres.' });
  const requestedBudget = Number(req.body?.tokenBudget);
  const tokenBudget = Number.isFinite(requestedBudget) ? Math.min(1000000, Math.max(4000, Math.round(requestedBudget / 1000) * 1000)) : undefined;
  try { const result = await workerRequest('/internal/jobs', { method: 'POST', headers: { 'x-swarm-idempotency-key': randomUUID() }, body: JSON.stringify({ objective, tokenBudget, userId: req.user.id }) }); const jobId = String(result?.job?.id || result?.id || result?.jobId || ''); if (jobId) await pool.query('INSERT INTO user_job_ownership(job_id,user_id,created_at) VALUES($1,$2,COALESCE($3::timestamptz,now())) ON CONFLICT(job_id) DO NOTHING', [jobId, req.user.id, result?.createdAt || result?.job?.createdAt || null]); res.status(202).json(result); }
  catch (error) { res.status(error.status || 502).json({ error: error.message }); }
});
app.get('/api/jobs/:id', async (req, res) => { try { res.json(await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}`)); } catch (error) { res.status(error.status || 502).json({ error: error.message }); } });
app.post('/api/jobs/:id/budget', async (req, res) => {
  const requested = Number(req.body?.tokenBudget);
  if (!Number.isFinite(requested)) return res.status(400).json({ error: 'Indicá un límite de tokens válido.' });
  const tokenBudget = Math.min(1000000, Math.max(4000, Math.round(requested / 1000) * 1000));
  try { res.json(await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}/budget`, { method: 'POST', body: JSON.stringify({ tokenBudget }) })); }
  catch (error) { res.status(error.status || 502).json({ error: error.message }); }
});
app.post('/api/jobs/:id/continue-budget', async (req, res) => {
  try {
    const result = await workerRequest(`/internal/jobs/${encodeURIComponent(req.params.id)}/continue-budget`, { method: 'POST', body: '{}' });
    const childId = String(result?.job?.id || result?.id || '');
    if (childId) await pool.query('INSERT INTO user_job_ownership(job_id,user_id,created_at) VALUES($1,$2,COALESCE($3::timestamptz,now())) ON CONFLICT(job_id) DO NOTHING', [childId, req.user.id, result?.createdAt || result?.job?.createdAt || null]);
    res.status(202).json(result);
  } catch (error) { res.status(error.status || 502).json({ error: error.message }); }
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
    const taskStatus = String(task.job?.status || '');
    const allowedBundleStatuses = new Set(['queued', 'running', 'completed', 'failed', 'needs_review']);
    if (!allowedBundleStatuses.has(taskStatus)) {
      return res.status(409).json({ error: 'El estado de la tarea no permite empaquetar sus archivos.' });
    }
    const validated = taskStatus === 'completed' && task.validation?.verdict !== 'NEEDS_CHANGES' && task.syntax?.ok !== false;
    const listing = await workerRequest(`/internal/jobs/${jobId}/files`);
    const metadata = Array.isArray(listing.files) ? listing.files : [];
    if (!metadata.length) return res.status(409).json({ error: 'Todavía no hay archivos guardados para empaquetar.' });
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
    if (!validated) {
      const statusPath = contents.some(file => file.path.toLowerCase() === 'swarm-estado-validacion.txt')
        ? 'SWARM-ESTADO-VALIDACION-GENERADO.txt'
        : 'SWARM-ESTADO-VALIDACION.txt';
      contents.push({ path: statusPath, content: [
        'BORRADOR SIN VALIDAR',
        `Tarea: ${req.params.id}`,
        `Estado actual: ${taskStatus}`,
        '',
        'Este paquete contiene archivos generados guardados, pero la tarea todavía no superó la validación final.',
        'Revisá los archivos antes de ejecutar o publicar el proyecto.'
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
app.post('/api/preview-zip', (req, res, next) => {
  const limit = windowLimit(jobCreateWindows, `preview-zip:${req.user.id}`, 5, 5 * 60 * 1000);
  if (!limit.allowed) {
    res.set('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ error: 'Demasiadas vistas previas ZIP. Probá de nuevo en unos minutos.' });
  }
  next();
}, express.raw({ type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], limit: '32mb' }), (req, res) => {
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
let server;
let shuttingDown = false;
let poolClosePromise;
function closeAccountPool() {
  if (!poolClosePromise) poolClosePromise = pool.end();
  return poolClosePromise;
}
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[bridge] apagado solicitado; dejando terminar las solicitudes activas.');
  const timer = setTimeout(() => {
    console.warn('[bridge] terminó la ventana de apagado; cerrando las conexiones restantes.');
    server?.closeAllConnections?.();
    void closeAccountPool().catch(error => console.error('[bridge] error cerrando PostgreSQL', error?.message || error)).finally(() => process.exit(0));
  }, SHUTDOWN_GRACE_MS);
  timer.unref();
  if (!server) {
    clearTimeout(timer);
    void closeAccountPool().catch(error => console.error('[bridge] error cerrando PostgreSQL', error?.message || error)).finally(() => process.exit(0));
    return;
  }
  server.close(() => {
    clearTimeout(timer);
    void closeAccountPool().catch(error => console.error('[bridge] error cerrando PostgreSQL', error?.message || error)).finally(() => process.exit(0));
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
await initAccountStore();
await initConversationStore();
server = app.listen(PORT, '0.0.0.0', () => console.log(`[bridge] escuchando en 0.0.0.0:${PORT}`));