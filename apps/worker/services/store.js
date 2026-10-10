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
export function createJob(objective) {
  const timestamp = now();
  const row = { id: randomUUID(), status: 'queued', stage: 'En cola', progress: 0, attempt: 0, created_at: timestamp, updated_at: timestamp, error: null, encrypted_payload: seal({ objective, transcript: [], result: null, lastCheckpoint: 'created' }) };
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
export function listJobs(limit = 25) { return db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(Math.min(Math.max(Number(limit) || 25, 1), 100)).map(toPublic); }
export function historySummary() { const result = db.prepare('SELECT COUNT(*) AS count FROM jobs').get(); return { hasHistory: result.count > 0, count: result.count }; }
export function recoverableJobs() { return db.prepare("SELECT id FROM jobs WHERE status IN ('queued','running') ORDER BY created_at ASC").all().map(row => row.id); }
export function closeStore() { if (db.open) db.close(); }