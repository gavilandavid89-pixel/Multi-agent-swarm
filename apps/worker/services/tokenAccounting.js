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
  const interaction = info.interaction === 'direct-chat' ? 'direct-chat' : 'workflow';
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
