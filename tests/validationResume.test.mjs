import test from 'node:test';
import assert from 'node:assert/strict';
import { getValidationResumeState } from '../apps/worker/services/validationResume.js';

test('reutiliza una auditoría aprobada al reintentar después de un error del proveedor', () => {
  const review = { verdict: 'APPROVED', findings: [] };
  const state = getValidationResumeState({
    lastCheckpoint: 'Auditoría de coherencia 2',
    coherenceReview: review
  }, 0);
  assert.equal(state.round, 2);
  assert.equal(state.coherenceReview, review);
  assert.equal(state.validationSaved, false);
});

test('prioriza la ronda activa guardada para no reiniciar el ciclo desde uno', () => {
  const review = { verdict: 'APPROVED', findings: [] };
  const state = getValidationResumeState({
    lastCheckpoint: 'validation-2',
    activeValidationRound: 3,
    coherenceReview: review,
    coherenceReviewRound: 2
  }, 0);
  assert.equal(state.round, 3);
  assert.equal(state.coherenceReview, null);
});

test('reanuda validación ya guardada sin repetir auditoría', () => {
  const review = { verdict: 'APPROVED', findings: [] };
  const state = getValidationResumeState({
    validationRound: 2,
    validation: { verdict: 'APPROVED' },
    syntax: { ok: true },
    coherenceReview: review,
    coherenceReviewRound: 2
  }, 0);
  assert.equal(state.round, 2);
  assert.equal(state.validationSaved, true);
  assert.equal(state.coherenceReview, review);
});
