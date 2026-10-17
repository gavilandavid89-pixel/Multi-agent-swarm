import pg from 'pg';
import Database from 'better-sqlite3';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { applyTokenUsage, prepareContinuationPayload, isBudgetPausedJob } from './tokenAccounting.js';
import { generateTaskTitle } from './taskTitle.js';
import fs from 'node:fs';
import path from 'node:path';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL || '';
if (!connectionString) throw new Error('DATABASE_URL es obligatorio: configurá la conexión de PostgreSQL de Render.');
const isRenderDatabase = /render\.com/i.test(connectionString);
// Render's internal PostgreSQL endpoints may use a platform CA. For other external
// PostgreSQL URLs, upgrade sslmode=require to full certificate + hostname verification.
const verifiedConnectionString = isRenderDatabase
  ? connectionString
  : connectionString.replace(/([?&])sslmode=require(?=(&|$))/i, '$1sslmode=verify-full');
const encryptionHex = process.env.HISTORY_ENCRYPTION_KEY || '';
if (!/^[0-9a-fA-F]{64}$/.test(encryptionHex)) throw new Error('HISTORY_ENCRYPTION_KEY debe contener exactamente 64 caracteres hexadecimales. Generala con: openssl rand -hex 32');
const encryptionKey = Buffer.from(encryptionHex, 'hex');
const configuredConcurrency = Number.parseInt(process.env.WORKER_CONCURRENCY || '1', 10);
const workerConcurrency = Number.isFinite(configuredConcurrency) ? Math.min(8, Math.max(1, configuredConcurrency)) : 1;
const configuredPoolSize = Number.parseInt(process.env.PG_POOL_SIZE || '5', 10);
const poolMax = Math.max(workerConcurrency + 2, Math.min(10, Number.isFinite(configuredPoolSize) ? Math.max(2, configuredPoolSize) : 5));
const pool = new Pool({
  connectionString: verifiedConnectionString,
  ssl: isRenderDatabase ? { rejectUnauthorized: false } : undefined,
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
const toPublic = row => {
  let title = '';
  try {
    const payload = unseal(row.encrypted_payload);
    title = payload.title || generateTaskTitle(payload.objective);
  } catch {}
  return { id: row.id, title: title || `Tarea ${String(row.id).slice(0, 8)}`, status: row.status, stage: row.stage, progress: row.progress, attempt: row.attempt, createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at), error: row.error || null };
};
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
  await pool.query(`CREATE TABLE IF NOT EXISTS diagnostic_reports (
    report_id TEXT PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    service TEXT NOT NULL,
    environment TEXT NOT NULL,
    summary TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    task_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    report JSONB NOT NULL,
    triage JSONB,
    attempts INTEGER NOT NULL DEFAULT 0
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS diagnostic_reports_status_idx ON diagnostic_reports(status, received_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS diagnostic_reports_fingerprint_idx ON diagnostic_reports(fingerprint, received_at DESC)');
  await pool.query(`CREATE TABLE IF NOT EXISTS job_request_idempotency (
    idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
    job_id TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL
  )`);
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

const DIAGNOSTIC_MAX_REPORTS = 5000;
function sanitizeDiagnosticText(value, max = 2000) {
  return String(value ?? '')
    .replace(/(?:bearer|token|api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+/ig, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/ig, 'https://[REDACTED]@')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED]')
    .slice(0, max);
}
function normalizeDiagnosticReport(input = {}) {
  const reportId = typeof input.reportId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(input.reportId) ? input.reportId : randomUUID();
  const severity = ['info','warning','error','critical'].includes(input.severity) ? input.severity : 'error';
  const category = ['runtime','network','database','browser','validation','dependency','timeout','unknown'].includes(input.category) ? input.category : 'unknown';
  const service = sanitizeDiagnosticText(input.service || 'unknown', 80);
  const environment = ['development','test','staging','production','unknown'].includes(input.environment) ? input.environment : 'unknown';
  const summary = sanitizeDiagnosticText(input.summary || input.error?.message || 'Error sin resumen', 500);
  const error = input.error && typeof input.error === 'object' ? {
    name: sanitizeDiagnosticText(input.error.name || 'Error', 100),
    message: sanitizeDiagnosticText(input.error.message || summary, 1200),
    stack: sanitizeDiagnosticText(input.error.stack || '', 8000)
  } : null;
  const correlation = input.correlation && typeof input.correlation === 'object' ? {
    taskId: sanitizeDiagnosticText(input.correlation.taskId || '', 100),
    checkpoint: sanitizeDiagnosticText(input.correlation.checkpoint || '', 120),
    requestId: sanitizeDiagnosticText(input.correlation.requestId || '', 100),
    traceId: sanitizeDiagnosticText(input.correlation.traceId || '', 100)
  } : {};
  const operation = input.operation && typeof input.operation === 'object' ? {
    name: sanitizeDiagnosticText(input.operation.name || '', 120),
    attempt: Math.max(0, Math.min(100, Number(input.operation.attempt) || 0)),
    elapsedMs: Math.max(0, Math.min(86400000, Number(input.operation.elapsedMs) || 0)),
    retryable: input.operation.retryable === true,
    idempotencyKey: sanitizeDiagnosticText(input.operation.idempotencyKey || '', 100)
  } : {};
  const reproduction = input.reproduction && typeof input.reproduction === 'object' ? {
    steps: Array.isArray(input.reproduction.steps) ? input.reproduction.steps.slice(0, 12).map(x => sanitizeDiagnosticText(x, 500)) : [],
    expected: sanitizeDiagnosticText(input.reproduction.expected || '', 1000),
    actual: sanitizeDiagnosticText(input.reproduction.actual || '', 1000)
  } : {};
  const runtime = input.runtime && typeof input.runtime === 'object' ? {
    coldStartSuspected: input.runtime.coldStartSuspected === true,
    serviceReady: input.runtime.serviceReady === true,
    httpStatus: Number.isInteger(input.runtime.httpStatus) ? Math.max(0, Math.min(599, input.runtime.httpStatus)) : null
  } : {};
  const report = {
    schemaVersion: 1, reportId,
    occurredAt: Number.isFinite(Date.parse(input.occurredAt)) ? new Date(input.occurredAt).toISOString() : new Date().toISOString(),
    service, environment, severity, category, summary, error, correlation, operation, reproduction, runtime
  };
  const fingerprint = createHash('sha256').update(JSON.stringify([service, category, error?.name, error?.message || summary, operation.name])).digest('hex');
  return { reportId, report, severity, category, service, environment, summary, fingerprint, taskId: correlation.taskId || null };
}
export async function saveDiagnosticReport(input) {
  const normalized = normalizeDiagnosticReport(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prior = await client.query('SELECT report_id FROM diagnostic_reports WHERE report_id=$1 FOR UPDATE', [normalized.reportId]);
    if (prior.rows[0]) {
      await client.query('COMMIT');
      return { reportId: normalized.reportId, duplicate: true, status: 'queued' };
    }
    const recent = await client.query(
      "SELECT report_id FROM diagnostic_reports WHERE fingerprint=$1 AND received_at > now() - interval '10 minutes' ORDER BY received_at DESC LIMIT 1",
      [normalized.fingerprint]
    );
    if (recent.rows[0]) {
      await client.query('COMMIT');
      return { reportId: recent.rows[0].report_id, duplicate: true, deduplicated: true };
    }
    await client.query(
      'INSERT INTO diagnostic_reports(report_id,occurred_at,severity,category,service,environment,summary,fingerprint,task_id,status,report) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)',
      [normalized.reportId, normalized.report.occurredAt, normalized.severity, normalized.category, normalized.service, normalized.environment, normalized.summary, normalized.fingerprint, normalized.taskId, 'queued', JSON.stringify(normalized.report)]
    );
    await client.query("DELETE FROM diagnostic_reports WHERE report_id IN (SELECT report_id FROM diagnostic_reports ORDER BY received_at DESC OFFSET $1)", [DIAGNOSTIC_MAX_REPORTS]);
    await client.query('COMMIT');
    return { reportId: normalized.reportId, duplicate: false, status: 'queued' };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}
export async function listDiagnosticReports({ limit = 25, offset = 0, status = '' } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const values = status ? [status, safeLimit, safeOffset] : [safeLimit, safeOffset];
  const where = status ? 'WHERE status=$1' : '';
  const limitPos = status ? '$2' : '$1';
  const offsetPos = status ? '$3' : '$2';
  const { rows } = await pool.query(
    `SELECT report_id,occurred_at,received_at,severity,category,service,environment,summary,task_id,status,attempts,triage FROM diagnostic_reports ${where} ORDER BY received_at DESC LIMIT ${limitPos} OFFSET ${offsetPos}`,
    values
  );
  return rows.map(row => ({ reportId: row.report_id, occurredAt: toIso(row.occurred_at), receivedAt: toIso(row.received_at), severity: row.severity, category: row.category, service: row.service, environment: row.environment, summary: row.summary, taskId: row.task_id, status: row.status, attempts: row.attempts, triage: row.triage }));
}
export async function getDiagnosticReport(reportId) {
  const { rows } = await pool.query('SELECT report_id,occurred_at,received_at,severity,category,service,environment,summary,task_id,status,attempts,report,triage FROM diagnostic_reports WHERE report_id=$1', [reportId]);
  const row = rows[0];
  return row ? { reportId: row.report_id, occurredAt: toIso(row.occurred_at), receivedAt: toIso(row.received_at), severity: row.severity, category: row.category, service: row.service, environment: row.environment, summary: row.summary, taskId: row.task_id, status: row.status, attempts: row.attempts, report: row.report, triage: row.triage } : null;
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
  return (record?.payload?.artifacts || []).map(({ path: filePath, size, contentType, content }, index) => ({ index, path: filePath, size, contentType, version: createHash('sha256').update(String(content ?? '')).digest('hex').slice(0, 16) }));
}
export async function getArtifact(id, index) {
  const record = await getPayload(id);
  const file = record?.payload?.artifacts?.[Number(index)];
  if (!file || !Number.isInteger(Number(index)) || Number(index) < 0) return null;
  return { path: file.path, content: file.content, size: file.size, contentType: file.contentType };
}
export async function createJob(objective, requestedTokenBudget, userId = null, idempotencyKey = null) {
  const timestamp = now();
  const rawDefault = Number.parseInt(process.env.MAX_TASK_TOKENS || '1000000', 10);
  const defaultBudget = Number.isFinite(rawDefault) ? Math.min(1000000, Math.max(4000, rawDefault)) : 1000000;
  const tokenBudget = Number.isFinite(Number(requestedTokenBudget)) ? Math.min(1000000, Math.max(4000, Math.round(Number(requestedTokenBudget) / 1000) * 1000)) : defaultBudget;
  const title = generateTaskTitle(objective);
  const row = { id: randomUUID(), status: 'queued', stage: 'En cola', progress: 0, attempt: 0, created_at: timestamp, updated_at: timestamp, error: null, encrypted_payload: seal({ objective, title, tokenBudget, userId, transcript: [], artifacts: [], result: null, lastCheckpoint: 'created' }) };
  if (!idempotencyKey) {
    await pool.query('INSERT INTO jobs (id,status,stage,progress,attempt,created_at,updated_at,error,encrypted_payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [row.id,row.status,row.stage,row.progress,row.attempt,row.created_at,row.updated_at,row.error,row.encrypted_payload]);
    return toPublic(row);
  }
  const requestHash = createHash('sha256').update(JSON.stringify({ objective, tokenBudget, userId })).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO job_request_idempotency (idempotency_key,request_hash,job_id,created_at) VALUES ($1,$2,NULL,$3) ON CONFLICT (idempotency_key) DO NOTHING',
      [idempotencyKey, requestHash, timestamp]
    );
    const { rows: keyRows } = await client.query(
      'SELECT request_hash,job_id FROM job_request_idempotency WHERE idempotency_key=$1 FOR UPDATE',
      [idempotencyKey]
    );
    const existingKey = keyRows[0];
    if (!existingKey) throw new Error('No se pudo reservar la clave de idempotencia.');
    if (existingKey.request_hash !== requestHash) {
      const error = new Error('La clave de idempotencia ya fue utilizada para otra solicitud.');
      error.status = 409;
      throw error;
    }
    if (existingKey.job_id) {
      const { rows: existingJobs } = await client.query('SELECT * FROM jobs WHERE id=$1', [existingKey.job_id]);
      if (!existingJobs[0]) throw new Error('La clave de idempotencia apunta a una tarea inexistente.');
      await client.query('COMMIT');
      return { ...toPublic(existingJobs[0]), created: false };
    }
    await client.query(
      'INSERT INTO jobs (id,status,stage,progress,attempt,created_at,updated_at,error,encrypted_payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [row.id,row.status,row.stage,row.progress,row.attempt,row.created_at,row.updated_at,row.error,row.encrypted_payload]
    );
    await client.query('UPDATE job_request_idempotency SET job_id=$2 WHERE idempotency_key=$1', [idempotencyKey, row.id]);
    await client.query('COMMIT');
    return { ...toPublic(row), created: true };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
/**
 * Create a fresh 1M-token continuation task from a budget-paused job while preserving its encrypted
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
      return { error: 'Solo se puede continuar automáticamente una tarea pausada por presupuesto de tokens.', status: 409 };
    }

    const closedAt = now();
    const payload = prepareContinuationPayload(sourcePayload, { id: source.id, stage: source.stage }, closedAt);

    const timestamp = closedAt;
    const childId = randomUUID();
    const childRow = {
      id: childId, status: 'queued', stage: 'Continuación automática · recuperando checkpoint',
      progress: Math.min(Number(source.progress) || 0, 90),
      attempt: Number(source.attempt) || 0,
      created_at: timestamp, updated_at: timestamp, error: null,
      encrypted_payload: seal({ ...payload, title: sourcePayload.title || generateTaskTitle(sourcePayload.objective) })
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
      return payload.continuedByJobId ? [] : [{ id: row.id, checkpoint: payload.lastCheckpoint || null }];
    } catch (error) {
      console.error('[worker][budget_continuation_recovery_read_failed]', JSON.stringify({ jobId: row.id, message: String(error?.message || error).slice(0, 200) }));
      return [];
    }
  });
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
  return { jobs: rows.map(toPublic), total, limit: safeLimit, offset: safeOffset, hasMore: safeOffset + rows.length < total, status: filterStatus || 'all' };
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
export async function checkStore() {
  await pool.query('SELECT 1');
  return true;
}

let closeStorePromise;
export function closeStore() {
  if (!closeStorePromise) closeStorePromise = pool.end();
  return closeStorePromise;
}
