import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const context = new AsyncLocalStorage();
const connectionString = process.env.SWARM_DATABASE_URL || '';
const keyHex = process.env.SWARM_API_ENCRYPTION_KEY || '';
let pool;
if (connectionString && /^[a-f0-9]{64}$/i.test(keyHex)) {
  pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
}
const key = /^[a-f0-9]{64}$/i.test(keyHex) ? Buffer.from(keyHex, 'hex') : null;
if (process.env.NODE_ENV === 'production' && (!pool || !key)) {
  throw new Error('SWARM_DATABASE_URL y SWARM_API_ENCRYPTION_KEY válidos son obligatorios para el worker en producción.');
}
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
export async function importLegacyProvidersForUser(userId) {
  if (!pool) throw new Error('User API database is not configured.');
  const candidates = [];
  if (process.env.GEMINI_API_KEY) candidates.push({
    baseUrl: 'https://generativelanguage.googleapis.com', key: process.env.GEMINI_API_KEY,
    reasoning: process.env.GEMINI_MODEL_REASONING || 'gemini-3.8-flash',
    coding: process.env.GEMINI_MODEL_CODING || 'gemini-3.8-flash',
    validation: process.env.GEMINI_MODEL_VALIDATION || 'gemini-3.8-flash'
  });
  if (process.env.GROQ_API_KEY) candidates.push({
    baseUrl: 'https://api.groq.com/openai/v1', key: process.env.GROQ_API_KEY,
    reasoning: process.env.GROQ_MODEL_REASONING || 'openai/gpt-oss-120b',
    coding: process.env.GROQ_MODEL_CODING || 'openai/gpt-oss-120b',
    validation: process.env.GROQ_MODEL_VALIDATION || 'openai/gpt-oss-20b'
  });
  try {
    const entries = JSON.parse(process.env.AI_FALLBACK_PROVIDERS || '[]');
    if (Array.isArray(entries)) for (const item of entries) {
      const keyName = String(item?.apiKeyEnv || '');
      const apiKey = /^[A-Z][A-Z0-9_]{1,79}$/.test(keyName) ? process.env[keyName] : '';
      const baseUrl = String(item?.baseUrl || '').trim().replace(/\/+$/, '');
      const models = item?.models && typeof item.models === 'object' ? item.models : {};
      const fallbackModel = String(item?.model || models.reasoning || '').trim();
      if (apiKey && fallbackModel && /^https:\/\//i.test(baseUrl)) {
        candidates.push({
          baseUrl, key: apiKey,
          reasoning: String(models.reasoning || fallbackModel),
          coding: String(models.coding || fallbackModel),
          validation: String(models.validation || fallbackModel)
        });
      }
    }
  } catch { /* Never log legacy provider configuration or credentials. */ }

  if (!candidates.length) return 0;

  const providerDetails = {
    'api.openai.com': { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: { reasoning: 'gpt-6-sol', coding: 'gpt-6-sol', validation: 'gpt-6-luna' } },
    'api.groq.com': { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: { reasoning: 'openai/gpt-oss-120b', coding: 'openai/gpt-oss-120b', validation: 'openai/gpt-oss-20b' } },
    'openrouter.ai': { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: { reasoning: 'openai/gpt-sol-latest', coding: 'openai/gpt-sol-latest', validation: 'openai/gpt-luna' } },
    'generativelanguage.googleapis.com': { label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com', models: { reasoning: 'gemini-3.8-flash', coding: 'gemini-3.8-flash', validation: 'gemini-3.8-flash' } },
    'api.together.xyz': { label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', models: { reasoning: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', coding: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', validation: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' } },
    'api.deepseek.com': { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: { reasoning: 'deepseek-chat', coding: 'deepseek-chat', validation: 'deepseek-chat' } },
    'api.mistral.ai': { label: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', models: { reasoning: 'mistral-small-latest', coding: 'mistral-small-latest', validation: 'mistral-small-latest' } },
    'api.fireworks.ai': { label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', models: { reasoning: 'accounts/fireworks/models/llama-v3p3-70b-instruct', coding: 'accounts/fireworks/models/llama-v3p3-70b-instruct', validation: 'accounts/fireworks/models/llama-v3p3-70b-instruct' } },
    'api.perplexity.ai': { label: 'Perplexity', baseUrl: 'https://api.perplexity.ai', models: { reasoning: 'sonar', coding: 'sonar', validation: 'sonar' } },
    'api.cohere.ai': { label: 'Cohere', baseUrl: 'https://api.cohere.ai/compatibility/v1', models: { reasoning: 'command-a-plus-05-2026', coding: 'command-a-plus-05-2026', validation: 'command-a-plus-05-2026' } },
    'api.cohere.com': { label: 'Cohere (compatibilidad anterior)', baseUrl: 'https://api.cohere.com/compatibility/v1', models: { reasoning: 'command-a-plus-05-2026', coding: 'command-a-plus-05-2026', validation: 'command-a-plus-05-2026' } }
  };
  const supported = new Set(Object.keys(providerDetails));
  const credentialPattern = /(?:sk-[A-Za-z0-9_-]{8,}|sk-or-v1-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,})/i;
  const safeCandidates = [];
  const seen = new Set();
  for (const candidate of candidates) {
    let parsed;
    try { parsed = new URL(candidate.baseUrl); } catch { continue; }
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || !supported.has(hostname) || (parsed.port && parsed.port !== '443') ||
        parsed.username || parsed.password || parsed.search || parsed.hash) continue;
    const provider = providerDetails[hostname];
    if (seen.has(provider.label) || !candidate.key || candidate.key.length > 4096) continue;
    seen.add(provider.label);
    const rawModels = {
      reasoning: String(candidate.reasoning || '').trim(),
      coding: String(candidate.coding || '').trim(),
      validation: String(candidate.validation || '').trim()
    };
    for (const role of ['reasoning', 'coding', 'validation']) {
      if (!rawModels[role] || rawModels[role].length > 120 || credentialPattern.test(rawModels[role])) {
        rawModels[role] = provider.models[role];
      }
    }
    safeCandidates.push({
      label: provider.label, baseUrl: provider.baseUrl, key: candidate.key,
      reasoning: rawModels.reasoning, coding: rawModels.coding, validation: rawModels.validation
    });
  }
  if (!safeCandidates.length) return 0;

  const client = await pool.connect();
  let imported = 0;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [String(userId)]);
    const migration = await client.query('SELECT 1 FROM user_api_migrations WHERE user_id=$1', [userId]);
    if (migration.rows.length) {
      await client.query('COMMIT');
      return 0;
    }
    const existing = await client.query('SELECT slot,base_url,label FROM user_api_keys WHERE user_id=$1 FOR UPDATE', [userId]);
    const occupied = new Set(existing.rows.map(row => Number(row.slot)));
    const existingProviders = new Set(existing.rows.map(row => row.base_url + '\u0000' + row.label));
    const insertSql = 'INSERT INTO user_api_keys(user_id,slot,label,base_url,model_reasoning,model_coding,model_validation,encrypted_api_key)\n' +
      'VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,slot) DO NOTHING RETURNING slot';
    for (const item of safeCandidates.slice(0, 10)) {
      if (existingProviders.has(item.baseUrl + '\u0000' + item.label)) continue;
      let slot = 1;
      while (occupied.has(slot) && slot <= 10) slot++;
      if (slot > 10) break;
      const result = await client.query(insertSql, [
        userId, slot, item.label, item.baseUrl, item.reasoning, item.coding, item.validation, encrypt(item.key)
      ]);
      if (!result.rows.length) continue;
      occupied.add(slot);
      existingProviders.add(item.baseUrl + '\u0000' + item.label);
      imported++;
    }
    await client.query('INSERT INTO user_api_migrations(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING', [userId]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
  return imported;
}

