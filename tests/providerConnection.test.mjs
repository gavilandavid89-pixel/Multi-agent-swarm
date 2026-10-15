import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCatalogStatus } from '../apps/worker/services/userProviders.js';

test('recognizes exact OpenAI-compatible model IDs', () => {
  assert.equal(modelCatalogStatus({ data: [{ id: 'gpt-test' }] }, 'gpt-test'), true);
});

test('recognizes Gemini-style model names in a catalog', () => {
  assert.equal(modelCatalogStatus({ models: [{ name: 'models/gemini-test' }] }, 'gemini-test'), true);
});

test('reports a missing model without confusing it with authentication failure', () => {
  assert.equal(modelCatalogStatus({ data: [{ id: 'other-model' }] }, 'wanted-model'), false);
});

test('returns null when a provider does not expose a model catalog', () => {
  assert.equal(modelCatalogStatus({ ok: true }, 'wanted-model'), null);
});
