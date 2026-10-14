import { AsyncLocalStorage } from 'node:async_hooks';
import { createDecipheriv } from 'node:crypto';
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
    if (/generativelanguage\\.googleapis\\.com/i.test(provider.baseUrl)) {
      if (!gemini) gemini = { apiKey, models: provider.models, name: provider.name };
    } else if (/^https:\\/\\//i.test(provider.baseUrl)) providers.push(provider);
  }
  return context.run({ userId, providers, gemini }, operation);
}
