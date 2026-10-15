import test from 'node:test';
import assert from 'node:assert/strict';
import { recordAgentCheckpoint, getAgentMemorySnapshot } from '../apps/worker/services/agentMemory.js';

test('guarda una nota individual y una nota compartida en cada checkpoint', () => {
  const first = recordAgentCheckpoint({ objective: 'Crear app' }, {
    at: '2026-10-15T00:00:00.000Z', agent: 'Arquitecto', stage: 'Arquitectura', content: 'Definí módulos y contratos.'
  });
  assert.match(first.agentDocuments.arquitecto.markdown, /Definí módulos y contratos/);
  assert.match(first.sharedDocument, /Arquitectura — Arquitecto/);\n  assert.ok(first.sharedDocument.includes('Objetivo original') && first.sharedDocument.includes('Crear app'));
  const second = recordAgentCheckpoint(first, {
    at: '2026-10-15T00:01:00.000Z', agent: 'Desarrollador', stage: 'Desarrollo', content: 'Creé el módulo principal.'
  });
  assert.match(second.sharedDocument, /Definí módulos y contratos/);
  assert.match(second.sharedDocument, /Creé el módulo principal/);\n  assert.ok(second.sharedDocument.includes('Plan / estrategia vigente') && second.sharedDocument.includes('El plan todavía no está definido'));
  assert.equal(second.agentDocuments.arquitecto.entries.length, 1);
  assert.equal(second.agentDocuments.desarrollador.entries.length, 1);
});

test('limita el tamaño de los documentos y el historial de entradas', () => {
  let payload = {};
  for (let i = 0; i < 55; i++) {
    payload = recordAgentCheckpoint(payload, {
      at: new Date(i * 1000).toISOString(), agent: 'Validador', stage: 'Validación ' + i, content: 'x'.repeat(5000)
    });
  }
  assert.equal(payload.agentDocuments.validador.entries.length, 40);
  assert.ok(payload.agentDocuments.validador.markdown.length <= 18000);
  assert.ok(payload.sharedDocument.length <= 24000);
});

test('expone una instantánea sin modificar el payload original', () => {
  const payload = recordAgentCheckpoint({}, { agent: 'Escéptico', stage: 'Auditoría', content: 'Riesgo de regresión.' });
  const snapshot = getAgentMemorySnapshot(payload);
  assert.equal(snapshot.agents[0].agent, 'Escéptico');
  assert.match(snapshot.sharedDocument, /Riesgo de regresión/);
  assert.equal(payload.agentDocuments['escéptico'].entries.length, 1);
});
