import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredOpenAIProviders, consultarWithProviderContext } from '../apps/worker/services/aiProviders.js';

test('uses Groq first and then configured OpenAI-compatible APIs in order', () => {
  const env = {
    GROQ_API_KEY: 'groq-test-key',
    GROQ_MODEL_REASONING: 'groq-reasoner',
    FALLBACK_A_KEY: 'fallback-test-key',
    AI_FALLBACK_PROVIDERS: JSON.stringify([
      { name: 'Fallback A', baseUrl: 'https://api.example.test/v1/', apiKeyEnv: 'FALLBACK_A_KEY', models: { reasoning: 'reasoner-a', coding: 'coder-a' } },
      { name: 'No key', baseUrl: 'https://no-key.example.test/v1', apiKeyEnv: 'MISSING_KEY', model: 'unused' }
    ])
  };
  const providers = configuredOpenAIProviders('gemini-flash', 1200, env);
  assert.deepEqual(providers.map(provider => provider.name), ['Groq', 'Fallback A']);
  assert.equal(providers[0].model, 'groq-reasoner');
  assert.equal(providers[1].baseUrl, 'https://api.example.test/v1');
  assert.equal(providers[1].model, 'reasoner-a');
  assert.equal(providers[1].apiKey, 'fallback-test-key');
});

test('selects coding model for large output and ignores unsafe or duplicate endpoints', () => {
  const env = {
    GROQ_API_KEY: 'groq-test-key',
    GROQ_MODEL_CODING: 'groq-coder',
    FALLBACK_A_KEY: 'fallback-test-key',
    AI_FALLBACK_PROVIDERS: JSON.stringify([
      { name: 'Duplicate Groq', baseUrl: 'https://api.groq.com/openai/v1/', apiKeyEnv: 'FALLBACK_A_KEY', model: 'duplicate-model' },
      { name: 'Insecure remote', baseUrl: 'http://api.example.test/v1', apiKeyEnv: 'FALLBACK_A_KEY', model: 'unsafe-model' },
      { name: 'Fallback A', baseUrl: 'https://api.example.test/v1', apiKeyEnv: 'FALLBACK_A_KEY', models: { coding: 'coder-a' } }
    ])
  };
  const providers = configuredOpenAIProviders('gemini-flash', 6000, env);
  assert.deepEqual(providers.map(provider => provider.name), ['Groq', 'Fallback A']);
  assert.equal(providers[0].model, 'groq-coder');
  assert.equal(providers[1].model, 'coder-a');
});

test('ignores malformed provider configuration without exposing API keys', () => {
  const env = {
    FALLBACK_A_KEY: 'secret-must-not-appear',
    AI_FALLBACK_PROVIDERS: JSON.stringify([
      { name: 'Missing model', baseUrl: 'https://api.example.test/v1', apiKeyEnv: 'FALLBACK_A_KEY' },
      { name: 'Invalid key env', baseUrl: 'https://api2.example.test/v1', apiKeyEnv: 'bad-key-name', model: 'x' }
    ])
  };
  const providers = configuredOpenAIProviders('gemini-flash', 1200, env);
  assert.deepEqual(providers, []);
  assert.equal(JSON.stringify(providers).includes('secret-must-not-appear'), false);
});


test('falls through every configured Gemini key in order before giving up', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    calls.push(target);
    if (target.includes('key=gemini-key-1')) {
      return new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
        status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' }
      });
    }
    if (target.includes('key=gemini-key-2')) {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'respuesta de la segunda clave' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 8 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('Unexpected provider endpoint in test.');
  };
  try {
    const geminiModels = { reasoning: 'gemini-3.8-flash', coding: 'gemini-3.8-flash', validation: 'gemini-3.8-flash' };
    const result = await consultarWithProviderContext({
      model: 'gemini-3.8-flash', maxTokens: 1200,
      messages: [{ role: 'user', content: 'test failover' }]
    }, {
      providers: [],
      gemini: { name: 'Gemini A', apiKey: 'gemini-key-1', models: geminiModels },
      geminiProviders: [
        { name: 'Gemini A', apiKey: 'gemini-key-1', models: geminiModels },
        { name: 'Gemini B', apiKey: 'gemini-key-2', models: geminiModels }
      ]
    }, {});
    assert.equal(result, 'respuesta de la segunda clave');
    assert.equal(calls.length, 2);
    assert.match(calls[0], /key=gemini-key-1/);
    assert.match(calls[1], /key=gemini-key-2/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
