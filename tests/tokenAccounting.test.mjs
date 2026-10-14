import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTokenUsage } from '../apps/worker/services/tokenAccounting.js';

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
