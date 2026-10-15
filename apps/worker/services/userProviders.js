import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const context = new AsyncLocalStorage();
const connectionString = process.env.SWARM_DATABASE_URL || '';
// Upgrade PostgreSQL's weaker sslmode=require to hostname/certificate verification where supported.
const verifiedConnectionString = connectionString.replace(/([?&])sslmode=require(?=(&|$))/i, '$1sslmode=verify-full');
const isLocalDatabase = (() => {
  try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(connectionString).hostname); }
  catch { return false; }
})();
const keyHex = process.env.SWARM_API_ENCRYPTION_KEY || '';
let pool;
if (connectionString && /^[a-f0-9]{64}$/i.test(keyHex)) {
  pool = new Pool({ connectionString: verifiedConnectionString, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, ssl: isLocalDatabase ? false : { rejectUnauthorized: true } });
}
const key = /^[a-f0-9]{64}$/i.test(keyHex) ? Buffer.from(keyHex, 'hex') : null;
function decrypt(value) {
  if (!key) throw new Error('API encryption is not configured.');
  const [ivHex, tagHex, bodyHex] = String(value).split(':');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(bodyHex, 'hex')), decipher.final()]).toString('utf8');
}

function encrypt(value) {
  if (!key) throw new Error('API encryption is not configured.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), body.toString('hex')].join(':');
}
export function firstAvailableApiSlot(usedSlots) {
  for (let slot = 1; slot <= 10; slot++) if (!usedSlots.has(slot)) return slot;
  return null;
}

export async function importLegacyProvidersForUser(userId) {
  if (!pool) throw new Error('User API database is not configured.');
  const migration = await pool.query('SELECT 1 FROM user_api_migrations WHERE user_id=$1', [userId]);
  if (migration.rows.length) return { imported: 0, skipped: 0, alreadyMigrated: true };
  const candidates = [];
  if (process.env.GEMINI_API_KEY) candidates.push({ label: 'Gemini', key: process.env.GEMINI_API_KEY, baseUrl: 'https://generativelanguage.googleapis.com', reasoning: process.env.GEMINI_MODEL_REASONING || 'gemini-3.8-flash', coding: process.env.GEMINI_MODEL_CODING || 'gemini-3.8-flash', validation: process.env.GEMINI_MODEL_VALIDATION || 'gemini-3.8-flash' });
  if (process.env.GROQ_API_KEY) candidates.push({ label: 'Groq', key: process.env.GROQ_API_KEY, baseUrl: 'https://api.groq.com/openai/v1', reasoning: process.env.GROQ_MODEL_REASONING || 'openai/gpt-oss-120b', coding: process.env.GROQ_MODEL_CODING || 'openai/gpt-oss-120b', validation: process.env.GROQ_MODEL_VALIDATION || 'openai/gpt-oss-20b' });
  try {
    const entries = JSON.parse(process.env.AI_FALLBACK_PROVIDERS || '[]');
    if (Array.isArray(entries)) for (const item of entries) {
      const keyName = String(item?.apiKeyEnv || '');
      const apiKey = /^[A-Z][A-Z0-9_]{1,79}$/.test(keyName) ? process.env[keyName] : '';
      const baseUrl = String(item?.baseUrl || '').trim().replace(/\/+$/, '');
      const model = String(item?.model || item?.models?.reasoning || '').trim();
      if (apiKey && model && /^https:\/\//i.test(baseUrl)) {
        candidates.push({ label: String(item.name || 'Proveedor externo').slice(0,80), key: apiKey, baseUrl, reasoning: String(item.models?.reasoning || model), coding: String(item.models?.coding || model), validation: String(item.models?.validation || model) });
      }
    }
  } catch { /* Never log legacy provider configuration or credentials. */ }
  if (!candidates.length) return { imported: 0, skipped: 0, alreadyMigrated: false };

  const existingResult = await pool.query(
    'SELECT slot,label,base_url,model_reasoning,model_coding,model_validation,encrypted_api_key FROM user_api_keys WHERE user_id=$1 ORDER BY slot',
    [userId]
  );
  const existingRows = existingResult.rows.slice();
  const usedSlots = new Set(existingRows.map(row => Number(row.slot)));
  let imported = 0;
  let skipped = 0;
  for (const item of candidates) {
    const alreadyPresent = existingRows.some(row => {
      if (row.base_url !== item.baseUrl || row.label !== item.label) return false;
      try { return decrypt(row.encrypted_api_key) === item.key; } catch { return false; }
    });
    if (alreadyPresent) continue;
    const slot = firstAvailableApiSlot(usedSlots);
    if (slot === null) { skipped++; continue; }
    const encryptedKey = encrypt(item.key);
    await pool.query(`INSERT INTO user_api_keys(user_id,slot,label,base_url,model_reasoning,model_coding,model_validation,encrypted_api_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [userId,slot,item.label,item.baseUrl,item.reasoning,item.coding,item.validation,encryptedKey]);
    existingRows.push({ slot, label: item.label, base_url: item.baseUrl, encrypted_api_key: encryptedKey });
    usedSlots.add(slot);
    imported++;
  }
  // Mark the migration after a successful pass. If a write fails midway, the next login
  // compares decrypted keys in memory and safely resumes without duplicating imported rows.
  await pool.query('INSERT INTO user_api_migrations(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING', [userId]);
  return { imported, skipped, alreadyMigrated: false };
}

export function currentUserProviders() { return context.getStore() || null; }

/** Ensure a job (including automatic continuation batches) stays owned by its originating account. */
export async function registerJobOwnership(userId, jobId, createdAt = null) {
  if (!userId || !pool) return false;
  const owner = String(userId);
  const id = String(jobId || '');
  if (!/^[0-9a-f-]{36}$/i.test(owner) || !id || id.length > 128) {
    throw new Error('Invalid job ownership reference.');
  }
  await pool.query(
    'INSERT INTO user_job_ownership(job_id,user_id,created_at) VALUES($1,$2,COALESCE($3::timestamptz,now())) ON CONFLICT(job_id) DO NOTHING',
    [id, owner, createdAt && Number.isFinite(Date.parse(createdAt)) ? new Date(createdAt).toISOString() : null]
  );
  const { rows } = await pool.query('SELECT user_id FROM user_job_ownership WHERE job_id=$1', [id]);
  if (!rows[0] || rows[0].user_id !== owner) {
    const error = new Error('Job ownership conflict detected.');
    error.code = 'JOB_OWNERSHIP_CONFLICT';
    throw error;
  }
  return true;
}

export async function withUserProviders(userId, operation) {
  if (!userId) return context.run(null, operation);
  if (!pool) throw new Error('User API database is not configured.');
  const { rows } = await pool.query('SELECT label,base_url,model_reasoning,model_coding,model_validation,encrypted_api_key FROM user_api_keys WHERE user_id=$1 ORDER BY slot', [userId]);
  const providers = [];
  const geminiProviders = [];
  let gemini = null;
  for (const row of rows) {
    let apiKey;
    try { apiKey = decrypt(row.encrypted_api_key); } catch { continue; }
    const provider = {
      name: String(row.label || 'User API').slice(0, 80),
      baseUrl: String(row.base_url || '').replace(/\/+$/, ''),
      apiKey,
      models: {
        reasoning: String(row.model_reasoning || '').trim(),
        coding: String(row.model_coding || '').trim(),
        validation: String(row.model_validation || '').trim()
      }
    };
    if (/generativelanguage\.googleapis\.com/i.test(provider.baseUrl)) {
      const geminiProvider = { apiKey, models: provider.models, name: provider.name, baseUrl: provider.baseUrl };
      geminiProviders.push(geminiProvider);
      if (!gemini) gemini = geminiProvider;
    } else if (/^https:\/\//i.test(provider.baseUrl)) providers.push(provider);
  }
  return context.run({ userId, providers, gemini, geminiProviders }, operation);
}

/** Return whether a model appears in an OpenAI-compatible model catalog, or null if no catalog is exposed. */
export function modelCatalogStatus(payload, model) {
  const catalog = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : null;
  if (!catalog) return null;
  const target = String(model || '').trim();
  return catalog.some(item => {
    const id = String(item?.id || item?.name || '').trim();
    return id === target || id === `models/${target}` || id.endsWith(`/${target}`);
  });
}

/** Verify a saved user's API key against a metadata endpoint; this does not generate model tokens. */
export async function testUserProvider(userId, slot) {
  const normalizedSlot = Number(slot);
  if (!/^[0-9a-f-]{36}$/i.test(String(userId || '')) || !Number.isInteger(normalizedSlot) || normalizedSlot < 1 || normalizedSlot > 10) {
    throw Object.assign(new Error('La cuenta o el campo de API no es válido.'), { status: 400 });
  }
  if (!pool) throw Object.assign(new Error('La base de datos de APIs no está configurada.'), { status: 503 });
  const { rows } = await pool.query(
    'SELECT label,base_url,model_reasoning,model_coding,model_validation,encrypted_api_key FROM user_api_keys WHERE user_id=$1 AND slot=$2',
    [userId, normalizedSlot]
  );
  const row = rows[0];
  if (!row) throw Object.assign(new Error('No existe una API guardada en ese campo.'), { status: 404 });
  let apiKey;
  try { apiKey = decrypt(row.encrypted_api_key); }
  catch { throw Object.assign(new Error('No se pudo descifrar la clave guardada.'), { status: 503 }); }
  const baseUrl = String(row.base_url || '').replace(/\/+$/, '');
  const model = String(row.model_coding || row.model_reasoning || row.model_validation || '').trim();
  if (!model) throw Object.assign(new Error('Configurá un modelo antes de probar la API.'), { status: 400 });
  let parsedBase;
  try { parsedBase = new URL(baseUrl); }
  catch { throw Object.assign(new Error('La URL guardada del proveedor no es válida.'), { status: 400 }); }
  if (parsedBase.protocol !== 'https:') throw Object.assign(new Error('La URL del proveedor debe usar HTTPS.'), { status: 400 });
  const isGemini = parsedBase.hostname.toLowerCase() === 'generativelanguage.googleapis.com';
  const endpoint = isGemini
    ? new URL(`/v1beta/models/${encodeURIComponent(model)}`, parsedBase.origin)
    : new URL('models', `${baseUrl}/`);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: isGemini ? { 'x-goog-api-key': apiKey } : { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    const message = error?.name === 'TimeoutError' ? 'La verificación del proveedor agotó el tiempo.' : 'No se pudo conectar con el proveedor.';
    throw Object.assign(new Error(message), { status: 502 });
  }
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? 'El proveedor rechazó la clave API.'
      : response.status === 404
        ? 'El proveedor no encontró el modelo o no admite esta consulta de verificación.'
        : response.status === 429
          ? 'El proveedor limitó temporalmente la verificación.'
          : `El proveedor respondió HTTP ${response.status}.`;
    const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : 422;
    throw Object.assign(new Error(message), { status });
  }
  const payload = await response.json().catch(() => null);
  const modelAvailable = isGemini ? true : modelCatalogStatus(payload, model);
  return {
    ok: true,
    provider: String(row.label || 'API guardada').slice(0, 80),
    model,
    modelAvailable,
    message: modelAvailable === true
      ? 'Conexión autenticada y modelo reconocido.'
      : modelAvailable === false
        ? 'La clave funciona, pero el modelo no aparece en el catálogo del proveedor.'
        : 'La conexión fue autenticada; el proveedor no expone un catálogo de modelos verificable.'
  };
}
