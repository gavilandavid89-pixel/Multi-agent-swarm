import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const context = new AsyncLocalStorage();
const connectionString = process.env.SWARM_DATABASE_URL || '';
const keyHex = process.env.SWARM_API_ENCRYPTION_KEY || '';
let pool;
if (connectionString && /^[a-f0-9]{64}$/i.test(keyHex)) {
  pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: false } });
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
export async function importLegacyProvidersForUser(userId) {
  if (!pool) throw new Error('User API database is not configured.');
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
  let imported = 0;
  for (const item of candidates.slice(0, 10)) {
    const exists = await pool.query('SELECT 1 FROM user_api_keys WHERE user_id=$1 AND base_url=$2 AND label=$3 LIMIT 1', [userId, item.baseUrl, item.label]);
    if (exists.rows.length) continue;
    await pool.query(`INSERT INTO user_api_keys(user_id,slot,label,base_url,model_reasoning,model_coding,model_validation,encrypted_api_key)
      VALUES($1,(SELECT COALESCE(MAX(slot),0)+1 FROM user_api_keys WHERE user_id=$1),$2,$3,$4,$5,$6,$7)`,
      [userId,item.label,item.baseUrl,item.reasoning,item.coding,item.validation,encrypt(item.key)]);
    imported++;
  }
  return imported;
}

export function currentUserProviders() { return context.getStore() || null; }
export async function withUserProviders(userId, operation) {
  if (!userId) return context.run(null, operation);
  if (!pool) throw new Error('User API database is not configured.');
  const { rows } = await pool.query('SELECT label,base_url,model_reasoning,model_coding,model_validation,encrypted_api_key FROM user_api_keys WHERE user_id=$1 ORDER BY slot', [userId]);
  const providers = [];
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
      if (!gemini) gemini = { apiKey, models: provider.models, name: provider.name };
    } else if (/^https:\/\//i.test(provider.baseUrl)) providers.push(provider);
  }
  return context.run({ userId, providers, gemini }, operation);
}
