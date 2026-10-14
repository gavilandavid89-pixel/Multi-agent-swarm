const number = value => Math.max(0, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0);
const key = (value, fallback) => String(value || fallback).slice(0, 100);

function counter(previous = {}) {
  return {
    promptTokens: number(previous.promptTokens),
    completionTokens: number(previous.completionTokens),
    totalTokens: number(previous.totalTokens),
    calls: number(previous.calls)
  };
}
function increment(previous, promptTokens, completionTokens, totalTokens) {
  const next = counter(previous);
  next.promptTokens += promptTokens;
  next.completionTokens += completionTokens;
  next.totalTokens += totalTokens;
  next.calls += 1;
  return next;
}

/**
 * Applies one provider-reported usage event.
 * The caller persists usageEventIds together with tokenUsage in the same DB transaction.
 * Tokens after workflow completion are counted transparently but flagged as waste; direct user chat is excluded.
 */
export function applyTokenUsage(currentValue, info = {}, { eventIds = [], status = 'running' } = {}) {
  const current = currentValue && typeof currentValue === 'object' ? currentValue : {};
  const ids = Array.isArray(eventIds) ? eventIds : [];
  const usageId = String(info.usageId || '').slice(0, 120);
  if (usageId && ids.includes(usageId)) {
    return {
      duplicate: true,
      usage: { ...current, dedupedEvents: number(current.dedupedEvents) + 1 },
      eventIds: ids,
      event: null
    };
  }

  const promptTokens = number(info.promptTokens);
  const completionTokens = number(info.completionTokens);
  const reportedTotal = number(info.totalTokens);
  const totalTokens = reportedTotal || promptTokens + completionTokens;
  const model = key(info.model, 'desconocido');
  const agent = key(info.agent, 'Agente sin clasificar');
  const stage = key(info.stage, 'Etapa sin clasificar');
  const interaction = ['direct-chat', 'improvement-vote'].includes(info.interaction) ? info.interaction : 'workflow';
  const countedAsWaste = status === 'completed' && interaction === 'workflow';

  const byModel = { ...(current.byModel || {}) };
  byModel[model] = increment(byModel[model], promptTokens, completionTokens, totalTokens);
  const byAgent = { ...(current.byAgent || {}) };
  byAgent[agent] = increment(byAgent[agent], promptTokens, completionTokens, totalTokens);
  const byStage = { ...(current.byStage || {}) };
  byStage[stage] = increment(byStage[stage], promptTokens, completionTokens, totalTokens);
  const byInteraction = { ...(current.byInteraction || {}) };
  byInteraction[interaction] = increment(byInteraction[interaction], promptTokens, completionTokens, totalTokens);

  const usage = {
    ...increment(current, promptTokens, completionTokens, totalTokens),
    byModel,
    byAgent,
    byStage,
    byInteraction,
    wastedTokens: number(current.wastedTokens) + (countedAsWaste ? totalTokens : 0),
    wastedCalls: number(current.wastedCalls) + (countedAsWaste ? 1 : 0),
    unreportedCalls: number(current.unreportedCalls) + (totalTokens === 0 ? 1 : 0),
    dedupedEvents: number(current.dedupedEvents)
  };
  const nextIds = usageId ? [...ids, usageId].slice(-2000) : ids;
  return {
    duplicate: false,
    usage,
    eventIds: nextIds,
    event: { usageId: usageId || null, model, agent, stage, interaction, promptTokens, completionTokens, totalTokens, statusAtResponse: status, countedAsWaste }
  };
}

const budgetStagePattern = /presupuesto|tokens/i;

export function isBudgetPausedJob(job = {}) {
  return job?.status === 'needs_review' && budgetStagePattern.test(String(job?.stage || ''));
}

export function canContinueBudgetTask(job = {}, payload = {}) {
  return isBudgetPausedJob(job) && !payload?.continuedByJobId;
}

/** Increase a task budget in controlled 25k steps; null means the 100k cap is already reached. */
export function nextAutomaticTokenBudget(currentValue) {
  const current = Math.min(100000, Math.max(4000, Math.round(number(currentValue || 50000) / 1000) * 1000));
  return current >= 100000 ? null : Math.min(100000, current + 25000);
}

