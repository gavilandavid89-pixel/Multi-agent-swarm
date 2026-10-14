import { timingSafeEqual } from 'node:crypto';
import 'dotenv/config';
import express from 'express';
import { initStore, createJob, createContinuationJob, getJob, getPayload, historySummary, listJobs, recoverableJobs, updateJob, closeStore, listArtifacts, getArtifact } from './services/store.js';
import { processJob } from './services/multiAiEngine.js';
import { replyToAgent } from './services/agentChat.js';
import { canContinueBudgetTask } from './services/tokenAccounting.js';
import { voteOnImprovement } from './services/improvementVoting.js';

const app = express();
const PORT = Number(process.env.PORT || 3100);
const SHARED_SECRET = process.env.WORKER_SHARED_SECRET || '';
const concurrencyRaw = Number.parseInt(process.env.WORKER_CONCURRENCY || '1', 10);
const MAX_CONCURRENCY = Number.isFinite(concurrencyRaw) ? Math.min(8, Math.max(1, concurrencyRaw)) : 2;
if (SHARED_SECRET.length < 32 || /replace-with|your-/i.test(SHARED_SECRET)) throw new Error('WORKER_SHARED_SECRET debe ser un secreto aleatorio de al menos 32 caracteres.');
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
const queue = new Set(); const active = new Set(); let shuttingDown = false; let storeClosing = false; let server;
const shutdownGraceMs = Math.max(1000, Math.min(60000, Number.parseInt(process.env.SHUTDOWN_GRACE_MS || '15000', 10) || 15000));
app.get('/healthz', (_req, res) => res.json({ ok: true, role: 'worker', queue: queue.size, processing: active.size, capacity: MAX_CONCURRENCY }));
app.use('/internal', (req, res, next) => { if (!safeEqual(req.get('x-swarm-bridge-secret') || '', SHARED_SECRET)) return res.status(401).json({ error: 'No autorizado.' }); next(); });
function safeEqual(a, b) { const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b)); if (aa.length !== bb.length || aa.length === 0) return false; return timingSafeEqual(aa, bb); }
function enqueue(id) { if (!id || queue.has(id) || active.has(id) || shuttingDown) return; queue.add(id); pump(); }
function pump() {
  if (shuttingDown) return;
  while (active.size < MAX_CONCURRENCY && queue.size > 0) {
    const id = queue.values().next().value; queue.delete(id); if (active.has(id)) continue; active.add(id);
    void processJob(id).then(result => {
      if (result?.deferred && !shuttingDown) {
        const delay = Math.max(1000, Math.min(604800000, Number(result.retryAfterMs) || 30000));
        const timer = setTimeout(() => enqueue(id), delay); timer.unref();
      }
    }).catch(error => console.error('[worker] fallo inesperado', id, error?.message || error)).finally(() => { active.delete(id); if (shuttingDown) maybeExit(); else pump(); });
  }
}
app.get('/internal/history', async (_req, res, next) => { try { res.json(await historySummary()); } catch (error) { next(error); } });
app.get('/internal/jobs', async (req, res, next) => {
  const requestedStatus = String(req.query.status || '');
  const allowedStatuses = new Set(['all', 'queued', 'running', 'completed', 'failed', 'needs_review']);
  if (requestedStatus && !allowedStatuses.has(requestedStatus)) return res.status(400).json({ error: 'Filtro de estado inválido.' });
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '25', 10) || 25));
  const offset = Math.max(0, Number.parseInt(req.query.offset || '0', 10) || 0);
  try { res.json(await listJobs({ limit, offset, status: requestedStatus === 'all' ? '' : requestedStatus })); } catch (error) { next(error); }
});
app.post('/internal/jobs', async (req, res) => {
  const objective = typeof req.body?.objective === 'string' ? req.body.objective.trim() : '';
  if (!objective) return res.status(400).json({ error: 'El objetivo es obligatorio.' });
  if (objective.length > 20000) return res.status(413).json({ error: 'El objetivo supera los 20.000 caracteres.' });
  const requestedBudget = Number(req.body?.tokenBudget);
  const tokenBudget = Number.isFinite(requestedBudget) ? Math.min(100000, Math.max(4000, Math.round(requestedBudget / 1000) * 1000)) : undefined;
  try { const job = await createJob(objective, tokenBudget); enqueue(job.id); res.status(202).json(job); }
  catch (error) { console.error('[worker] no se pudo guardar la tarea', error?.message || error); res.status(500).json({ error: 'No se pudo guardar la tarea de forma persistente.' }); }
});
app.get('/internal/jobs/:id', async (req, res, next) => { try { const job = await getJob(req.params.id); if (!job) return res.status(404).json({ error: 'No existe esa tarea.' }); res.json(job); } catch (error) { next(error); } });
app.post('/internal/jobs/:id/budget', async (req, res, next) => { try {
  const record = await getPayload(req.params.id);
  if (!record) return res.status(404).json({ error: 'No existe esa tarea.' });
  const configured = Number.parseInt(process.env.MAX_TASK_TOKENS || '50000', 10);
  const fallback = Number.isFinite(configured) ? Math.min(100000, Math.max(4000, configured)) : 50000;
  const currentBudget = Math.min(100000, Math.max(4000, Number(record.payload.tokenBudget) || fallback));
  const requested = Number(req.body?.tokenBudget);
  if (!Number.isFinite(requested)) return res.status(400).json({ error: 'Indicá un límite de tokens válido.' });
  const nextBudget = Math.min(100000, Math.max(4000, Math.round(requested / 1000) * 1000));
  if (nextBudget <= currentBudget) return res.status(400).json({ error: 'El nuevo límite debe superar el límite actual.' });
  await updateJob(req.params.id, { payload: { tokenBudget: nextBudget } });
  if (record.publicJob.status === 'needs_review' && /presupuesto|tokens/i.test(record.publicJob.stage || '')) {
    await updateJob(req.params.id, { status: 'queued', stage: 'En cola para reanudar con más tokens', progress: Math.min(record.publicJob.progress, 90), error: null });
    enqueue(req.params.id);
  }
  res.json({ tokenBudget: nextBudget }); } catch (error) { next(error); }
});
app.post('/internal/jobs/:id/continue-budget', async (req, res, next) => {
  try {
    const result = await createContinuationJob(req.params.id);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    enqueue(result.job.id);
    console.info('[worker][token_batch_continuation]', JSON.stringify({ sourceJobId: req.params.id, continuationJobId: result.job.id, created: result.created, tokenBudget: 100000 }));
    res.status(202).json(result.job);
  } catch (error) { next(error); }
});
app.post('/internal/jobs/:id/vote-improvement', async (req, res) => {
  const proposal = typeof req.body?.proposal === 'string' ? req.body.proposal.trim() : '';
  if (!proposal) return res.status(400).json({ error: 'Escribí una mejora concreta para someterla a votación.' });
  if (proposal.length > 1800) return res.status(413).json({ error: 'La propuesta supera los 1.800 caracteres.' });
  try {
    const result = await voteOnImprovement(req.params.id, proposal);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: String(error.message || 'No se pudo completar la votación.').slice(0, 1200) });
  }
});
app.post('/internal/jobs/:id/retry', async (req, res, next) => { try {
  const record = await getPayload(req.params.id);
  if (!record) return res.status(404).json({ error: 'No existe esa tarea.' });
  if (!['failed', 'needs_review'].includes(record.publicJob.status)) return res.status(409).json({ error: 'Solo se pueden reintentar tareas fallidas o pendientes de revisión.' });
  const job = await updateJob(req.params.id, { status: 'queued', stage: 'En cola para reintento', progress: Math.min(record.publicJob.progress, 90), attempt: 0, error: null, payload: { validation: null, syntax: null, validationRound: 0, result: null, lastCheckpoint: 'retry-requested' } });
  enqueue(req.params.id); res.status(202).json(job); } catch (error) { next(error); }
});
app.get('/internal/jobs/:id/files', async (req, res, next) => { try {
  if (!await getJob(req.params.id)) return res.status(404).json({ error: 'No existe esa tarea.' });
  res.json({ files: await listArtifacts(req.params.id) }); } catch (error) { next(error); }
});
app.get('/internal/jobs/:id/files/:index', async (req, res, next) => { try {
  if (!/^\d+$/.test(req.params.index)) return res.status(400).json({ error: 'Índice de archivo inválido.' });
  const file = await getArtifact(req.params.id, Number(req.params.index));
  if (!file) return res.status(404).json({ error: 'No existe ese archivo.' });
  res.json({ file }); } catch (error) { next(error); }
});
app.post('/internal/jobs/:id/reply', async (req, res) => {
  try {
    const agent = typeof req.body?.agent === 'string' ? req.body.agent : '';
    const message = typeof req.body?.message === 'string' ? req.body.message : '';
    const result = await replyToAgent(req.params.id, agent, message);
    res.json(result);
  } catch (error) {
    res.status(error.status || (error.code === 'PROVIDER_TEMPORARY' ? 503 : 500)).json({ error: String(error.message || 'No se pudo responder al agente.').slice(0, 1200) });
  }
});
app.get('/internal/jobs/:id/history', async (req, res, next) => { try {
  const record = await getPayload(req.params.id); if (!record) return res.status(404).json({ error: 'No existe esa tarea.' });
  const rawBudget = Number.parseInt(process.env.MAX_TASK_TOKENS || '50000', 10);
  const defaultBudget = Number.isFinite(rawBudget) ? Math.min(100000, Math.max(4000, rawBudget)) : 50000;
  const tokenBudget = Math.min(100000, Math.max(4000, Number(record.payload.tokenBudget) || defaultBudget));
  const tokenUsage = record.payload.tokenUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, byModel: {} };
  const tokensUsed = Math.max(0, Number(tokenUsage.totalTokens) || 0);
  const tokenBatchHistory = Array.isArray(record.payload.tokenBatchHistory) ? record.payload.tokenBatchHistory : [];
  const priorTokensUsed = tokenBatchHistory.reduce((sum, batch) => sum + (Number(batch?.tokenUsage?.totalTokens) || 0), 0);
  res.json({ job: record.publicJob, history: record.payload.transcript || [], result: record.payload.result || null, objective: record.payload.objective || '', proposal: record.payload.proposal || '', critique: record.payload.critique || '', strategy: record.payload.strategy || '', coherence: record.payload.coherence || '', coherenceReview: record.payload.coherenceReview || null, delivery: record.payload.delivery || '', validation: record.payload.validation || null, syntax: record.payload.syntax || null, validationLevel: record.payload.validationLevel || null, tokenUsage, tokenBudget, tokensUsed, tokensRemaining: Math.max(0, tokenBudget - tokensUsed), lastCheckpoint: record.payload.lastCheckpoint || null, retryAt: record.payload.retryAt || null, providerBlock: record.payload.providerBlock || null, continuationOf: record.payload.continuationOf || null, continuationNumber: Number(record.payload.continuationNumber) || 1, tokenBatchHistory, priorTokensUsed, lifetimeTokensUsed: priorTokensUsed + tokensUsed, continuationAvailable: canContinueBudgetTask(record.publicJob, record.payload), continuedByJobId: record.payload.continuedByJobId || null, improvementVotes: Array.isArray(record.payload.improvementVotes) ? record.payload.improvementVotes : [], artifacts: await listArtifacts(req.params.id) });
} catch (error) { next(error); } });
app.use((error, _req, res, _next) => { console.error('[worker] solicitud inválida', error?.message || error); res.status(400).json({ error: 'Solicitud inválida.' }); });
function maybeExit() { if (shuttingDown && active.size === 0 && !storeClosing) { storeClosing = true; try { server?.close(); } catch {} void closeStore().catch(error => console.error('[worker] error cerrando PostgreSQL', error?.message || error)).finally(() => process.exit(0)); } }
function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  console.log('[worker] apagado solicitado; el trabajo activo tiene una ventana para guardar checkpoints.');
  server?.close(() => { if (active.size === 0) maybeExit(); });
  const timer = setTimeout(() => { console.warn('[worker] terminó la ventana de apagado; los trabajos no finalizados se recuperarán desde checkpoints.'); process.exit(0); }, shutdownGraceMs);
  timer.unref(); maybeExit();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