export function currentUserProviders() { return context.getStore() || null; }

export async function resolveJobUserId(jobId, payloadUserId = null) {
  if (payloadUserId) return String(payloadUserId);
  if (!pool || !jobId) return null;
  const { rows } = await pool.query(
    'SELECT user_id FROM user_job_ownership WHERE job_id=$1 LIMIT 1',
    [String(jobId)]
  );
  return rows[0]?.user_id ? String(rows[0].user_id) : null;
}

export async function withJobProviders(jobId, payloadUserId, operation) {
  const userId = await resolveJobUserId(jobId, payloadUserId);
  return withUserProviders(userId, operation);
}

/**
 * Give an automatically-created continuation the same owner as its source.
 * Falls back to the encrypted source payload's userId for the race where the bridge
 * has not yet finished inserting the source ownership row.
 */
export async function copyJobOwnership(sourceJobId, childJobId, payloadUserId = null) {
  if (!pool) return false;
  if (!sourceJobId || !childJobId) throw new Error('Both source and child job IDs are required.');
  const query = 'INSERT INTO user_job_ownership(job_id,user_id) SELECT $2, COALESCE((SELECT user_id FROM user_job_ownership WHERE job_id=$1), $3::uuid) WHERE EXISTS (SELECT 1 FROM user_job_ownership WHERE job_id=$1) OR $3::uuid IS NOT NULL ON CONFLICT(job_id) DO NOTHING RETURNING user_id';
  const { rows } = await pool.query(query, [String(sourceJobId), String(childJobId), payloadUserId || null]);
  return rows.length > 0;
}

/** Best-effort bridge between the durable job insert and its owner mapping. */
export async function ensureJobOwnership(jobId, userId) {
  if (!pool || !jobId || !userId) return false;
  const { rows } = await pool.query(
    'INSERT INTO user_job_ownership(job_id,user_id) VALUES($1,$2) ON CONFLICT(job_id) DO NOTHING RETURNING user_id',
    [String(jobId), String(userId)]
  );
  return rows.length > 0;
}

export async function withUserProviders(userId, operation) {
  if (!userId) return context.run(null, operation);
  if (!pool) throw new Error('User API database is not configured.');
  const { rows } = await pool.query('SELECT label,base_url,model_reasoning,model_coding,model_validation,encrypted_api_key FROM user_api_keys WHERE user_id=$1 ORDER BY slot', [userId]);
  const providers = [];
  const providerOrder = [];
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
      const entry = { type: 'gemini', apiKey, models: provider.models, name: provider.name, baseUrl: provider.baseUrl };
      providerOrder.push(entry);
      if (!gemini) gemini = entry;
    } else if (/^https:\/\//i.test(provider.baseUrl)) {
      const entry = { ...provider, type: 'openai-compatible' };
      providers.push(entry);
      providerOrder.push(entry);
    }
  }
  return context.run({ userId, providers, gemini, providerOrder }, operation);
}
