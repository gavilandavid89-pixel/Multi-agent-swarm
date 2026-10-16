import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTokenUsage, prepareContinuationPayload, buildBudgetPausePatch, buildAutomaticBudgetExtensionPatch, nextAutomaticTokenBudget, isBudgetPausedJob, canContinueBudgetTask } from '../apps/worker/services/tokenAccounting.js';

const usageEvent = (overrides = {}) => ({
  usageId: 'call-1', model: 'model-a', agent: 'Arquitecto', stage: 'Arquitectura',
  interaction: 'workflow', promptTokens: 100, completionTokens: 40, totalTokens: 140,
  ...overrides
});

test('agrega tokens de forma consistente por modelo, agente, etapa e interacción', () => {
  const result = applyTokenUsage(null, usageEvent(), { status: 'running' });
  assert.equal(result.usage.totalTokens, 140);
  assert.equal(result.usage.calls, 1);
  assert.equal(result.usage.byModel['model-a'].totalTokens, 140);
  assert.equal(result.usage.byAgent.Arquitecto.totalTokens, 140);
  assert.equal(result.usage.byStage.Arquitectura.totalTokens, 140);
  assert.equal(result.usage.byInteraction.workflow.totalTokens, 140);
  assert.deepEqual(result.eventIds, ['call-1']);
  assert.equal(result.event.countedAsWaste, false);
});

test('ignora el mismo evento si un callback se repite y no duplica tokens', () => {
  const first = applyTokenUsage(null, usageEvent(), { status: 'running' });
  const second = applyTokenUsage(first.usage, usageEvent(), { eventIds: first.eventIds, status: 'running' });
  assert.equal(second.duplicate, true);
  assert.equal(second.usage.totalTokens, 140);
  assert.equal(second.usage.calls, 1);
  assert.equal(second.usage.dedupedEvents, 1);
});

test('separa los tokens de la votación de mejoras del trabajo automático', () => {
  const result = applyTokenUsage(null, usageEvent({ interaction: 'improvement-vote', stage: 'Votación de mejora' }), { status: 'completed' });
  assert.equal(result.usage.totalTokens, 140);
  assert.equal(result.usage.wastedTokens, 0);
  assert.equal(result.usage.byInteraction['improvement-vote'].totalTokens, 140);
  assert.equal(result.event.interaction, 'improvement-vote');
});

test('marca como desperdicio una respuesta de flujo que llega después del cierre', () => {
  const result = applyTokenUsage(null, usageEvent({ usageId: 'late-1' }), { status: 'completed' });
  assert.equal(result.usage.totalTokens, 140);
  assert.equal(result.usage.wastedTokens, 140);
  assert.equal(result.usage.wastedCalls, 1);
  assert.equal(result.event.countedAsWaste, true);
});

test('no etiqueta el chat solicitado por el usuario como desperdicio tras completar la tarea', () => {
  const result = applyTokenUsage(null, usageEvent({ usageId: 'chat-1', interaction: 'direct-chat', stage: 'Chat directo' }), { status: 'completed' });
  assert.equal(result.usage.totalTokens, 140);
  assert.equal(result.usage.wastedTokens, 0);
  assert.equal(result.usage.byInteraction['direct-chat'].totalTokens, 140);
  assert.equal(result.event.countedAsWaste, false);
});

test('cuenta llamadas sin usage de tokens reportado sin inventar consumo', () => {
  const result = applyTokenUsage(null, usageEvent({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }), { status: 'running' });
  assert.equal(result.usage.calls, 1);
  assert.equal(result.usage.totalTokens, 0);
  assert.equal(result.usage.unreportedCalls, 1);
});


test('una tarea de continuación de 1M conserva contexto y archivos y registra el consumo previo', () => {
  const timestamp = '2026-10-14T01:00:00.000Z';
  const source = {
    objective: 'Construir una app',
    tokenBudget: 50000,
    tokenUsage: { promptTokens: 30000, completionTokens: 20000, totalTokens: 50000, calls: 12, wastedTokens: 100 },
    usageEventIds: ['old-event'],
    proposal: 'decisiones de arquitectura',
    critique: 'riesgos',
    strategy: 'plan aprobado',
    coherence: 'contratos entre archivos',
    delivery: '### Archivo: src/app.js\\n```js\\nconst ok = true;\\n```',
    partialDelivery: '',
    artifacts: [{ path: 'src/app.js', content: 'const ok = true;' }],
    lastCheckpoint: 'validation-1',
    validationRound: 1,
    transcript: [{ agent: 'Arquitecto', type: 'message', content: 'decisión guardada' }]
  };
  const next = prepareContinuationPayload(source, { id: 'old-job', stage: 'Pausada por presupuesto de tokens' }, timestamp);
  assert.equal(next.tokenBudget, 1000000);
  assert.equal(next.tokenUsage.totalTokens, 0);
  assert.equal(next.tokenUsage.calls, 0);
  assert.deepEqual(next.usageEventIds, []);
  assert.equal(next.continuationOf, 'old-job');
  assert.equal(next.continuationNumber, 2);
  assert.equal(next.lastCheckpoint, 'validation-1');
  assert.equal(next.delivery, source.delivery);
  assert.deepEqual(next.artifacts, source.artifacts);
  assert.equal(next.strategy, source.strategy);
  assert.equal(next.tokenBatchHistory.length, 1);
  assert.equal(next.tokenBatchHistory[0].tokenUsage.totalTokens, 50000);
  assert.equal(next.tokenBatchHistory[0].tokenUsage.wastedTokens, 100);
  assert.ok(next.transcript.some(item => /tarea de continuación con un presupuesto nuevo de hasta 1.000.000/.test(item.content)));
});


