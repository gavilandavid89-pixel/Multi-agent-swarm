import { agenteArquitecto, agenteEsceptico, agenteArbitro, agenteDesarrollador, agenteValidador } from './aiProviders.js';
import { getPayload, updateJob, saveArtifacts } from './store.js';
import { checkJavascriptSyntax } from './codeChecks.js';
// Dos tandas: entrega inicial + una corrección. Cada tanda tiene validación; la última es final.
const MAX_ROUNDS = 2;
const MAX_TRANSCRIPT_ENTRIES = 150;
function appendEntries(existing, entries) { return [...(Array.isArray(existing) ? existing : []), ...entries].slice(-MAX_TRANSCRIPT_ENTRIES); }
function retryNotice(jobId, info) {
  const current = getPayload(jobId); if (!current) return;
  if (info.usage) {
    const prior = current.payload.tokenUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, byModel: {} };
    const model = String(info.model || 'desconocido');
    const next = { promptTokens: prior.promptTokens + (info.promptTokens || 0), completionTokens: prior.completionTokens + (info.completionTokens || 0), totalTokens: prior.totalTokens + (info.totalTokens || 0), calls: prior.calls + 1, byModel: { ...(prior.byModel || {}) } };
    const modelPrior = next.byModel[model] || { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
    next.byModel[model] = { promptTokens: modelPrior.promptTokens + (info.promptTokens || 0), completionTokens: modelPrior.completionTokens + (info.completionTokens || 0), totalTokens: modelPrior.totalTokens + (info.totalTokens || 0), calls: modelPrior.calls + 1 };
    const transcript = appendEntries(current.payload.transcript, [{ at: new Date().toISOString(), agent: 'sistema', type: 'usage', content: JSON.stringify({ model, promptTokens: info.promptTokens || 0, completionTokens: info.completionTokens || 0, totalTokens: info.totalTokens || 0 }) }]);
    updateJob(jobId, { payload: { transcript, tokenUsage: next } });
    console.info('[worker][provider_usage]', JSON.stringify({ jobId, model, promptTokens: info.promptTokens || 0, completionTokens: info.completionTokens || 0, totalTokens: info.totalTokens || 0 }));
    return;
  }
  const reason = String(info.reason || 'error temporal').slice(0, 240);
  console.warn('[worker][provider_retry]', JSON.stringify({ jobId, retry: info.retry, waitMs: info.wait, reason }));
  const transcript = appendEntries(current.payload.transcript, [{ at: new Date().toISOString(), agent: 'sistema', type: 'retry', content: `Reintento ${info.retry}; espera ${Math.ceil(info.wait / 1000)} s; motivo: ${reason}` }]);
  updateJob(jobId, { stage: 'Esperando al proveedor de IA', payload: { transcript, activeStage: current.payload.activeStage || null } });
}
function assertTaskTokenBudget(jobId) {
  const rawLimit = Number.parseInt(process.env.MAX_TASK_TOKENS || '24000', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(100000, Math.max(4000, rawLimit)) : 24000;
  const current = getPayload(jobId);
  const used = Number(current?.payload?.tokenUsage?.totalTokens) || 0;
  if (used >= limit) {
    const error = new Error(`Se alcanzó el presupuesto de la tarea (${used}/${limit} tokens). El checkpoint se conserva; aumentá MAX_TASK_TOKENS o reducí el contexto para reanudar.`);
    error.code = 'TASK_TOKEN_BUDGET'; error.usedTokens = used; error.tokenLimit = limit;
    throw error;
  }
}
function startAgent(jobId, stage, progress, agent, content) {
  const current = getPayload(jobId); if (!current) throw new Error('La tarea dejó de existir.');
  const transcript = appendEntries(current.payload.transcript, [{ at: new Date().toISOString(), agent, type: 'thinking', content }]);
  return updateJob(jobId, { status: 'running', stage, progress, error: null, payload: { transcript, retryAt: null, providerBlock: null, activeStage: stage } });
}
function checkpoint(jobId, stage, progress, agent, content, extra = {}, publicPatch = {}) {
  const current = getPayload(jobId); if (!current) throw new Error('La tarea dejó de existir.');
  const transcript = Array.isArray(current.payload.transcript) ? [...current.payload.transcript] : [];
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].agent === agent && transcript[i].type === 'thinking') {
      transcript[i] = { ...transcript[i], type: 'activity', content: 'Terminó su análisis y compartió su respuesta.' };
      break;
    }
  }
  transcript.push({ at: new Date().toISOString(), agent, type: 'message', content: String(content ?? '').slice(0, 16000) });
  return updateJob(jobId, { status: 'running', stage, progress, payload: { transcript: transcript.slice(-MAX_TRANSCRIPT_ENTRIES), lastCheckpoint: stage, activeStage: null, ...extra }, ...publicPatch });
}
export async function processJob(jobId) {
  const initial = getPayload(jobId); if (!initial) return; if (initial.publicJob.status === 'completed') return;
  const objective = initial.payload.objective; const onRetry = info => retryNotice(jobId, info);
  let payload = initial.payload; let { proposal = '', critique = '', strategy = '', delivery = '' } = payload;
  try {
    if (!proposal) {
      startAgent(jobId, 'Arquitectura', 5, 'Arquitecto', 'Estoy analizando el objetivo y preparando una propuesta técnica.');
      assertTaskTokenBudget(jobId);
      proposal = await agenteArquitecto(objective, onRetry);
      checkpoint(jobId, 'Auditoría escéptica', 15, 'Arquitecto', proposal, { proposal });
    }
    if (!critique) {
      startAgent(jobId, 'Auditoría escéptica', 15, 'Escéptico', 'Estoy revisando la propuesta para encontrar riesgos, contradicciones y casos límite.');
      assertTaskTokenBudget(jobId);
      critique = await agenteEsceptico(objective, proposal, onRetry);
      checkpoint(jobId, 'Síntesis técnica', 25, 'Escéptico', critique, { proposal, critique });
    }
    if (!strategy) {
      startAgent(jobId, 'Síntesis técnica', 25, 'Árbitro', 'Estoy comparando la propuesta y las objeciones para acordar un plan.');
      assertTaskTokenBudget(jobId);
      strategy = await agenteArbitro(objective, proposal, critique, onRetry);
      checkpoint(jobId, 'Desarrollo', 35, 'Árbitro', strategy, { proposal, critique, strategy });
    }
    if (!delivery) {
      startAgent(jobId, 'Desarrollo', 35, 'Desarrollador', 'Estoy preparando la entrega a partir de la estrategia acordada.');
      assertTaskTokenBudget(jobId);
      delivery = await agenteDesarrollador(objective, strategy, '', onRetry);
      checkpoint(jobId, 'Validación', 55, 'Desarrollador', delivery, { proposal, critique, strategy, delivery });
      saveArtifacts(jobId, delivery);
    }
    payload = getPayload(jobId)?.payload || {};
    let validation = payload.validation || null; let syntax = payload.syntax || null;
    let round = (payload.validationRound && validation && syntax) ? Number(payload.validationRound) : (getPayload(jobId)?.publicJob.attempt || 0) + 1;
    while (round <= MAX_ROUNDS) {
      const saved = payload.validationRound === round && validation && syntax;
      const progress = Math.min(60 + Math.round((round - 1) * 30 / MAX_ROUNDS), 90);
      if (!saved) {
        startAgent(jobId, `Validación ${round}/${MAX_ROUNDS}`, progress, 'Validador', 'Estoy comprobando la entrega y buscando defectos antes de aprobarla.');
        assertTaskTokenBudget(jobId);
        validation = await agenteValidador(objective, strategy, delivery, onRetry);
        syntax = await checkJavascriptSyntax(delivery);
        const current = getPayload(jobId); if (!current) throw new Error('La tarea dejó de existir durante la validación.');
        const transcript = Array.isArray(current.payload.transcript) ? [...current.payload.transcript] : [];
        for (let i = transcript.length - 1; i >= 0; i--) {
          if (transcript[i].agent === 'Validador' && transcript[i].type === 'thinking') {
            transcript[i] = { ...transcript[i], type: 'activity', content: 'Terminó la revisión; resultado de la auditoría a continuación.' };
            break;
          }
        }
        transcript.push(
          { at: new Date().toISOString(), agent: 'Validador', type: 'message', content: JSON.stringify(validation).slice(0, 20000) },
          { at: new Date().toISOString(), agent: 'Validador determinista', type: 'check', content: syntax.message.slice(0, 4000) }
        );
        updateJob(jobId, { status: 'running', stage: `Validación ${round}/${MAX_ROUNDS}`, progress: progress + 5, attempt: round, payload: { transcript: transcript.slice(-MAX_TRANSCRIPT_ENTRIES), proposal, critique, strategy, delivery, validation, syntax, validationRound: round, lastCheckpoint: `validation-${round}` } });
        payload = getPayload(jobId)?.payload || {};
      }
      if (validation?.verdict === 'APPROVED' && syntax?.ok) {
        const validationLevel = syntax.checked ? 'ai_and_syntax' : 'ai_review_only';
        const result = { status: 'completed', validationLevel, summary: validation.summary, delivery, validation, syntax };
        updateJob(jobId, { status: 'completed', stage: syntax.checked ? 'Completado · IA + sintaxis' : 'Completado · revisión IA', progress: 100, attempt: round, error: null, payload: { proposal, critique, strategy, delivery, validation, syntax, validationRound: round, validationLevel, result, lastCheckpoint: 'completed' } });
        return;
      }
      if (round >= MAX_ROUNDS) break;
      const findings = [...(validation?.findings || [])]; if (syntax && !syntax.ok) findings.push(syntax.message);
      if (!findings.length) findings.push('La revisión no aprobó la entrega; explicá y corregí los puntos débiles.');
      startAgent(jobId, `Corrección ${round}`, Math.min(progress + 5, 94), 'Desarrollador (corrección)', 'Estoy corrigiendo los hallazgos de la revisión antes de volver a validar.');
      const assertTaskTokenBudget(jobId);
 correctedDelivery = await agenteDesarrollador(objective, strategy, findings.join('\n'), onRetry);
      checkpoint(jobId, `Corrección ${round}`, Math.min(progress + 8, 95), 'Desarrollador (corrección)', correctedDelivery, { proposal, critique, strategy, delivery: correctedDelivery, validation: null, syntax: null, validationRound: round, lastCheckpoint: `correction-${round}` });
      saveArtifacts(jobId, correctedDelivery);
      delivery = correctedDelivery; validation = null; syntax = null; payload = getPayload(jobId)?.payload || {}; round += 1;
    }
    const finalPayload = getPayload(jobId)?.payload || {};
    updateJob(jobId, { status: 'needs_review', stage: 'Requiere revisión humana', progress: 99, attempt: MAX_ROUNDS, error: 'La revisión automática no aprobó todos los criterios; requiere revisión humana.', payload: { ...finalPayload, proposal, critique, strategy, delivery, validation, syntax, result: { status: 'needs_review', delivery, validation, syntax }, lastCheckpoint: 'needs_review' } });
  } catch (error) {
    const current = getPayload(jobId);
    if (error?.code === 'TASK_TOKEN_BUDGET' && current) {
      const reason = String(error.message || 'Presupuesto de tokens agotado').slice(0, 1200);
      const transcript = appendEntries(current.payload.transcript, [{ at: new Date().toISOString(), agent: 'sistema', type: 'budget', content: reason }]);
      updateJob(jobId, { status: 'needs_review', stage: 'Pausada por presupuesto de tokens', progress: current.publicJob.progress, error: reason, payload: { ...current.payload, transcript, providerBlock: { code: error.code, usedTokens: error.usedTokens, tokenLimit: error.tokenLimit }, activeStage: null, lastCheckpoint: current.payload.lastCheckpoint || 'token-budget' } });
      return { blocked: true, reason };
    }
    if (error?.code === 'PROVIDER_TEMPORARY' && current) {
      const retryAfterMs = Math.max(1000, Math.min(604800000, Number(error.retryAfterMs) || 30000));
      const retryAt = new Date(Date.now() + retryAfterMs).toISOString();
      const reason = String(error.message || 'Proveedor temporalmente no disponible').slice(0, 1200);
      const transcript = appendEntries(current.payload.transcript, [{ at: new Date().toISOString(), agent: 'sistema', type: 'retry', content: `Tarea pausada de forma segura. Motivo: ${reason} Próximo intento automático: ${retryAt}. Se conserva el checkpoint ${current.payload.lastCheckpoint || 'guardado'}.` }]);
      updateJob(jobId, { status: 'queued', stage: 'Esperando disponibilidad del proveedor', progress: current.publicJob.progress, error: null, payload: { ...current.payload, transcript, retryAt, providerBlock: { code: error.code, model: error.providerModel || null, retry: error.providerRetry || null, reason, retryAfterMs }, lastCheckpoint: current.payload.lastCheckpoint || 'provider-deferred', activeStage: null } });
      console.warn('[worker][provider_deferred]', JSON.stringify({ jobId, model: error.providerModel || null, retry: error.providerRetry || null, retryAfterMs, retryAt, checkpoint: current.payload.lastCheckpoint || null }));
      return { deferred: true, retryAfterMs };
    }
    console.error('[worker][job_failed]', JSON.stringify({
      jobId,
      name: String(error?.name || 'Error').slice(0, 100),
      message: String(error?.message || error).slice(0, 1200),
      stack: String(error?.stack || '').slice(0, 4000)
    }));
    if (current) {
      const transcript = appendEntries(current.payload.transcript, [{ at: new Date().toISOString(), agent: 'sistema', type: 'error', content: String(error?.stack || error?.message || error).slice(0, 12000) }]);
      updateJob(jobId, { status: 'failed', stage: 'Error de procesamiento', error: 'La tarea se interrumpió por un error. Consultá el detalle técnico y corregí la configuración si corresponde.', payload: { ...current.payload, transcript, lastCheckpoint: current.payload.lastCheckpoint || 'error' } });
    }
  }
}