async function start() {
  await initStore();
  server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(`[worker] escuchando en 0.0.0.0:${PORT}; concurrencia=${MAX_CONCURRENCY}`);
    const provider = process.env.GEMINI_API_KEY ? 'Gemini' : (process.env.GROQ_API_KEY ? 'Groq' : 'ninguno');
    const configuredModel = process.env.GEMINI_API_KEY ? (process.env.GEMINI_MODEL_CODING || 'gemini-3.8-flash') : (process.env.GROQ_MODEL_CODING || 'openai/gpt-oss-120b');
    console.info('[worker][ai_provider_config]', JSON.stringify({ provider, model: configuredModel, geminiKeyConfigured: Boolean(process.env.GEMINI_API_KEY), groqKeyConfigured: Boolean(process.env.GROQ_API_KEY) }));
    try {
      for (const job of await recoverableJobs()) {
        const delay = job.retryAt ? Math.max(0, Date.parse(job.retryAt) - Date.now()) : 0;
        if (delay > 0) { const timer = setTimeout(() => enqueue(job.id), Math.min(delay, 604800000)); timer.unref(); }
        else enqueue(job.id);
      }
    } catch (error) { console.error('[worker] no se pudieron recuperar las tareas', error?.message || error); }
  });
}
start().catch(error => { console.error('[worker] no se pudo inicializar PostgreSQL', error?.message || error); process.exit(1); });