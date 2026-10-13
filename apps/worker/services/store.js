import Database from 'better-sqlite3';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const databasePath = process.env.DATABASE_PATH || './data/swarm.sqlite';
const encryptionHex = process.env.HISTORY_ENCRYPTION_KEY || '';
if (!/^[0-9a-fA-F]{64}$/.test(encryptionHex)) throw new Error('HISTORY_ENCRYPTION_KEY debe contener exactamente 64 caracteres hexadecimales. Generala con: openssl rand -hex 32');
const encryptionKey = Buffer.from(encryptionHex, 'hex');
fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
const db = new Database(databasePath);
db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
db.exec(`CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, stage TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0, attempt INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT,
  encrypted_payload BLOB NOT NULL
); CREATE INDEX IF NOT EXISTS jobs_updated_idx ON jobs(updated_at DESC);`);
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
const now = () => new Date().toISOString();
const insert = db.prepare('INSERT INTO jobs (id,status,stage,progress,attempt,created_at,updated_at,error,encrypted_payload) VALUES (@id,@status,@stage,@progress,@attempt,@created_at,@updated_at,@error,@encrypted_payload)');
const update = db.prepare('UPDATE jobs SET status=@status, stage=@stage, progress=@progress, attempt=@attempt, updated_at=@updated_at, error=@error, encrypted_payload=@encrypted_payload WHERE id=@id');
const byId = db.prepare('SELECT * FROM jobs WHERE id=?');
const toPublic = row => ({ id: row.id, status: row.status, stage: row.stage, progress: row.progress, attempt: row.attempt, createdAt: row.created_at, updatedAt: row.updated_at, error: row.error || null });

const artifactsRoot = path.resolve(process.env.ARTIFACTS_DIR || path.join(path.dirname(path.resolve(databasePath)), 'artifacts'));
const MAX_ARTIFACTS = 40;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_ARTIFACT_TOTAL = 2 * 1024 * 1024;
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
    const content = match[4];
    const size = Buffer.byteLength(content, 'utf8');
    if (!name || !size || size > MAX_ARTIFACT_BYTES || total + size > MAX_ARTIFACT_TOTAL) continue;
    if (files.some(file => file.path === name)) continue;
    files.push({ path: name, content, size, contentType: name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.json') ? 'application/json; charset=utf-8' : name.endsWith('.webmanifest') ? 'application/manifest+json; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.svg') ? 'image/svg+xml; charset=utf-8' : /\.(?:js|mjs|cjs|jsx|ts|tsx)$/i.test(name) ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8' });
    total += size;
  }
  return files;
}
export function saveArtifacts(id, delivery) {
  const row = byId.get(id);
  if (!row) return [];
  const files = extractArtifacts(delivery);
  if (!files.length) return listArtifacts(id);
  const taskDir = path.resolve(artifactsRoot, id);
  if (!taskDir.startsWith(artifactsRoot + path.sep)) throw new Error('Ruta de artefactos inválida.');
  fs.rmSync(taskDir, { recursive: true, force: true });
  if (files.length) {
    fs.mkdirSync(taskDir, { recursive: true });
    for (const file of files) {
      const destination = path.resolve(taskDir, file.path);
      if (!destination.startsWith(taskDir + path.sep)) continue;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.content, { encoding: 'utf8', mode: 0o600 });
    }
  }
  updateJob(id, { payload: { artifacts: files } });
  return files.map(({ path: filePath, size, contentType }) => ({ path: filePath, size, contentType }));
}
export function listArtifacts(id) {
  const record = getPayload(id);
  return (record?.payload?.artifacts || []).map(({ path: filePath, size, contentType }, index) => ({ index, path: filePath, size, contentType }));
}
export function getArtifact(id, index) {
  const record = getPayload(id);
  const file = record?.payload?.artifacts?.[Number(index)];
  if (!file || !Number.isInteger(Number(index)) || Number(index) < 0) return null;
  return { path: file.path, content: file.content, size: file.size, contentType: file.contentType };
}

export function createJob(objective, requestedTokenBudget) {
  const timestamp = now();
  const rawDefault = Number.parseInt(process.env.MAX_TASK_TOKENS || '50000', 10);
  const defaultBudget = Number.isFinite(rawDefault) ? Math.min(100000, Math.max(4000, rawDefault)) : 50000;
  const tokenBudget = Number.isFinite(Number(requestedTokenBudget)) ? Math.min(100000, Math.max(4000, Math.round(Number(requestedTokenBudget) / 1000) * 1000)) : defaultBudget;
  const row = { id: randomUUID(), status: 'queued', stage: 'En cola', progress: 0, attempt: 0, created_at: timestamp, updated_at: timestamp, error: null, encrypted_payload: seal({ objective, tokenBudget, transcript: [], artifacts: [], result: null, lastCheckpoint: 'created' }) };
  insert.run(row); return toPublic(row);
}
export function getJob(id) { const row = byId.get(id); return row ? toPublic(row) : null; }
export function getPayload(id) { const row = byId.get(id); return row ? { publicJob: toPublic(row), payload: unseal(row.encrypted_payload) } : null; }
export function updateJob(id, patch = {}) {
  const row = byId.get(id); if (!row) return null;
  const current = toPublic(row); const payload = unseal(row.encrypted_payload);
  if (patch.payload) Object.assign(payload, patch.payload);
  const next = { id, status: patch.status ?? current.status, stage: patch.stage ?? current.stage, progress: patch.progress ?? current.progress, attempt: patch.attempt ?? current.attempt, created_at: row.created_at, updated_at: now(), error: patch.error === undefined ? row.error : patch.error, encrypted_payload: seal(payload) };
  update.run(next); return toPublic(next);
}
const VALID_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'needs_review']);
export function listJobs({ limit = 25, offset = 0, status = '' } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const filterStatus = VALID_STATUSES.has(status) ? status : '';
  const rows = filterStatus
    ? db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(filterStatus, safeLimit, safeOffset)
    : db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(safeLimit, safeOffset);
  const total = filterStatus
    ? db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE status = ?').get(filterStatus).count
    : db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count;
  return { jobs: rows.map(toPublic), total, limit: safeLimit, offset: safeOffset, hasMore: safeOffset + rows.length < total, status: filterStatus || 'all' };
}
export function historySummary() {
  const rows = db.prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status').all();
  const byStatus = Object.fromEntries(rows.map(row => [row.status, row.count]));
  const count = rows.reduce((sum, row) => sum + row.count, 0);
  return { hasHistory: count > 0, count, byStatus: { queued: byStatus.queued || 0, running: byStatus.running || 0, completed: byStatus.completed || 0, failed: byStatus.failed || 0, needs_review: byStatus.needs_review || 0 } };
}
export function recoverableJobs() {
  return db.prepare("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at ASC").all().map(row => {
    try { const payload = unseal(row.encrypted_payload); return { id: row.id, retryAt: payload.retryAt || null }; }
    catch { return { id: row.id, retryAt: null }; }
  });
}
export function closeStore() { if (db.open) db.close(); }