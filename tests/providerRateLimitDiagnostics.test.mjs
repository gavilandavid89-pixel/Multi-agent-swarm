import test from 'node:test';
import assert from 'node:assert/strict';
import { logProviderRateLimitDiagnostic } from '../apps/worker/services/providerRateLimitDiagnostics.js';

test('diagnoses token-per-minute 429 without logging prompt or raw body', () => {
  const previousWarn = console.warn;
  let output = '';
  console.warn = (...args) => { output = args.join(' '); };
  try {
    logProviderRateLimitDiagnostic({
      provider: 'Groq',
      model: 'test-model',
      status: 429,
      response: { headers: new Headers({
        'retry-after': '17',
        'x-ratelimit-limit-tokens': '12000',
        'x-ratelimit-remaining-tokens': '0',
        'x-ratelimit-reset-tokens': '2s'
      }) },
      bodyText: JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Limit 12000 TPM, Requested 14000 tokens. retry in 17s' } }),
      messages: [{ role: 'user', content: 'PRIVATE_PROMPT_SHOULD_NEVER_APPEAR' }],
      maxTokens: 2000
    });
  } finally { console.warn = previousWarn; }
  assert.match(output, /provider_rate_limit_diagnostic/);
  assert.match(output, /tokens_per_minute/);
  assert.match(output, /x-ratelimit-remaining-tokens/);
  assert.match(output, /estimatedInputTokens/);
  assert.doesNotMatch(output, /PRIVATE_PROMPT_SHOULD_NEVER_APPEAR/);
  assert.doesNotMatch(output, /Requested 14000 tokens/);
});

test('distinguishes request-per-minute limits', () => {
  const previousWarn = console.warn;
  let output = '';
  console.warn = (...args) => { output = args.join(' '); };
  try {
    logProviderRateLimitDiagnostic({
      provider: 'Provider',
      model: 'test-model',
      status: 429,
      response: { headers: new Headers() },
      bodyText: JSON.stringify({ error: { message: 'Rate limit reached: 30 requests per minute' } }),
      messages: [],
      maxTokens: 256
    });
  } finally { console.warn = previousWarn; }
  assert.match(output, /requests_per_minute/);
});
