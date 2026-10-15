import test from 'node:test';
import assert from 'node:assert/strict';
import { parseValidationResponse } from '../apps/worker/services/aiProviders.js';
import { getValidationResumeState } from '../apps/worker/services/validationResume.js';

test('validation parser accepts a valid JSON object inside surrounding prose', () => {
  const result = parseValidationResponse('Resultado:\n```json\n{"verdict":"APPROVED","findings":[],"summary":"Todo correcto"}\n```');
  assert.equal(result.verdict, 'APPROVED');
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary, 'Todo correcto');
});

test('validation parser handles braces and escaped quotes inside JSON strings', () => {
  const result = parseValidationResponse('{"verdict":"NEEDS_CHANGES","findings":["Ruta {x}: dijo \\"hola\\""],"summary":"Revisar {x}"}');
  assert.equal(result.verdict, 'NEEDS_CHANGES');
  assert.match(result.findings[0], /hola/);
  assert.match(result.summary, /\{x\}/);
});

test('validation parser skips unrelated JSON and selects the object with the expected schema', () => {
  const result = parseValidationResponse('Debug {"other":true} luego {"verdict":"APPROVED","findings":[],"summary":"válido"}');
  assert.equal(result.verdict, 'APPROVED');
  assert.equal(result.summary, 'válido');
});

test('validation parser never approves malformed or schema-invalid output', () => {
  for (const raw of ['no es JSON', '{"verdict":"APPROVED","findings":[]}', '{"verdict":"MAYBE","findings":[],"summary":"?"}']) {
    assert.equal(parseValidationResponse(raw).verdict, 'NEEDS_CHANGES');
  }
});

test('validation parser normalizes HTML bracket entities and escaped underscores', () => {
  const raw = '{"verdict":"NEEDS\\_CHANGES","findings":&#91;"src/player.gd: EventBus no registrado"&#93;,"summary":"Hay un bloqueo"}';
  const result = parseValidationResponse(raw);
  assert.equal(result.verdict, 'NEEDS_CHANGES');
  assert.deepEqual(result.findings, ['src/player.gd: EventBus no registrado']);
});

test('validation parser salvages findings from a truncated NEEDS_CHANGES response', () => {
  const raw = '{"verdict":"NEEDS_CHANGES","findings":["src/player.tscn: Gradient inválido","src/enemy.gd: EventBus no registrado","src/crystal.gd: llamada truncada';
  const result = parseValidationResponse(raw);
  assert.equal(result.verdict, 'NEEDS_CHANGES');
  assert.equal(result.findings.length, 3);
  assert.match(result.findings[0], /Gradient inválido/);
  assert.match(result.findings[1], /EventBus no registrado/);
  assert.match(result.findings[2], /llamada truncada/);
  assert.match(result.summary, /truncado|rescat|visibles/i);
});

test('retry checkpoint starts a fresh coherence review instead of reusing a failed batch', () => {
  const state = getValidationResumeState({
    lastCheckpoint: 'retry-requested',
    activeValidationRound: null,
    coherenceReviewRound: null,
    coherenceReview: null,
    validationRound: 0,
    validation: null,
    syntax: null
  }, 0);
  assert.equal(state.round, 1);
  assert.equal(state.coherenceReview, null);
  assert.equal(state.validationSaved, false);
});
