import pg from 'pg';
import Database from 'better-sqlite3';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { applyTokenUsage, prepareContinuationPayload, isBudgetPausedJob } from './tokenAccounting.js';
import fs from 'node:fs';
import path from 'node:path';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL || '';
if (!connectionString) throw new Error('DATABASE_URL es obligatorio: configurá la conexión de PostgreSQL de Render.');
const encryptionHex = process.env.HISTORY_ENCRYPTION_KEY || '';
if (!/^[0-9a-fA-F]{64}$/.test(encryptionHex)) throw new Error('HISTORY_ENCRYPTION_KEY debe contener exactamente 64 caracteres hexadecimales. Generala con: openssl rand -hex 32');
const encryptionKey = Buffer.from(encryptionHex, 'hex');
const configuredConcurrency = Number.parseInt(process.env.WORKER_CONCURRENCY || '1', 10);
const workerConcurrency = Number.isFinite(configuredConcurrency) ? Math.min(8, Math.max(1, configuredConcurrency)) : 1;
const configuredPoolSize = Number.parseInt(process.env.PG_POOL_SIZE || '5', 10);
const poolMax = Math.max(workerConcurrency + 2, Math.min(10, Number.isFinite(configuredPoolSize) ? Math.max(2, configuredPoolSize) : 5));
const pool = new Pool({
  connectionString,
  ssl: /render\.com/i.test(connectionString) ? { rejectUnauthorized: false } : undefined,
  max: poolMax,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});
const now = () => new Date().toISOString();
const locks = new Map();
async function serialized(id, operation) {
  const prior = locks.get(id) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tail = prior.then(() => gate);
  locks.set(id, tail);
  await prior;
  try { return await operation(); }
  finally { release(); if (locks.get(id) === tail) locks.delete(id); }
}
function seal(value) {
  const compressed = deflateRawSync(Buffer.from(JSON.stringify(value), 'utf8'));
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
}
function unseal(blob) {
  const data = Buffer.from(blob);
  if (data[0] !== 1 || data.length < 30) throw new Error('Formato de historial cifrado desconocido.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, data.subarray(1, 13));
  decipher.setAuthTag(data.subarray(13, 29));
  const compressed = Buffer.concat([decipher.update(data.subarray(29)), decipher.final()]);
  return JSON.parse(inflateRawSync(compressed).toString('utf8'));
}
const toIso = value => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const toPublic = row => ({ id: row.id, status: row.status, stage: row.stage, progress: row.progress, attempt: row.attempt, createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at), error: row.error || null });
const artifactsRoot = path.resolve(process.env.ARTIFACTS_DIR || './data/artifacts');
const MAX_ARTIFACTS = 40;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_ARTIFACT_TOTAL = 2 * 1024 * 1024;

