import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeliverableIntegrity } from '../apps/worker/services/deliverableValidation.js';

test('bloquea una entrega vacía aunque la revisión de IA haya aprobado', () => {
  const result = validateDeliverableIntegrity({ objective: 'Crear una app', delivery: '  ' });
  assert.equal(result.ok, false);
  assert.match(result.findings.join(' '), /vacía/);
});

test('detecta bloques de código Markdown sin cerrar', () => {
  const result = validateDeliverableIntegrity({ objective: 'Escribir código', delivery: '### Archivo: app.js\n```js\nconst x = 1;' });
  assert.equal(result.ok, false);
  assert.match(result.findings.join(' '), /sin cerrar/);
});

test('detecta una sección de archivo final sin bloque de código completo', () => {
  const result = validateDeliverableIntegrity({ objective: 'Crear archivos de código', delivery: '### Archivo: a.js\n```js\nexport const a = 1;\n```\n\n### Archivo: b.js\nPendiente de completar' });
  assert.equal(result.ok, false);
  assert.match(result.findings.join(' '), /última sección/);
});

test('valida JSON cuando la tarea lo pide', () => {
  assert.equal(validateDeliverableIntegrity({ objective: 'Devuelve JSON válido', delivery: '```json\n{"ok":true}\n```' }).ok, true);
  const invalid = validateDeliverableIntegrity({ objective: 'Devuelve JSON válido', delivery: '```json\n{"ok":}\n```' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.findings.join(' '), /JSON válido/);
});

test('no bloquea respuestas de texto por no ser JSON si no se solicitó JSON', () => {
  const result = validateDeliverableIntegrity({ objective: 'Explica una estrategia', delivery: 'Primero analiza riesgos; luego prueba.' });
  assert.equal(result.ok, true);
});