/** Resume the same task after an automatic budget increase, preserving its checkpoint and transcript. */
export function buildAutomaticBudgetExtensionPatch(current = {}, fromBudget, toBudget, timestamp = new Date().toISOString()) {
  const payload = current?.payload && typeof current.payload === 'object' ? current.payload : {};
  const from = Math.min(100000, Math.max(4000, Math.round(number(fromBudget || payload.tokenBudget || 50000) / 1000) * 1000));
  const to = Math.min(100000, Math.max(4000, Math.round(number(toBudget) / 1000) * 1000));
  if (to <= from || to > 100000) return null;
  const checkpoint = String(payload.lastCheckpoint || 'último checkpoint guardado').slice(0, 160);
  const transcript = [...(Array.isArray(payload.transcript) ? payload.transcript : []), {
    at: timestamp,
    agent: 'sistema',
    type: 'budget',
    content: `Se agotó el límite de ${from.toLocaleString('es-AR')} tokens. El presupuesto se amplió automáticamente a ${to.toLocaleString('es-AR')} (+${(to-from).toLocaleString('es-AR')}); la tarea seguirá desde el checkpoint ${checkpoint}.`
  }].slice(-150);
  return {
    status: 'queued',
    stage: `Reanudando · presupuesto ampliado a ${to.toLocaleString('es-AR')}`,
    progress: Math.min(95, Math.max(0, Number(current?.publicJob?.progress) || 0)),
    error: null,
    payload: {
      ...payload,
      tokenBudget: to,
      transcript,
      result: null,
      providerBlock: null,
      retryAt: null,
      activeStage: null,
      lastBudgetIncrease: { from, to, at: timestamp },
      lastCheckpoint: payload.lastCheckpoint || 'token-budget'
    }
  };
}

/** Build a durable state transition when a task runs out of its token budget. */
export function buildBudgetPausePatch(current = {}, error = {}, timestamp = new Date().toISOString()) {
  const payload = current?.payload && typeof current.payload === 'object' ? current.payload : {};
  const reason = String(error?.message || 'Presupuesto de tokens agotado').slice(0, 1200);
  const transcript = [...(Array.isArray(payload.transcript) ? payload.transcript : []), {
    at: timestamp, agent: 'sistema', type: 'budget', content: reason
  }].slice(-150);
  const providerBlock = {
    code: 'TASK_TOKEN_BUDGET',
    ...(Number.isFinite(Number(error?.usedTokens)) ? { usedTokens: Math.max(0, Math.trunc(Number(error.usedTokens))) } : {}),
    ...(Number.isFinite(Number(error?.tokenLimit)) ? { tokenLimit: Math.max(0, Math.trunc(Number(error.tokenLimit))) } : {}),
    ...(Number.isFinite(Number(error?.estimatedInputTokens)) ? { estimatedInputTokens: Math.max(0, Math.trunc(Number(error.estimatedInputTokens))) } : {})
  };
  return {
    status: 'needs_review',
    stage: 'Pausada por presupuesto de tokens',
    progress: Math.max(0, Number(current?.publicJob?.progress) || 0),
    error: reason,
    payload: {
      ...payload, transcript, providerBlock, activeStage: null,
      lastCheckpoint: payload.lastCheckpoint || 'token-budget'
    }
  };
}

/**
 * Prepare a fresh budget batch without losing checkpoint data or source artifacts.
 * Usage counters reset per batch; prior batches remain visible for cumulative accounting.
 */
export function prepareContinuationPayload(sourcePayload = {}, sourceJob = {}, timestamp = new Date().toISOString()) {
  const currentUsage = sourcePayload.tokenUsage || {};
  const previousBatches = Array.isArray(sourcePayload.tokenBatchHistory) ? sourcePayload.tokenBatchHistory : [];
  const continuationNumber = previousBatches.length + 2;
  const batchSnapshot = {
    jobId: String(sourceJob.id || ''),
    batchNumber: continuationNumber - 1,
    tokenBudget: Math.max(0, Number(sourcePayload.tokenBudget) || 50000),
    tokenUsage: {
      promptTokens: number(currentUsage.promptTokens),
      completionTokens: number(currentUsage.completionTokens),
      totalTokens: number(currentUsage.totalTokens),
      calls: number(currentUsage.calls),
      wastedTokens: number(currentUsage.wastedTokens)
    },
    lastCheckpoint: sourcePayload.lastCheckpoint || null,
    stage: String(sourceJob.stage || ''),
    closedAt: timestamp
  };
  const transcript = [...(Array.isArray(sourcePayload.transcript) ? sourcePayload.transcript : [])];
  transcript.push({
    at: timestamp,
    agent: 'sistema',
    type: 'budget',
    content: 'Se abrió una nueva tanda de 100.000 tokens. Se conserva el checkpoint, las decisiones, el contexto y los archivos de la tanda anterior; el contador de esta tanda comienza en cero.'
  });
  return {
    ...sourcePayload,
    tokenBudget: 100000,
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, byModel: {}, byAgent: {}, byStage: {}, byInteraction: {}, wastedTokens: 0, wastedCalls: 0, unreportedCalls: 0, dedupedEvents: 0 },
    usageEventIds: [],
    tokenBatchHistory: [...previousBatches, batchSnapshot].slice(-50),
    continuationOf: String(sourceJob.id || ''),
    continuationNumber,
    continuedByJobId: null,
    retryAt: null,
    providerBlock: null,
    providerFailureStreak: 0,
    result: null,
    activeStage: null,
    transcript: transcript.slice(-150)
  };
}