export async function initStore() {
  await pool.query(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, stage TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0, attempt INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, error TEXT,
    encrypted_payload BYTEA NOT NULL
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS jobs_updated_idx ON jobs(updated_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs(created_at DESC)');
  // Importa registros de SQLite local si existieran, sin pisar el historial ya presente en PostgreSQL.
  const legacyPath = process.env.DATABASE_PATH || './data/swarm.sqlite';
  if (fs.existsSync(legacyPath)) {
    let legacy;
    try {
      legacy = new Database(legacyPath, { readonly: true, fileMustExist: true });
      const rows = legacy.prepare('SELECT id,status,stage,progress,attempt,created_at,updated_at,error,encrypted_payload FROM jobs').all();
      for (const row of rows) {
        await pool.query(
          'INSERT INTO jobs (id,status,stage,progress,attempt,created_at,updated_at,error,encrypted_payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING',
          [row.id,row.status,row.stage,row.progress,row.attempt,row.created_at,row.updated_at,row.error,row.encrypted_payload]
        );
      }
      if (rows.length) console.info('[worker][history_migration]', JSON.stringify({ imported: rows.length }));
    } catch (error) {
      if (!/no such table: jobs|SQLITE_CANTOPEN/.test(String(error?.message || error))) throw error;
    } finally { try { legacy?.close(); } catch {} }
  }
  await pool.query('SELECT 1');
  console.info('[worker][storage_ready] PostgreSQL conectado; historial cifrado habilitado.');
}
function safeArtifactPath(value) {
  let candidate = String(value || '').trim().replace(/^\x60|\x60$/g, '').replace(/^(?:Archivo|File|Ruta)\s*:\s*/i, '').replace(/^\.\//, '').replace(/\\/g, '/');
  candidate = candidate.split(/[\r\n]/)[0].trim().replace(/^['"]|['"]$/g, '');
  if (!candidate || candidate.startsWith('/') || /^[a-zA-Z]:/.test(candidate) || candidate.split('/').some(part => !part || part === '.' || part === '..')) return null;
  if (!/^[\p{L}\p{N}._/-]+$/u.test(candidate) || candidate.length > 180) return null;
  return candidate;
}
function extractArtifacts(delivery) {
  const source = String(delivery || '');
  const re = /(?:^|\n)(?:#{1,6}\s+([^\n]+)|\*\*([^*\n]+)\*\*|(?:Archivo|File|Ruta)\s*:\s*([^\n]+))\s*\n\s*\x60{3}[^\n]*\n([\s\S]*?)\n\x60{3}/g;
  const files = []; let match; let total = 0;
  while ((match = re.exec(source)) && files.length < MAX_ARTIFACTS) {
    const name = safeArtifactPath(match[1] || match[2] || match[3]);
    const content = match[4]; const size = Buffer.byteLength(content, 'utf8');
    if (!name || !size || size > MAX_ARTIFACT_BYTES || total + size > MAX_ARTIFACT_TOTAL || files.some(file => file.path === name)) continue;
    files.push({ path: name, content, size, contentType: name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.json') ? 'application/json; charset=utf-8' : name.endsWith('.webmanifest') ? 'application/manifest+json; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.svg') ? 'image/svg+xml; charset=utf-8' : /\.(?:js|mjs|cjs|jsx|ts|tsx)$/i.test(name) ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8' });
    total += size;
  }
  return files;
}
export async function saveArtifacts(id, delivery) {
  const record = await getPayload(id);
  if (!record) return [];
  const files = extractArtifacts(delivery);
  if (!files.length) return listArtifacts(id);
  await updateJob(id, { payload: { artifacts: files } });
  return files.map(({ path: filePath, size, contentType }) => ({ path: filePath, size, contentType }));
}
export async function listArtifacts(id) {
  const record = await getPayload(id);
  return (record?.payload?.artifacts || []).map(({ path: filePath, size, contentType }, index) => ({ index, path: filePath, size, contentType }));
}
export async function getArtifact(id, index) {
  const record = await getPayload(id);
  const file = record?.payload?.artifacts?.[Number(index)];
  if (!file || !Number.isInteger(Number(index)) || Number(index) < 0) return null;
  return { path: file.path, content: file.content, size: file.size, contentType: file.contentType };
}
export async function createJob(objective, requestedTokenBudget, userId = null) {
  const timestamp = now();
  const rawDefault = Number.parseInt(process.env.MAX_TASK_TOKENS || '50000', 10);
  const defaultBudget = Number.isFinite(rawDefault) ? Math.min(100000, Math.max(4000, rawDefault)) : 50000;
  const tokenBudget = Number.isFinite(Number(requestedTokenBudget)) ? Math.min(100000, Math.max(4000, Math.round(Number(requestedTokenBudget) / 1000) * 1000)) : defaultBudget;
  const row = { id: randomUUID(), status: 'queued', stage: 'En cola', progress: 0, attempt: 0, created_at: timestamp, updated_at: timestamp, error: null, encrypted_payload: seal({ objective, tokenBudget, userId, transcript: [], artifacts: [], result: null, lastCheckpoint: 'created' }) };
  await pool.query('INSERT INTO jobs (id,status,stage,progress,attempt,created_at,updated_at,error,encrypted_payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [row.id,row.status,row.stage,row.progress,row.attempt,row.created_at,row.updated_at,row.error,row.encrypted_payload]);
  return toPublic(row);
}
/**
 * Fork a budget-paused task into a fresh 100k-token batch while preserving its encrypted
 * checkpoint, source artifacts and agent decisions. The source row lock makes the action idempotent.
 */
export async function createContinuationJob(sourceId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [sourceId]);
    const source = rows[0];
    if (!source) { await client.query('ROLLBACK'); return { error: 'No existe esa tarea.', status: 404 }; }
    const sourcePayload = unseal(source.encrypted_payload);

    if (sourcePayload.continuedByJobId) {
      const { rows: existingRows } = await client.query('SELECT * FROM jobs WHERE id=$1', [sourcePayload.continuedByJobId]);
      if (existingRows[0]) {
        await client.query('COMMIT');
        return { job: toPublic(existingRows[0]), created: false };
      }
    }

    if (!isBudgetPausedJob(source)) {
      await client.query('ROLLBACK');
      return { error: 'Solo se puede abrir una nueva tanda cuando la tarea está pausada por presupuesto de tokens.', status: 409 };
    }

    const closedAt = now();
    const payload = prepareContinuationPayload(sourcePayload, { id: source.id, stage: source.stage }, closedAt);

    const timestamp = closedAt;
    const childId = randomUUID();
    const childRow = {
      id: childId, status: 'queued', stage: 'Nueva tanda · recuperando checkpoint',
      progress: Math.min(Number(source.progress) || 0, 90),
      attempt: Number(source.attempt) || 0,
      created_at: timestamp, updated_at: timestamp, error: null,
      encrypted_payload: seal(payload)
    };
    await client.query(
      'INSERT INTO jobs (id,status,stage,progress,attempt,created_at,updated_at,error,encrypted_payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [childRow.id,childRow.status,childRow.stage,childRow.progress,childRow.attempt,childRow.created_at,childRow.updated_at,childRow.error,childRow.encrypted_payload]
    );
    sourcePayload.continuedByJobId = childId;
    sourcePayload.continuedAt = timestamp;
    await client.query('UPDATE jobs SET updated_at=$2, encrypted_payload=$3 WHERE id=$1', [sourceId, timestamp, seal(sourcePayload)]);
    await client.query('COMMIT');
    return { job: toPublic(childRow), created: true };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

/** Return budget-paused jobs that still need an automatic continuation. */
export async function recoverableBudgetContinuations() {
  const { rows } = await pool.query("SELECT * FROM jobs WHERE status='needs_review' AND stage ILIKE '%presupuesto%' ORDER BY updated_at ASC");
  return rows.flatMap(row => {
    try {
      const payload = unseal(row.encrypted_payload);
      return payload.continuedByJobId ? [] : [{ id: row.id, checkpoint: payload.lastCheckpoint || null, userId: payload.userId || null }];
    } catch (error) {
      console.error('[worker][budget_continuation_recovery_read_failed]', JSON.stringify({ jobId: row.id, message: String(error?.message || error).slice(0, 200) }));
      return [];
    }
  });
}

export async function getJobsByIds(ids) {
  if (!Array.isArray(ids)) throw new TypeError('ids must be an array.');
  const safeIds = [...new Set(ids.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 100))].slice(0, 100);
  if (!safeIds.length) return [];
  const { rows } = await pool.query('SELECT * FROM jobs WHERE id = ANY($1::text[])', [safeIds]);
  const byId = new Map(rows.map(row => [String(row.id), toPublic(row)]));
  return safeIds.map(id => byId.get(id)).filter(Boolean);
}
export async function getJob(id) {
  const { rows } = await pool.query('SELECT * FROM jobs WHERE id=$1', [id]);
  return rows[0] ? toPublic(rows[0]) : null;
}
export async function getPayload(id) {
  const { rows } = await pool.query('SELECT * FROM jobs WHERE id=$1', [id]);
  return rows[0] ? { publicJob: toPublic(rows[0]), payload: unseal(rows[0].encrypted_payload) } : null;
}
/**
 * Cross-process per-job mutex. A PostgreSQL session lock prevents duplicate work during
 * overlapping deploys or when the service runs more than one instance. It is released
 * automatically if the process or database connection dies.
 */
export async function withJobLock(id, operation) {
  let client;
  let locked = false;
  let discardConnection = null;
  const jobId = String(id);
  try {
    client = await pool.connect();
    const { rows } = await client.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [jobId]
    );
    locked = Boolean(rows[0]?.locked);
    if (!locked) return { lockBusy: true };
    return await operation();
  } finally {
    if (client) {
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [jobId]);
        } catch (error) {
          discardConnection = error;
          console.error('[worker][job_lock_release_error]', JSON.stringify({ jobId, message: String(error?.message || error).slice(0, 300) }));
        }
      }
      client.release(discardConnection || undefined);
    }
  }
}

export async function recordTokenUsage(id, info = {}) {
  return serialized(id, async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
      const row = rows[0];
      if (!row) { await client.query('COMMIT'); return { missing: true, duplicate: false }; }
      const payload = unseal(row.encrypted_payload);
      const usageId = String(info.usageId || randomUUID());
      const accounted = applyTokenUsage(payload.tokenUsage, { ...info, usageId }, {
        eventIds: payload.usageEventIds || [],
        status: row.status
      });
      payload.tokenUsage = accounted.usage;
      payload.usageEventIds = accounted.eventIds;
      if (accounted.event) {
        const entry = {
          at: now(),
          agent: 'sistema',
          type: 'usage',
          content: JSON.stringify(accounted.event)
        };
        payload.transcript = [...(Array.isArray(payload.transcript) ? payload.transcript : []), entry].slice(-400);
      }
      const updatedAt = now();
      await client.query(
        'UPDATE jobs SET updated_at=$2, encrypted_payload=$3 WHERE id=$1',
        [id, updatedAt, seal(payload)]
      );
      await client.query('COMMIT');
      return {
        duplicate: accounted.duplicate,
        missing: false,
        usage: payload.tokenUsage,
        event: accounted.event,
        statusAtResponse: row.status
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  });
}
export async function updateJob(id, patch = {}) {
  return serialized(id, async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
      const row = rows[0];
      if (!row) { await client.query('COMMIT'); return null; }
      const current = toPublic(row); const payload = unseal(row.encrypted_payload);
      if (patch.payload) Object.assign(payload, patch.payload);
      const next = { status: patch.status ?? current.status, stage: patch.stage ?? current.stage, progress: patch.progress ?? current.progress, attempt: patch.attempt ?? current.attempt, updatedAt: now(), error: patch.error === undefined ? row.error : patch.error, encrypted: seal(payload) };
      await client.query('UPDATE jobs SET status=$2,stage=$3,progress=$4,attempt=$5,updated_at=$6,error=$7,encrypted_payload=$8 WHERE id=$1', [id,next.status,next.stage,next.progress,next.attempt,next.updatedAt,next.error,next.encrypted]);
      await client.query('COMMIT');
      return { id, status: next.status, stage: next.stage, progress: next.progress, attempt: next.attempt, createdAt: current.createdAt, updatedAt: next.updatedAt, error: next.error || null };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  });
}
const VALID_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'needs_review']);
export async function listJobs({ limit = 25, offset = 0, status = '' } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const filterStatus = VALID_STATUSES.has(status) ? status : '';
  const args = filterStatus ? [filterStatus, safeLimit, safeOffset] : [safeLimit, safeOffset];
  const where = filterStatus ? ' WHERE status=$1' : '';
  const { rows } = await pool.query(`SELECT * FROM jobs${where} ORDER BY created_at DESC LIMIT $${filterStatus ? 2 : 1} OFFSET $${filterStatus ? 3 : 2}`, args);
  const countArgs = filterStatus ? [filterStatus] : [];
  const count = await pool.query(`SELECT COUNT(*)::int AS count FROM jobs${where}`, countArgs);
  const total = count.rows[0].count;
  const jobs = rows.map(row => {
    const publicJob = toPublic(row);
    try {
      const payload = unseal(row.encrypted_payload);
      return {
        ...publicJob,
        userId: typeof payload.userId === 'string' ? payload.userId : null,
        continuationOf: typeof payload.continuationOf === 'string' ? payload.continuationOf : null
      };
    } catch {
      return { ...publicJob, userId: null, continuationOf: null };
    }
  });
  return { jobs, total, limit: safeLimit, offset: safeOffset, hasMore: safeOffset + rows.length < total, status: filterStatus || 'all' };
}
export async function historySummary() {
  const { rows } = await pool.query('SELECT status, COUNT(*)::int AS count FROM jobs GROUP BY status');
  const byStatus = Object.fromEntries(rows.map(row => [row.status, row.count]));
  const count = rows.reduce((sum, row) => sum + row.count, 0);
  return { hasHistory: count > 0, count, byStatus: { queued: byStatus.queued || 0, running: byStatus.running || 0, completed: byStatus.completed || 0, failed: byStatus.failed || 0, needs_review: byStatus.needs_review || 0 } };
}
export async function recoverableJobs() {
  const { rows } = await pool.query("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at ASC");
  return rows.map(row => { try { const payload = unseal(row.encrypted_payload); return { id: row.id, retryAt: payload.retryAt || null }; } catch { return { id: row.id, retryAt: null }; } });
}
export async function closeStore() { await pool.end(); }