test('la simulación de agotamiento pausa la tarea sin perder checkpoint ni entrega parcial', () => {
  const current = {
    publicJob: { id: 'simulated-job', status: 'running', stage: 'Validación', progress: 63 },
    payload: {
      objective: 'Terminar la app', lastCheckpoint: 'validation-1',
      partialDelivery: '### Archivo: src/app.js\\n\\x60\\x60\\x60js\\nconst app = true;\\n\\x60\\x60\\x60',
      artifacts: [{ path: 'src/app.js', content: 'const app = true;' }],
      transcript: [{ at: 'before', agent: 'Arquitecto', type: 'message', content: 'plan guardado' }]
    }
  };
  const patch = buildBudgetPausePatch(current, Object.assign(new Error('Límite simulado alcanzado'), {
    usedTokens: 50000, tokenLimit: 50000, estimatedInputTokens: 900
  }), '2026-10-14T02:00:00.000Z');
  assert.equal(patch.status, 'needs_review');
  assert.match(patch.stage, /presupuesto de tokens/i);
  assert.equal(patch.progress, 63);
  assert.equal(patch.payload.lastCheckpoint, 'validation-1');
  assert.equal(patch.payload.partialDelivery, current.payload.partialDelivery);
  assert.deepEqual(patch.payload.artifacts, current.payload.artifacts);
  assert.deepEqual(patch.payload.providerBlock, { code: 'TASK_TOKEN_BUDGET', usedTokens: 50000, tokenLimit: 50000, estimatedInputTokens: 900 });
  assert.ok(patch.payload.transcript.some(item => /Límite simulado/.test(item.content)));
});

test('solo ofrece continuación para tareas pausadas por presupuesto que aún no tengan hija', () => {
  const paused = { status: 'needs_review', stage: 'Pausada por presupuesto de tokens' };
  assert.equal(isBudgetPausedJob(paused), true);
  assert.equal(canContinueBudgetTask(paused, {}), true);
  assert.equal(canContinueBudgetTask(paused, { continuedByJobId: 'child-1' }), false);
  assert.equal(canContinueBudgetTask({ status: 'needs_review', stage: 'Requiere revisión humana' }, {}), false);
  assert.equal(canContinueBudgetTask({ status: 'failed', stage: 'Pausada por presupuesto de tokens' }, {}), false);
});

test('una segunda tarea de continuación conserva el historial completo y registra el consumo previo', () => {
  const first = prepareContinuationPayload({
    objective: 'Objetivo', tokenBudget: 4000,
    tokenUsage: { promptTokens: 2000, completionTokens: 2000, totalTokens: 4000, calls: 3 },
    lastCheckpoint: 'development', artifacts: [{ path: 'index.js', content: 'ok' }]
  }, { id: 'job-1', stage: 'Pausada por presupuesto de tokens' }, '2026-10-14T01:00:00Z');
  first.tokenUsage = { ...first.tokenUsage, promptTokens: 70000, completionTokens: 30000, totalTokens: 100000, calls: 30 };
  const second = prepareContinuationPayload(first, { id: 'job-2', stage: 'Pausada por presupuesto de tokens' }, '2026-10-14T02:00:00Z');
  assert.equal(second.continuationNumber, 3);
  assert.equal(second.tokenBatchHistory.length, 2);
  assert.equal(second.tokenBatchHistory[0].tokenUsage.totalTokens, 4000);
  assert.equal(second.tokenBatchHistory[1].tokenUsage.totalTokens, 100000);
  assert.equal(second.tokenBatchHistory[1].jobId, 'job-2');
  assert.equal(second.artifacts[0].content, 'ok');
  assert.equal(second.tokenUsage.totalTokens, 0);
});


test('no aumenta el presupuesto de la misma tarea: el tope se resuelve creando una continuación', () => {
  assert.equal(nextAutomaticTokenBudget(50000), null);
  assert.equal(nextAutomaticTokenBudget(1000000), null);
  assert.equal(nextAutomaticTokenBudget(25000), null);
});

test('ampliar presupuesto vuelve a poner la misma tarea en cola y limpia el estado terminal obsoleto', () => {
  const current = {
    publicJob: { id: 'job-1', status: 'needs_review', stage: 'Pausada por presupuesto de tokens', progress: 99 },
    payload: { tokenBudget: 50000, result: { status: 'needs_review' }, lastCheckpoint: 'validation-1', transcript: [{ agent: 'Validador', type: 'message', content: 'checkpoint' }] }
  };
  const patch = buildAutomaticBudgetExtensionPatch(current, 50000, 75000, '2026-10-14T03:00:00Z');
  assert.equal(patch.status, 'queued');
  assert.match(patch.stage, /75\.000/);
  assert.equal(patch.progress, 95);
  assert.equal(patch.error, null);
  assert.equal(patch.payload.tokenBudget, 75000);
  assert.equal(patch.payload.result, null);
  assert.equal(patch.payload.lastCheckpoint, 'validation-1');
  assert.deepEqual(patch.payload.lastBudgetIncrease, { from: 50000, to: 75000, at: '2026-10-14T03:00:00Z' });
  assert.match(patch.payload.transcript.at(-1).content, /checkpoint validation-1/);
});
