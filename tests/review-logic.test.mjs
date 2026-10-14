import test from 'node:test';
import assert from 'node:assert/strict';
import { parseValidationResponse, retryDelay } from '../apps/worker/services/aiProviders.js';
import { checkJavascriptSyntax } from '../apps/worker/services/codeChecks.js';

test('el validador acepta un resultado JSON con esquema válido', () => { const result = parseValidationResponse('{"verdict":"APPROVED","findings":[],"summary":"Revisado"}'); assert.equal(result.verdict, 'APPROVED'); assert.deepEqual(result.findings, []); assert.equal(result.summary, 'Revisado'); });
test('el validador falla de forma cerrada ante JSON inválido', () => { const result = parseValidationResponse('No puedo devolver JSON.'); assert.equal(result.verdict, 'NEEDS_CHANGES'); assert.ok(result.findings.length > 0); });
test('el validador falla de forma cerrada ante esquema incompleto', () => { const result = parseValidationResponse('{"verdict":"APPROVED","summary":"todo bien"}'); assert.equal(result.verdict, 'NEEDS_CHANGES'); });
test('la salida del validador limita el tamaño de los hallazgos', () => { const result = parseValidationResponse(JSON.stringify({ verdict: 'NEEDS_CHANGES', findings: ['x'.repeat(5000)], summary: 'y'.repeat(7000) })); assert.equal(result.findings[0].length, 2000); assert.equal(result.summary.length, 5000); });
test('el backoff de reintentos permanece acotado ante configuración inválida', () => { const previous = process.env.RETRY_BASE_MS; process.env.RETRY_BASE_MS = '-100'; const delay = retryDelay(99, null); assert.ok(delay >= 250 && delay <= 900000); if (previous === undefined) delete process.env.RETRY_BASE_MS; else process.env.RETRY_BASE_MS = previous; });
test('la comprobación detecta JavaScript válido sin ejecutarlo', async () => { const result = await checkJavascriptSyntax('```js\nconst answer = 42;\n```'); assert.equal(result.checked, true); assert.equal(result.ok, true); });
test('la comprobación detecta errores de sintaxis JavaScript', async () => { const result = await checkJavascriptSyntax('```javascript\nconst = ;\n```'); assert.equal(result.checked, true); assert.equal(result.ok, false); });
test('una entrega sin bloques JavaScript se etiqueta como revisión solo de IA', async () => { const result = await checkJavascriptSyntax('Una propuesta conceptual sin código.'); assert.equal(result.checked, false); assert.equal(result.ok, true); assert.match(result.message, /solo recibió revisión de IA/); });
test('el cliente de Groq procesa una respuesta exitosa sin usar credenciales reales', async () => { const { consultarModelo } = await import('../apps/worker/services/aiProviders.js'); const previousKey = process.env.GROQ_API_KEY; const previousFetch = globalThis.fetch; process.env.GROQ_API_KEY = 'test-key-not-real'; let request; globalThis.fetch = async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ choices: [{ message: { content: 'respuesta simulada' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); }; try { const result = await consultarModelo({ model: 'test-model', messages: [{ role: 'user', content: 'test' }] }); assert.equal(result, 'respuesta simulada'); assert.match(request.url, /api\.groq\.com\/openai\/v1\/chat\/completions$/); assert.equal(request.options.headers.authorization, 'Bearer test-key-not-real'); } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previousKey; } });
test('el cliente de Groq reintenta HTTP 429 y luego acepta el resultado', async () => { const { consultarModelo } = await import('../apps/worker/services/aiProviders.js'); const previousKey = process.env.GROQ_API_KEY; const previousFetch = globalThis.fetch; const previousBase = process.env.RETRY_BASE_MS; process.env.GROQ_API_KEY = 'test-key-not-real'; process.env.RETRY_BASE_MS = '250'; let calls = 0; const retries = []; globalThis.fetch = async () => { calls += 1; if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }); return new Response(JSON.stringify({ choices: [{ message: { content: 'recuperado' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); }; try { const result = await consultarModelo({ model: 'test-model', messages: [], onRetry: info => retries.push(info) }); assert.equal(result, 'recuperado'); assert.equal(calls, 2); assert.equal(retries.filter(info => !info.usage).length, 1); assert.match(retries[0].reason, /HTTP 429/); } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previousKey; if (previousBase === undefined) delete process.env.RETRY_BASE_MS; else process.env.RETRY_BASE_MS = previousBase; } });
test('el cliente de Groq no reintenta errores permanentes de autenticación', async () => { const { consultarModelo } = await import('../apps/worker/services/aiProviders.js'); const previousKey = process.env.GROQ_API_KEY; const previousFetch = globalThis.fetch; process.env.GROQ_API_KEY = 'test-key-not-real'; let calls = 0; globalThis.fetch = async () => { calls += 1; return new Response('unauthorized', { status: 401 }); }; try { await assert.rejects(consultarModelo({ model: 'test-model', messages: [] }), /Error permanente de Groq \(401/); assert.equal(calls, 1); } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previousKey; } });


test('el cliente continúa una respuesta cortada y registra cada llamada', async () => {
  const { consultarModelo } = await import('../apps/worker/services/aiProviders.js');
  const previousKey = process.env.GROQ_API_KEY; const previousFetch = globalThis.fetch;
  process.env.GROQ_API_KEY = 'test-key-not-real';
  const requests = []; let calls = 0; const usage = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body)); calls += 1;
    const content = calls === 1 ? 'parte 1' : ' parte 2';
    const finish_reason = calls === 1 ? 'length' : 'stop';
    return new Response(JSON.stringify({ choices: [{ finish_reason, message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await consultarModelo({ model: 'test-model', messages: [{ role: 'user', content: 'generá' }], continueOnLength: true, onRetry: info => { if (info.usage) usage.push(info); } });
    assert.equal(result, 'parte 1 parte 2');
    assert.equal(calls, 2);
    assert.equal(requests[1].messages.at(-2).role, 'assistant');
    assert.match(requests[1].messages.at(-1).content, /Continuá/);
    assert.equal(usage.length, 2);
  } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previousKey; }
});

test('el cliente de Groq amplía el límite y reintenta cuando JSON mode se corta por tokens', async () => {
  const { consultarModelo } = await import('../apps/worker/services/aiProviders.js');
  const previousKey = process.env.GROQ_API_KEY; const previousFetch = globalThis.fetch;
  const previousBudget = process.env.MAX_OUTPUT_TOKENS_PER_CALL;
  process.env.GROQ_API_KEY = 'test-key-not-real'; process.env.MAX_OUTPUT_TOKENS_PER_CALL = '6000';
  const requests = []; const retryEvents = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    if (requests.length === 1) return new Response(JSON.stringify({ error: { code: 'json_validate_failed', message: 'Failed to generate JSON', failed_generation: 'max completion tokens reached before generating a valid document' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"verdict":"APPROVED","findings":[],"summary":"Revisado"}' } }], usage: { prompt_tokens: 20, completion_tokens: 25, total_tokens: 45 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await consultarModelo({ model: 'test-model', messages: [{ role: 'user', content: 'auditá' }], maxTokens: 1000, responseFormat: { type: 'json_object' }, onRetry: info => retryEvents.push(info) });
    assert.match(result, /"verdict":"APPROVED"/);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].max_completion_tokens, 1000);
    assert.equal(requests[1].max_completion_tokens, 1750);
    assert.deepEqual(requests[1].response_format, { type: 'json_object' });
    assert.ok(retryEvents.some(info => /JSON incompleto/.test(info.reason || '')));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previousKey;
    if (previousBudget === undefined) delete process.env.MAX_OUTPUT_TOKENS_PER_CALL; else process.env.MAX_OUTPUT_TOKENS_PER_CALL = previousBudget;
  }
});




test('respeta el margen restante y no envía otra llamada si solo quedan unos pocos tokens', async () => {
  const { consultarModelo } = await import('../apps/worker/services/aiProviders.js');
  const previousKey = process.env.GROQ_API_KEY; const previousFetch = globalThis.fetch;
  process.env.GROQ_API_KEY = 'test-key-not-real';
  let request = null; let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++; request = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const onRetry = async () => {};
  onRetry.getMaxOutputTokens = async () => 500;
  try {
    await consultarModelo({ model: 'test-model', messages: [{ role: 'user', content: 'x' }], maxTokens: 6000, onRetry });
    assert.equal(request.max_completion_tokens, 500);
    assert.equal(calls, 1);
    const noHeadroom = async () => {};
    noHeadroom.getMaxOutputTokens = async () => 100;
    await assert.rejects(consultarModelo({ model: 'test-model', messages: [], maxTokens: 6000, onRetry: noHeadroom }), error => error.code === 'TASK_TOKEN_BUDGET');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previousKey; }
});
