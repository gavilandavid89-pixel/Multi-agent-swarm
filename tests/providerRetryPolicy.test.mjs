import test from 'node:test';
import assert from 'node:assert/strict';
import { getDeferredCooldownMs, getProviderRetryDelayMs } from '../apps/worker/services/providerRetryPolicy.js';

test('prioriza el Retry-After enviado por el proveedor', () => {
  assert.equal(getProviderRetryDelayMs({ retry: 4, retryAfter: '17', random: () => 0.5 }), 17000);
});

test('lee RetryInfo.retryDelay de los errores JSON de Gemini', () => {
  const body = JSON.stringify({
    error: {
      message: 'Resource exhausted',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42.5s' }]
    }
  });
  assert.equal(getProviderRetryDelayMs({ retry: 1, bodyText: body }), 42500);
});

test('lee una sugerencia de espera del mensaje de error si no hay RetryInfo', () => {
  assert.equal(getProviderRetryDelayMs({ retry: 1, bodyText: '{"error":{"message":"Please retry in 31.25s"}}' }), 31250);
});

test('usa backoff exponencial con jitter acotado cuando no hay sugerencia del proveedor', () => {
  assert.equal(getProviderRetryDelayMs({ retry: 3, baseMs: 3000, random: () => 0.5 }), 12000);
  assert.equal(getProviderRetryDelayMs({ retry: 3, baseMs: 3000, random: () => 0 }), 9600);
});

test('aumenta la pausa entre ciclos cuando el proveedor sigue limitado', () => {
  assert.equal(getDeferredCooldownMs(20000, 1), 30000);
  assert.equal(getDeferredCooldownMs(20000, 2), 60000);
  assert.equal(getDeferredCooldownMs(20000, 3), 120000);
});

test('limita el cooldown máximo y conserva el mínimo de espera', () => {
  assert.equal(getDeferredCooldownMs(999999999, 20), 1800000);
  assert.equal(getDeferredCooldownMs(0, 0), 30000);
});
