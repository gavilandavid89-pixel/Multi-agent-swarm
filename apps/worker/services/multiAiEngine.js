import { agenteArquitecto, agenteEsceptico, agenteArbitro, agenteDesarrollador, agenteValidador } from './aiProviders.js';
import { getPayload, updateJob, saveArtifacts } from './store.js';
import { checkJavascriptSyntax } from './codeChecks.js';
const configuredRounds = Number.parseInt(process.env.MAX_CORRECTION_ROUNDS || '3', 10);
const MAX_ROUNDS = Number.isFinite(configuredRounds) ? Math.min(10, Math.max(1, configuredRounds)) : 3;
const MAX_TRANSCRIPT_ENTRIES = 150;
function appendEntries(existing, entries) { return [...(Array.isArray(existing) ? existing : []), ...entries].slice(-MAX_TRANSCRIPT_ENTRIES); }
function retryNotice(jobId, info) {
  const reason = String(info.reason || 'error temporal').slice(0, 240);
  console.warn('[worker][provider_retry]', JSON.stringify({ jobId, retry: info.retry, waitMs: info.wait, reason }));
  const current = getPayload(jobId); if (!current) return;
  const transcript = appendEntries(current.payload.transcript, [{ at: new Date().toISOString(), agent: 'sistema', type: 'retry', content: `Reintento ${info.retry}; espera ${Math.ceil(info.wait / 1000)} s; motivo: ${reason}` }]);
  updateJob(jobId, { stage: 'Esperando al proveedor de IA', payload: { transcript, lastCheckpoint: 'provider-retry' } });
}
function startAgent(jobId, stage, progress, agent, content) {
  const current = getPayload(jobId); if (!current) throw new Error('La tarea dejó de existir.');
  const transcript = appendEntries(current.payload.transcript, [{ at: new Date().toISOString(), agent, type: 'thinking', content }]);
  return updateJob(jobId, { status: 'running', stage, progress, error: null, payload: { transcript, lastCheckpoint: `started:${stage}` } });
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
  return updateJob(jobId, { status: 'running', stage, progress, payload: { transcript: transcript.slice(-MAX_TRANSCRIPT_ENTRIES), lastCheckpoint: stage, ...extra }, ...publicPatch });
}
export async function processJob(jobId) {
  const initial = getPayload(jobId); if (!initial) return; if (initial.publicJob.status === 'completed') return;
  const objective = initial.payload.objective; const onRetry = info => retryNotice(jobId, info);
  let payload = initial.payload; let { proposal = '', critique = '', strategy = '', delivery = '' } = payload;
  try {
    if (!proposal) {
      startAgent(jobId, 'Arquitectura', 5, 'Arquitecto', 'Estoy analizando el objetivo y preparando una propuesta técnica.');
      proposal = await agenteArquitecto(objective, onRetry);
      checkpoint(jobId, 'Auditoría escéptica', 15, 'Arquitecto', proposal, { proposal });
    }
    if (!critique) {
      startAgent(jobId, 'Auditoría escéptica', 15, 'Escéptico', 'Estoy revisando la propuesta para encontrar riesgos, contradicciones y casos límite.');
      critique = await agenteEsceptico(objective, proposal, onRetry);
      checkpoint(jobId, 'Síntesis técnica', 25, 'Escéptico', critique, { proposal, critique });
    }
    if (!strategy) {
      startAgent(jobId, 'Síntesis técnica', 25, 'Árbitro', 'Estoy comparando la propuesta y las objeciones para acordar un plan.');
      strategy = await agenteArbitro(objective, proposal, critique, onRetry);
      checkpoint(jobId, 'Desarrollo', 35, 'Árbitro', strategy, { proposal, critique, strategy });
    }
    if (!delivery) {
      startAgent(jobId, 'Desarrollo', 35, 'Desarrollador', 'Estoy preparando la entrega a partir de la estrategia acordada.');
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
      const correctedDelivery = await agenteDesarrollador(objective, strategy, findings.join('\n'), onRetry);
      checkpoint(jobId, `Corrección ${round}`, Math.min(progress + 8, 95), 'Desarrollador (corrección)', correctedDelivery, { proposal, critique, strategy, delivery: correctedDelivery, validation: null, syntax: null, validationRound: round, lastCheckpoint: `correction-${round}` });
      saveArtifacts(jobId, correctedDelivery);
      delivery = correctedDelivery; validation = null; syntax = null; payload = getPayload(jobId)?.payload || {}; round += 1;
    }
    const finalPayload = getPayload(jobId)?.payload || {};
    updateJob(jobId, { status: 'needs_review', stage: 'Requiere revisión humana', progress: 99, attempt: MAX_ROUNDS, error: 'La revisión automática no aprobó todos los criterios; requiere revisión humana.', payload: { ...finalPayload, proposal, critique, strategy, delivery, validation, syntax, result: { status: 'needs_review', delivery, validation, syntax }, lastCheckpoint: 'needs_review' } });
  } catch (error) {
    console.error('[worker][job_failed]', JSON.stringify({
      jobId,
      name: String(error?.name || 'Error').slice(0, 100),
      message: String(error?.message || error).slice(0, 1200),
      stack: String(error?.stack || '').slice(0, 4000)
    }));
    const current = getPayload(jobId);
    if (current) {
      const transcript = appendEntries(current.payload.transcript, [{ at: new Date().toISOString(), agent: 'sistema', type: 'error', content: String(error?.stack || error?.message || error).slice(0, 12000) }]);
      updateJob(jobId, { status: 'failed', stage: 'Error de procesamiento', error: 'La tarea se interrumpió por un error. Consultá el detalle técnico y corregí la configuración si corresponde.', payload: { ...current.payload, transcript, lastCheckpoint: current.payload.lastCheckpoint || 'error' } });
    }
  }
}