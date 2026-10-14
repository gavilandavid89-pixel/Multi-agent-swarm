import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeProviderErrorBody } from '../apps/worker/services/sanitizeProviderError.js';
import { configuredOpenAIProviders } from '../apps/worker/services/aiProviders.js';

test('redacts the active custom API key before an error can reach logs or the UI', () => {
  const secret = 'custom-provider-secret-value-123456';
  const result = sanitizeProviderErrorBody(
    JSON.stringify({ error: 'Invalid API key: ' + secret }),
    secret
  );
  assert.equal(result.includes(secret), false);
  assert.match(result, /REDACTED/);
});

test('redacts recognizable provider keys even when the active key is not supplied', () => {
  const result = sanitizeProviderErrorBody(
    'bad keys: sk-proj-12345678901234567890 gsk_12345678901234567890 AIza123456789012345678901234'
  );
  assert.equal(/sk-proj-[A-Za-z0-9_-]{8,}/.test(result), false);
  assert.equal(/gsk_[A-Za-z0-9_-]{8,}/.test(result), false);
  assert.equal(/AIza[0-9A-Za-z_-]{20,}/.test(result), false);
});

test('limits the length of untrusted provider error bodies', () => {
  assert.equal(sanitizeProviderErrorBody('x'.repeat(4000), '', 120).length, 120);
});

test('provider failover uses each configured model role rather than guessing from output size', () => {
  const env = {
    GROQ_API_KEY: 'gsk_test-provider-key',
    GROQ_MODEL_REASONING: 'reasoner-model',
    GROQ_MODEL_CODING: 'coder-model',
    GROQ_MODEL_VALIDATION: 'validator-model',
    FALLBACK_KEY: 'custom-fallback-key-123456',
    AI_FALLBACK_PROVIDERS: JSON.stringify([{
      name: 'Fallback',
      baseUrl: 'https://api.example.test/v1',
      apiKeyEnv: 'FALLBACK_KEY',
      models: { reasoning: 'reasoner-fallback', coding: 'coder-fallback', validation: 'validator-fallback' }
    }])
  };
  const providers = configuredOpenAIProviders('reasoner-model', 1200, env, 'validation');
  assert.deepEqual(providers.map(provider => provider.model), ['validator-model', 'validator-fallback']);
});
