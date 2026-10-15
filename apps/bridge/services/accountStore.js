import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.SWARM_DATABASE_URL || '';
// Upgrade PostgreSQL's weaker sslmode=require to hostname/certificate verification where supported.
const verifiedConnectionString = connectionString.replace(/([?&])sslmode=require(?=(&|$))/i, '$1sslmode=verify-full');
const encryptionKeyHex = process.env.SWARM_API_ENCRYPTION_KEY || '';
if (!connectionString) throw new Error('Falta SWARM_DATABASE_URL para la base de cuentas de Swarm.');
if (!/^[a-f0-9]{64}$/i.test(encryptionKeyHex)) throw new Error('SWARM_API_ENCRYPTION_KEY debe ser una clave hexadecimal de 32 bytes.');
export const pool = new Pool({ connectionString: verifiedConnectionString, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: true } });
const encryptionKey = Buffer.from(encryptionKeyHex, 'hex');
const digest = value => createHash('sha256').update(String(value)).digest('hex');

export async function initAccountStore() {
  await pool.query(`CREATE TABLE IF NOT EXISTS app_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), disabled_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS app_sessions_user_expiry_idx ON app_sessions(user_id, expires_at)');
  await pool.query(`CREATE TABLE IF NOT EXISTS app_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code_hash TEXT NOT NULL UNIQUE,
    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, used_by UUID REFERENCES app_users(id) ON DELETE SET NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    slot SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 10), label TEXT NOT NULL, base_url TEXT NOT NULL,
    model_reasoning TEXT NOT NULL, model_coding TEXT, model_validation TEXT, encrypted_api_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(user_id, slot)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_job_ownership (
    job_id TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS user_job_ownership_user_created_idx ON user_job_ownership(user_id, created_at DESC)');
  await pool.query(`CREATE TABLE IF NOT EXISTS user_api_migrations (
    user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE, migrated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query('SELECT 1');
}


export function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}
export function verifyPassword(password, encoded) {
  try {
    const [kind, saltHex, hashHex] = String(encoded).split(':');
    if (kind !== 'scrypt' || !/^[a-f0-9]{32}$/i.test(saltHex) || !/^[a-f0-9]{128}$/i.test(hashHex)) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}
export function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(':');
}
export function decryptSecret(value) {
  const [ivHex, tagHex, encryptedHex] = String(value).split(':');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]).toString('utf8');
}
export async function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO app_sessions(user_id, token_hash, expires_at) VALUES($1,$2,now()+interval \'7 days\')', [userId, digest(token)]);
  return token;
}
export async function findSession(token) {
  if (!token) return null;
  const { rows } = await pool.query(`SELECT u.id, u.username, u.role FROM app_sessions s JOIN app_users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`, [digest(token)]);
  return rows[0] || null;
}
export async function revokeSession(token) {
  if (token) await pool.query('UPDATE app_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [digest(token)]);
}
export async function importLegacyApiKeys(userId) {
  const candidates = [];
  if (process.env.GEMINI_API_KEY) candidates.push({ label: 'Gemini', key: process.env.GEMINI_API_KEY, baseUrl: 'https://generativelanguage.googleapis.com', model: process.env.GEMINI_MODEL_REASONING || 'gemini-3.8-flash', coding: process.env.GEMINI_MODEL_CODING || 'gemini-3.8-flash', validation: process.env.GEMINI_MODEL_VALIDATION || 'gemini-3.8-flash' });
  if (process.env.GROQ_API_KEY) candidates.push({ label: 'Groq', key: process.env.GROQ_API_KEY, baseUrl: 'https://api.groq.com/openai/v1', model: process.env.GROQ_MODEL_REASONING || 'openai/gpt-oss-120b', coding: process.env.GROQ_MODEL_CODING || 'openai/gpt-oss-120b', validation: process.env.GROQ_MODEL_VALIDATION || 'openai/gpt-oss-20b' });
  try {
    const extra = JSON.parse(process.env.AI_FALLBACK_PROVIDERS || '[]');
    if (Array.isArray(extra)) for (const item of extra) {
      const keyName = String(item?.apiKeyEnv || '');
      const key = /^[A-Z][A-Z0-9_]{1,79}$/.test(keyName) ? process.env[keyName] : '';
      const baseUrl = String(item?.baseUrl || '').trim().replace(/\/+$/, '');
      if (key && /^https:\/\//i.test(baseUrl) && !candidates.some(x => x.baseUrl === baseUrl)) candidates.push({ label: String(item.name || 'Proveedor externo').slice(0, 80), key, baseUrl, model: String(item.model || 'openai/gpt-oss-120b'), coding: String(item.model || 'openai/gpt-oss-120b'), validation: String(item.model || 'openai/gpt-oss-120b') });
    }
  } catch { /* Invalid legacy metadata is intentionally not logged. */ }
  let imported = 0;
  for (const item of candidates.slice(0, 10)) {
    const { rows } = await pool.query('SELECT 1 FROM user_api_keys WHERE user_id=$1 AND base_url=$2 LIMIT 1', [userId, item.baseUrl]);
    if (rows.length) continue;
    await pool.query(`INSERT INTO user_api_keys(user_id,slot,label,base_url,model_reasoning,model_coding,model_validation,encrypted_api_key)
      VALUES($1, (SELECT COALESCE(MAX(slot),0)+1 FROM user_api_keys WHERE user_id=$1), $2,$3,$4,$5,$6,$7)`,
      [userId, item.label, item.baseUrl, item.model, item.coding, item.validation, encryptSecret(item.key)]);
    imported++;
  }
  return imported;
}
export async function listApiKeys(userId) {
  const { rows } = await pool.query('SELECT id,slot,label,base_url,model_reasoning,model_coding,model_validation,created_at,updated_at FROM user_api_keys WHERE user_id=$1 ORDER BY slot', [userId]);
  return rows;
}
export async function saveApiKeys(userId, entries) {
  if (!Array.isArray(entries) || entries.length > 10) throw new Error('Podés guardar hasta 10 APIs.');
  const client = await pool.connect();
  const allowedHosts = new Set(['api.openai.com','api.groq.com','openrouter.ai','generativelanguage.googleapis.com','api.together.xyz','api.deepseek.com','api.mistral.ai','api.fireworks.ai','api.perplexity.ai','api.cohere.com']);
  const defaults = {
    'api.openai.com': ['OpenAI', 'gpt-4o-mini', 'gpt-4o-mini', 'gpt-4o-mini'],
    'api.groq.com': ['Groq', 'openai/gpt-oss-120b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    'openrouter.ai': ['OpenRouter', 'openai/gpt-4o-mini', 'openai/gpt-4o-mini', 'openai/gpt-4o-mini'],
    'generativelanguage.googleapis.com': ['Gemini', 'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.8-flash'],
    'api.together.xyz': ['Together AI', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    'api.deepseek.com': ['DeepSeek', 'deepseek-chat', 'deepseek-chat', 'deepseek-chat'],
    'api.mistral.ai': ['Mistral AI', 'mistral-small-latest', 'mistral-small-latest', 'mistral-small-latest'],
    'api.fireworks.ai': ['Fireworks AI', 'accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],
    'api.perplexity.ai': ['Perplexity', 'sonar', 'sonar', 'sonar'],
    'api.cohere.com': ['Cohere', 'command-a-03-2025', 'command-a-03-2025', 'command-a-03-2025']
  };
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT slot,base_url,encrypted_api_key FROM user_api_keys WHERE user_id=$1', [userId]);
    const bySlot = new Map(existing.rows.map(row => [Number(row.slot), row]));
    const seen = new Set();
    for (const item of entries) {
      const slot = Number(item.slot);
      if (!Number.isInteger(slot) || slot < 1 || slot > 10 || seen.has(slot)) throw new Error('Campo de API inválido o repetido.');
      seen.add(slot);
      const apiKey = typeof item.apiKey === 'string' ? item.apiKey.trim() : '';
      const previous = bySlot.get(slot);
      let baseUrl = String(item.baseUrl || '').trim().replace(/\/+$/, '');
      const legacyModel = String(item.model || '').trim().slice(0,120);
      const suppliedModels = item.models && typeof item.models === 'object' ? item.models : {};
      let modelReasoning = String(suppliedModels.reasoning || legacyModel).trim().slice(0,120);
      let modelCoding = String(suppliedModels.coding || legacyModel).trim().slice(0,120);
      let modelValidation = String(suppliedModels.validation || legacyModel).trim().slice(0,120);
      if (!baseUrl && apiKey) {
        if (/^AIza[0-9A-Za-z_-]{20,}$/.test(apiKey)) baseUrl = 'https://generativelanguage.googleapis.com';
        else if (/^gsk_[0-9A-Za-z]{20,}$/.test(apiKey)) baseUrl = 'https://api.groq.com/openai/v1';
        else if (/^sk-or-v1-[0-9a-f]{20,}$/i.test(apiKey)) baseUrl = 'https://openrouter.ai/api/v1';
        else baseUrl = 'https://api.openai.com/v1';
      }
      if (!apiKey && !previous) continue;
      if (!baseUrl) throw new Error(`Elegí un proveedor para la API ${slot}.`);
      let parsedUrl;
      try { parsedUrl = new URL(baseUrl); } catch { throw new Error(`La URL del proveedor de la API ${slot} no es válida.`); }
      const hostname = parsedUrl.hostname.toLowerCase();
      const previousHost = (() => { try { return new URL(String(previous?.base_url || '')).hostname.toLowerCase(); } catch { return ''; } })();
      // Legacy endpoints came from the administrator's trusted server environment.
      // They remain editable in-place, but users cannot introduce new arbitrary hosts.
      const legacyExistingHost = Boolean(previous && previousHost === hostname && !allowedHosts.has(hostname));
      if (parsedUrl.protocol !== 'https:' || (!allowedHosts.has(hostname) && !legacyExistingHost) || parsedUrl.username || parsedUrl.password || parsedUrl.hash || parsedUrl.search) {
        throw new Error(`El proveedor de la API ${slot} no está permitido por la política de seguridad.`);
      }
      const canonicalBaseUrl = legacyExistingHost ? String(previous.base_url)
        : hostname === 'openrouter.ai' ? 'https://openrouter.ai/api/v1'
        : hostname === 'generativelanguage.googleapis.com' ? 'https://generativelanguage.googleapis.com'
        : `https://${hostname}${parsedUrl.pathname.replace(/\/+$/, '')}`;
      if (!apiKey && previous && previousHost !== hostname) {
        throw new Error(`Para cambiar el proveedor de la API ${slot}, pegá también la nueva clave. La clave anterior se conserva únicamente para su proveedor original.`);
      }
      const [defaultLabel, defaultReasoning, defaultCoding, defaultValidation] = defaults[hostname];
      const label = String(item.label || defaultLabel).trim().slice(0,80) || defaultLabel;
      modelReasoning = modelReasoning || defaultReasoning;
      modelCoding = modelCoding || defaultCoding;
      modelValidation = modelValidation || defaultValidation;
      if (!apiKey && previous) {
        await client.query(`UPDATE user_api_keys SET label=$3,base_url=$4,model_reasoning=$5,model_coding=$6,model_validation=$7,updated_at=now() WHERE user_id=$1 AND slot=$2`,
          [userId, slot, label, canonicalBaseUrl, modelReasoning, modelCoding, modelValidation]);
      } else {
        await client.query(`INSERT INTO user_api_keys(user_id,slot,label,base_url,model_reasoning,model_coding,model_validation,encrypted_api_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT(user_id,slot) DO UPDATE SET label=EXCLUDED.label,base_url=EXCLUDED.base_url,model_reasoning=EXCLUDED.model_reasoning,model_coding=EXCLUDED.model_coding,model_validation=EXCLUDED.model_validation,encrypted_api_key=EXCLUDED.encrypted_api_key,updated_at=now()`,
          [userId, slot, label, canonicalBaseUrl, modelReasoning, modelCoding, modelValidation, encryptSecret(apiKey)]);
      }
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  return listApiKeys(userId);
}
export async function deleteApiKey(userId, slot) {
  await pool.query('DELETE FROM user_api_keys WHERE user_id=$1 AND slot=$2', [userId, slot]);
}
export async function createInvite(userId, hours = 72) {
  const code = randomBytes(24).toString('base64url');
  const codeHash = digest(code);
  const expiresHours = Math.max(1, Math.min(720, Number(hours) || 72));
  await pool.query('INSERT INTO app_invites(code_hash,created_by,expires_at) VALUES($1,$2,now()+($3 * interval \'1 hour\'))', [codeHash, userId, expiresHours]);
  return { code, expiresHours };
}
export async function registerFromInvite(username, password, code) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invite = await client.query('SELECT id FROM app_invites WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE', [digest(code)]);
    if (!invite.rows.length) throw new Error('La invitación no existe, venció o ya fue usada.');
    const inserted = await client.query('INSERT INTO app_users(username,password_hash,role) VALUES($1,$2,\'user\') RETURNING id,username,role', [username, hashPassword(password)]);
    await client.query('UPDATE app_invites SET used_at=now(),used_by=$1 WHERE id=$2', [inserted.rows[0].id, invite.rows[0].id]);
    await client.query('COMMIT');
    return inserted.rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
