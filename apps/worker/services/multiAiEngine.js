import { agenteArquitecto, agenteEsceptico, agenteArbitro, agenteCoordinador, agenteAuditorCoherencia, agenteDesarrollador, agenteValidador } from './aiProviders.js';
import { getPayload, updateJob, saveArtifacts, recordTokenUsage, withJobLock, createContinuationJob } from './store.js';
import { checkJavascriptSyntax } from './codeChecks.js';
import { getValidationResumeState } from './validationResume.js';
import { buildBudgetPausePatch, buildAutomaticBudgetExtensionPatch, nextAutomaticTokenBudget } from './tokenAccounting.js';
import { getDeferredCooldownMs, getScheduledJobDelayMs } from './providerRetryPolicy.js';
import { recordAgentCheckpoint } from './agentMemory.js';
// Entrega inicial y hasta dos ciclos correctivos; cada ronda pasa por auditoría y validación.
const MAX_ROUNDS = 3; // hasta dos ciclos correctivos, además de la entrega inicial
const MAX_TRANSCRIPT_ENTRIES = 150;
function appendEntries(existing, entries) { return [...(Array.isArray(existing) ? existing : []), ...entries].slice(-MAX_TRANSCRIPT_ENTRIES); }
function selectRepairContext(delivery, findings) {
  const source = String(delivery || '');
  const parts = source.split(/(?=^#{1,6}\s+(?:Archivo|File|Ruta)\s*:)/gim).filter(part => part.trim());
  const names = String(findings || '').match(/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:js|mjs|cjs|css|html?|json|webmanifest|ts|tsx|jsx|md)/g) || [];
  const selected = parts.filter(part => names.some(name => part.split('\n', 1)[0].includes(name)));
  return selected.length ? selected.join('\n\n') : source;
}
function mergeDelivery(previous, correction) {
  const split = value => {
    const source = String(value || '');
    const parts = source.split(/(?=^#{1,6}\s+(?:Archivo|File|Ruta)\s*:)/gim).filter(part => part.trim());
    const files = new Map(); let preamble = '';
    for (const part of parts) {
      const firstLine = part.split('\n', 1)[0].trim();
      const match = firstLine.match(/^#{1,6}\s+(?:Archivo|File|Ruta)\s*:\s*(.+)$/i);
      if (match) files.set(match[1].trim().replace(/[\x60"]/g, ''), part.trim());
      else if (!preamble) preamble = part.trim();
    }
    return { preamble, files };
  };
  const base = split(previous); const patch = split(correction);
  if (!patch.files.size) return String(correction || previous || '');
  for (const [name, body] of patch.files) base.files.set(name, body);
  return [base.preamble || patch.preamble, ...base.files.values()].filter(Boolean).join('\n\n');
}
async function retryNotice(jobId, info) {
  const current = await getPayload(jobId); if (!current) return;
  if (info.usage) {
    const accounted = await recordTokenUsage(jobId, info);
    const model = String(info.model || 'desconocido');
    console.info('[worker][provider_usage]', JSON.stringify({
      jobId, model, agent: info.agent || 'Agente sin clasificar', stage: info.stage || 'Etapa sin clasificar',
      interaction: info.interaction || 'workflow',
      promptTokens: info.promptTokens || 0, completionTokens: info.completionTokens || 0,
      totalTokens: info.totalTokens || 0, duplicateIgnored: Boolean(accounted.duplicate),
      countedAsWaste: Boolean(accounted.event?.countedAsWaste)
    }));
    if (!accounted.duplicate) {
      const fresh = await getPayload(jobId);
      if (fresh && fresh.publicJob.status !== 'completed') {
        await updateJob(jobId, { payload: { providerFailureStreak: 0 } });
      }
    }
    return;
  }
  const reason = String(info.reason || 'error temporal').slice(0, 240);
  console.warn('[worker][provider_retry]', JSON.stringify({ jobId, retry: info.retry, waitMs: info.wait, reason }));
  const transcript = appendEntries(current.payload.transcript, [{ at: new Date().toISOString(), agent: 'sistema', type: 'retry', content: `[${info.agent || 'Agente'} · ${info.stage || 'sin etapa'}] Reintento ${info.retry}; espera ${Math.ceil(info.wait / 1000)} s; motivo: ${reason}` }]);
  await updateJob(jobId, { stage: 'Esperando al proveedor de IA', payload: { transcript, activeStage: current.payload.activeStage || null } });
}
async function getOutputAllowance(jobId, requested, estimatedInputTokens = 0) {
  const current = await getPayload(jobId);
  const rawLimit = Number.parseInt(process.env.MAX_TASK_TOKENS || '1000000', 10);
  const fallback = Number.isFinite(rawLimit) ? Math.min(1000000, Math.max(4000, rawLimit)) : 1000000;
  const limit = Math.min(1000000, Math.max(4000, Number(current?.payload?.tokenBudget) || fallback));
  const used = Number(current?.payload?.tokenUsage?.totalTokens) || 0;
  const remaining = Math.max(0, limit - used);
  const inputReserve = Math.max(0, Math.ceil(Number(estimatedInputTokens) || 0));
  const availableForOutput = Math.max(0, remaining - inputReserve);
  if (availableForOutput < 256) {
    const error = new Error(`Presupuesto insuficiente antes de llamar al modelo: ${used} usados, ${inputReserve} estimados para entrada y límite ${limit}. El checkpoint se conserva; el motor ampliará el presupuesto o abrirá otra tanda automáticamente.`);
    error.code = 'TASK_TOKEN_BUDGET'; error.usedTokens = used; error.tokenLimit = limit; error.estimatedInputTokens = inputReserve;
    throw error;
  }
  return Math.min(Math.max(256, Number(requested) || 1200), availableForOutput);
}
async function assertTaskTokenBudget(jobId) {
  const rawLimit = Number.parseInt(process.env.MAX_TASK_TOKENS || '1000000', 10);
  const defaultLimit = Number.isFinite(rawLimit) ? Math.min(1000000, Math.max(4000, rawLimit)) : 1000000;
  const current = await getPayload(jobId);
  const limit = Math.min(1000000, Math.max(4000, Number(current?.payload?.tokenBudget) || defaultLimit));
  const used = Number(current?.payload?.tokenUsage?.totalTokens) || 0;
  if (used >= limit) {
    const error = new Error(`Se alcanzó el presupuesto de la tarea (${used}/${limit} tokens). El checkpoint se conserva; el motor ampliará el presupuesto o abrirá otra tanda automáticamente.`);
    error.code = 'TASK_TOKEN_BUDGET'; error.usedTokens = used; error.tokenLimit = limit;
    throw error;
  }
}
async function startAgent(jobId, stage, progress, agent, content) {
  const current = await getPayload(jobId); if (!current) throw new Error('La tarea dejó de existir.');
  const transcript = appendEntries(current.payload.transcript, [{ at: new Date().toISOString(), agent, type: 'thinking', content }]);
  return updateJob(jobId, { status: 'running', stage, progress, error: null, payload: { transcript, retryAt: null, providerBlock: null, activeStage: stage } });
}
async function checkpoint(jobId, stage, progress, agent, content, extra = {}, publicPatch = {}) {
  const current = await getPayload(jobId); if (!current) throw new Error('La tarea dejó de existir.');
  const transcript = Array.isArray(current.payload.transcript) ? [...current.payload.transcript] : [];
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].agent === agent && transcript[i].type === 'thinking') {
      transcript[i] = { ...transcript[i], type: 'activity', content: 'Terminó su análisis y compartió su respuesta.' };
      break;
    }
  }
  transcript.push({ at: new Date().toISOString(), agent, type: 'message', content: String(content ?? '').slice(0, 16000) });
  return await updateJob(jobId, { status: 'running', stage, progress, payload: { transcript: transcript.slice(-MAX_TRANSCRIPT_ENTRIES), lastCheckpoint: stage, activeStage: null, ...extra }, ...publicPatch });
}
export async function processJob(jobId) {
  const result = await withJobLock(jobId, () => runJob(jobId));
  if (result?.lockBusy) {
    console.info('[worker][job_lock_busy]', JSON.stringify({ jobId, retryAfterMs: 5000 }));
    return { deferred: true, retryAfterMs: 5000, duplicateExecutionPrevented: true };
  }
  return result;
}

async function runJob(jobId) {
  const initial = await getPayload(jobId); if (!initial) return; if (initial.publicJob.status === 'completed') return;
  const scheduledDelay = getScheduledJobDelayMs({ status: initial.publicJob.status, retryAt: initial.payload.retryAt });
  if (scheduledDelay > 0) {
    console.info('[worker][job_cooldown_respected]', JSON.stringify({ jobId, retryAfterMs: scheduledDelay, retryAt: initial.payload.retryAt }));
    return { deferred: true, retryAfterMs: scheduledDelay, respectingScheduledCooldown: true };
  }
  const objective = initial.payload.objective;
  const onRetry = (agent, stage) => {
    const notify = info => retryNotice(jobId, { ...info, agent, stage, interaction: 'workflow' });
    notify.getMaxOutputTokens = (requested, estimatedInputTokens) => getOutputAllowance(jobId, requested, estimatedInputTokens);
    return notify;
  };
  const initialPartialDelivery = String(initial.payload.partialDelivery || '');
  const savePartial = async info => {
    const current = await getPayload(jobId);
    if (!current || typeof info?.content !== 'string') return;
    const fresh = info.content;
    const hasFileHeaders = /^#{1,6}\s+(?:Archivo|File|Ruta)\s*:/im.test(fresh);
    const preserved = initialPartialDelivery
      ? (hasFileHeaders ? mergeDelivery(initialPartialDelivery, fresh) : `${initialPartialDelivery}\n\n${fresh}`)
      : fresh;
    await updateJob(jobId, { payload: { partialDelivery: preserved, partialOutputAt: new Date().toISOString() } });
  };
  const canContinue = async (_requested, estimatedInputTokens = 0) => { const record = await getPayload(jobId); const configured = Number.parseInt(process.env.MAX_TASK_TOKENS || '1000000', 10); const fallback = Number.isFinite(configured) ? Math.min(1000000, Math.max(4000, configured)) : 1000000; const budget = Math.min(1000000, Math.max(4000, Number(record?.payload?.tokenBudget) || fallback)); const used = Number(record?.payload?.tokenUsage?.totalTokens) || 0; return Math.max(0, budget - used - Math.max(0, Math.ceil(Number(estimatedInputTokens) || 0))); };
  let payload = initial.payload; let { proposal = '', critique = '', strategy = '', coherence = '', delivery = '', partialDelivery = '' } = payload;
  try {
    if (!proposal) {
      await startAgent(jobId, 'Arquitectura', 5, 'Arquitecto', 'Estoy analizando el objetivo y preparando una propuesta técnica.');
      await assertTaskTokenBudget(jobId);
      proposal = await agenteArquitecto(objective, onRetry('Arquitecto', 'Arquitectura'));
      await checkpoint(jobId, 'Auditoría escéptica', 15, 'Arquitecto', proposal, { proposal });
    }
    if (!critique) {
      await startAgent(jobId, 'Auditoría escéptica', 15, 'Escéptico', 'Estoy revisando la propuesta para encontrar riesgos, contradicciones y casos límite.');
      await assertTaskTokenBudget(jobId);
      critique = await agenteEsceptico(objective, proposal, onRetry('Escéptico', 'Auditoría escéptica'));
      await checkpoint(jobId, 'Síntesis técnica', 25, 'Escéptico', critique, { proposal, critique });
    }
    if (!strategy) {
      await startAgent(jobId, 'Síntesis técnica', 25, 'Árbitro', 'Estoy comparando la propuesta y las objeciones para acordar un plan.');
      await assertTaskTokenBudget(jobId);
      strategy = await agenteArbitro(objective, proposal, critique, onRetry('Árbitro', 'Síntesis técnica'));
      await checkpoint(jobId, 'Desarrollo', 35, 'Árbitro', strategy, { proposal, critique, strategy });
    }
    if (!coherence) {
      await startAgent(jobId, 'Mapa de coherencia', 30, 'Coordinador de coherencia', 'Estoy definiendo los contratos compartidos, dependencias y reglas que todos los agentes deberán respetar.');
      await assertTaskTokenBudget(jobId);
      coherence = await agenteCoordinador(objective, strategy, proposal, critique, onRetry('Coordinador de coherencia', 'Mapa de coherencia'));
      await checkpoint(jobId, 'Mapa de coherencia', 32, 'Coordinador de coherencia', coherence, { proposal, critique, strategy, coherence });
    }
    if (!delivery) {
      await startAgent(jobId, 'Desarrollo', 35, 'Desarrollador', 'Estoy preparando la entrega respetando el mapa compartido de coherencia.');
      await assertTaskTokenBudget(jobId);
      if (partialDelivery) {
        delivery = partialDelivery;
        const continuation = await agenteDesarrollador(objective, strategy, 'CONTINUÁ LA ENTREGA TRUNCADA. El contenido previo quedó cortado por el límite de salida. Terminá el archivo incompleto y entregá completos los archivos afectados, sin repetir el contenido anterior como explicación.', onRetry('Desarrollador', 'Desarrollo'), partialDelivery, coherence, canContinue, savePartial);
        delivery = mergeDelivery(partialDelivery, continuation);
      } else {
        delivery = await agenteDesarrollador(objective, strategy, '', onRetry('Desarrollador', 'Desarrollo'), '', coherence, canContinue, savePartial);
      }
      await checkpoint(jobId, 'Validación', 55, 'Desarrollador', delivery, { proposal, critique, strategy, coherence, delivery, partialDelivery: '', partialOutputAt: null });
      await saveArtifacts(jobId, delivery);
    }
    payload = (await getPayload(jobId))?.payload || {};
    let validation = payload.validation || null; let syntax = payload.syntax || null;
    let resumeState = getValidationResumeState(payload, (await getPayload(jobId))?.publicJob.attempt || 0);
    let round = resumeState.round;
    while (round <= MAX_ROUNDS) {
      const saved = resumeState.validationSaved;
      const progress = Math.min(60 + Math.round((round - 1) * 30 / MAX_ROUNDS), 90);
      if (!saved) {
        let coherenceReview = resumeState.coherenceReview;
        if (!coherenceReview) {
          await startAgent(jobId, `Auditoría de coherencia ${round}/${MAX_ROUNDS}`, progress, 'Coordinador de coherencia', 'Estoy comprobando que los archivos respeten el mapa común y que sus interfaces sean compatibles.');
          await assertTaskTokenBudget(jobId);
          coherenceReview = await agenteAuditorCoherencia(objective, coherence, delivery, onRetry('Coordinador de coherencia', `Auditoría de coherencia ${round}`));
          await checkpoint(jobId, `Auditoría de coherencia ${round}`, progress + 2, 'Coordinador de coherencia', JSON.stringify(coherenceReview), { proposal, critique, strategy, coherence, coherenceReview, coherenceReviewRound: round, activeValidationRound: round, delivery, validation: null, syntax: null });
        }
        await startAgent(jobId, `Validación ${round}/${MAX_ROUNDS}`, progress + 2, 'Validador', 'Estoy haciendo una revisión independiente y una comprobación determinista.');
        await assertTaskTokenBudget(jobId);
        validation = await agenteValidador(objective, strategy, delivery, onRetry('Validador', `Validación ${round}`));
        if (coherenceReview.verdict !== 'APPROVED') {
          validation = {
            ...validation,
            verdict: 'NEEDS_CHANGES',
            findings: [...(coherenceReview.findings || []).map(finding => 'Coherencia entre archivos: ' + finding), ...(validation.findings || [])].slice(0, 30),
            summary: 'El coordinador detectó posibles incompatibilidades entre archivos. ' + String(validation.summary || '').slice(0, 3500)
          };
        }
        syntax = await checkJavascriptSyntax(delivery);
        const current = await getPayload(jobId); if (!current) throw new Error('La tarea dejó de existir durante la validación.');
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
        await updateJob(jobId, { status: 'running', stage: `Validación ${round}/${MAX_ROUNDS}`, progress: progress + 5, attempt: round, payload: { transcript: transcript.slice(-MAX_TRANSCRIPT_ENTRIES), proposal, critique, strategy, coherenceReview: coherenceReview || null, coherenceReviewRound: round, activeValidationRound: round, delivery, validation, syntax, validationRound: round, lastCheckpoint: `validation-${round}` } });
        payload = (await getPayload(jobId))?.payload || {};
        resumeState = getValidationResumeState(payload, round);
      }
      if (validation?.verdict === 'APPROVED' && syntax?.ok) {
        const validationLevel = syntax.checked ? 'ai_and_syntax' : 'ai_review_only';
        const result = { status: 'completed', validationLevel, summary: validation.summary, delivery, validation, syntax };
        const latestPayload = (await getPayload(jobId))?.payload || {};
        const transcript = appendEntries(latestPayload.transcript, [{
          at: new Date().toISOString(), agent: 'sistema', type: 'check',
          content: `El comité terminó la tarea y la validación final fue aprobada (${validationLevel === 'ai_and_syntax' ? 'revisión de IA y sintaxis' : 'revisión de IA'}). El resultado está listo para revisar.`
        }]);
        await updateJob(jobId, { status: 'completed', stage: syntax.checked ? 'Completado · IA + sintaxis' : 'Completado · revisión IA', progress: 100, attempt: round, error: null, payload: { proposal, critique, strategy, coherence, coherenceReview: latestPayload.coherenceReview || null, delivery, validation, syntax, validationRound: round, validationLevel, result, transcript, activeStage: null, lastCheckpoint: 'completed' } });
        return;
      }
      if (round >= MAX_ROUNDS) break;
      const findings = [...(validation?.findings || [])]; if (syntax && !syntax.ok) findings.push(syntax.message);
      if (!findings.length) findings.push('La revisión no aprobó la entrega; explicá y corregí los puntos débiles.');
      await startAgent(jobId, `Corrección ${round}`, Math.min(progress + 5, 94), 'Desarrollador (corrección)', 'Estoy corrigiendo los hallazgos de la revisión antes de volver a validar.');
      await assertTaskTokenBudget(jobId);
      const repairContext = selectRepairContext(delivery, findings.join('\n'));
      const correctedDelivery = await agenteDesarrollador(objective, strategy, findings.join('\n'), onRetry('Desarrollador (corrección)', `Corrección ${round}`), repairContext, coherence, canContinue, savePartial);
      const mergedDelivery = mergeDelivery(delivery, correctedDelivery);
      await checkpoint(jobId, `Corrección ${round}`, Math.min(progress + 8, 95), 'Desarrollador (corrección)', mergedDelivery, { proposal, critique, strategy, coherence, coherenceReview: null, coherenceReviewRound: null, activeValidationRound: round + 1, delivery: mergedDelivery, validation: null, syntax: null, validationRound: round, lastCheckpoint: `correction-${round}` });
      await saveArtifacts(jobId, mergedDelivery);
      delivery = mergedDelivery; validation = null; syntax = null; payload = (await getPayload(jobId))?.payload || {}; round += 1; resumeState = getValidationResumeState(payload, round - 1);
    }
    const finalPayload = (await getPayload(jobId))?.payload || {};
    const reviewTranscript = appendEntries(finalPayload.transcript, [{
      at: new Date().toISOString(), agent: 'sistema', type: 'check',
      content: 'El comité terminó sus intentos automáticos, pero la validación no aprobó todos los criterios. La entrega queda pendiente de revisión humana; no se considera aprobada.'
    }]);
    await updateJob(jobId, { status: 'needs_review', stage: 'Requiere revisión humana', progress: 99, attempt: MAX_ROUNDS, error: 'La revisión automática no aprobó todos los criterios; requiere revisión humana.', payload: { ...finalPayload, proposal, critique, strategy, coherence, delivery, validation, syntax, transcript: reviewTranscript, activeStage: null, result: { status: 'needs_review', delivery, validation, syntax }, lastCheckpoint: 'needs_review' } });
  } catch (error) {
    const current = await getPayload(jobId);
    if (error?.code === 'TASK_TOKEN_BUDGET' && current) {
      const configured = Number.parseInt(process.env.MAX_TASK_TOKENS || '1000000', 10);
      const fallback = Number.isFinite(configured) ? Math.min(1000000, Math.max(4000, configured)) : 1000000;
      const currentBudget = Math.min(1000000, Math.max(4000, Number(current.payload.tokenBudget) || fallback));
      const nextBudget = nextAutomaticTokenBudget(currentBudget);
      if (nextBudget && nextBudget > currentBudget) {
        const patch = buildAutomaticBudgetExtensionPatch(current, currentBudget, nextBudget);
        if (patch) {
          await updateJob(jobId, patch);
          console.warn('[worker][token_budget_auto_extended]', JSON.stringify({
            jobId, usedTokens: error.usedTokens ?? null, previousLimit: currentBudget,
            nextLimit: nextBudget, increment: nextBudget - currentBudget,
            checkpoint: patch.payload.lastCheckpoint, progress: patch.progress
          }));
          return { deferred: true, retryAfterMs: 1000, budgetExtended: true };
        }
      }
      const patch = buildBudgetPausePatch(current, error);
      console.warn('[worker][token_budget_paused]', JSON.stringify({ jobId, usedTokens: error.usedTokens ?? null, tokenLimit: error.tokenLimit ?? null, estimatedInputTokens: error.estimatedInputTokens ?? null, checkpoint: patch.payload.lastCheckpoint, progress: patch.progress }));
      await updateJob(jobId, patch);
      // At the 1M ceiling, fork a durable continuation automatically. The database
      // row lock inside createContinuationJob makes this transition idempotent.
      const continuation = await createContinuationJob(jobId);
      if (continuation?.error) {
        console.error('[worker][token_batch_continuation_failed]', JSON.stringify({ jobId, status: continuation.status || null, error: continuation.error }));
        return { blocked: true, reason: patch.error };
      }
      console.warn('[worker][token_batch_continuation]', JSON.stringify({
        sourceJobId: jobId, continuationJobId: continuation.job.id,
        created: continuation.created, tokenBudget: 1000000,
        continuationNumber: continuation.job.attempt || null,
        checkpoint: patch.payload.lastCheckpoint
      }));
      return { deferred: true, retryAfterMs: 1000, continuationJobId: continuation.job.id, budgetContinuation: true };
    }
    if (error?.code === 'PROVIDER_TEMPORARY' && current) {
      const failureStreak = Math.min(20, (Number(current.payload.providerFailureStreak) || 0) + 1);
      const retryAfterMs = getDeferredCooldownMs(Number(error.retryAfterMs) || 30000, failureStreak);
      const retryAt = new Date(Date.now() + retryAfterMs).toISOString();
      const reason = String(error.message || 'Proveedor temporalmente no disponible').slice(0, 1200);
      const transcript = appendEntries(current.payload.transcript, [{ at: new Date().toISOString(), agent: 'sistema', type: 'retry', content: `Tarea pausada de forma segura. Motivo: ${reason} Próximo intento automático: ${retryAt}. Se conserva el checkpoint ${current.payload.lastCheckpoint || 'guardado'}.` }]);
      await updateJob(jobId, { status: 'queued', stage: 'Esperando disponibilidad del proveedor', progress: current.publicJob.progress, error: null, payload: { ...current.payload, transcript, retryAt, providerFailureStreak: failureStreak, providerBlock: { code: error.code, model: error.providerModel || null, retry: error.providerRetry || null, failureStreak, reason, retryAfterMs }, lastCheckpoint: current.payload.lastCheckpoint || 'provider-deferred', activeStage: null } });
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
      await updateJob(jobId, { status: 'failed', stage: 'Error de procesamiento', error: 'La tarea se interrumpió por un error. Consultá el detalle técnico y corregí la configuración si corresponde.', payload: { ...current.payload, transcript, lastCheckpoint: current.payload.lastCheckpoint || 'error' } });
    }
  }
}