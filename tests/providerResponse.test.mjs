import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderResponseBody } from '../apps/worker/services/providerResponse.js';

test('parsea una respuesta válida de proveedor', () => {
  assert.deepEqual(parseProviderResponseBody('{"choices":[{"message":{"content":"ok"}}]}'), {
    choices: [{ message: { content: 'ok' } }]
  });
});

test('rechaza JSON truncado sin exponer el cuerpo original en el error', () => {
  assert.throws(
    () => parseProviderResponseBody('{"choices":[{"message":'),
    error => error.code === 'PROVIDER_INVALID_JSON' && !error.message.includes('choices')
  );
});

test('rechaza valores JSON que no son objetos', () => {
  assert.throws(() => parseProviderResponseBody('null'), error => error.code === 'PROVIDER_INVALID_JSON');
  assert.throws(() => parseProviderResponseBody('"texto"'), error => error.code === 'PROVIDER_INVALID_JSON');
});
