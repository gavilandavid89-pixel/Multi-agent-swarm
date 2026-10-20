import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenAICompatibleResponse, normalizeProviderResponse, parseProviderResponseBody, validateGeminiResponse } from '../apps/worker/services/providerResponse.js';
test('parsea una respuesta válida de proveedor', () => {
  assert.deepEqual(parseProviderResponseBody('{"choices":[{"message":{"content":"ok"}}]}'), { choices: [{ message: { content: 'ok' } }] });
});
test('rechaza JSON truncado sin exponer el cuerpo original en el error', () => {
  assert.throws(() => parseProviderResponseBody('{"choices":[{"message":'), error => error.code === 'PROVIDER_INVALID_JSON' && !error.message.includes('choices'));
});
test('rechaza valores JSON que no son objetos', () => {
  assert.throws(() => parseProviderResponseBody('null'), error => error.code === 'PROVIDER_INVALID_JSON');
  assert.throws(() => parseProviderResponseBody('"texto"'), error => error.code === 'PROVIDER_INVALID_JSON');
});
test('normaliza contenido textual fragmentado en choices.message.content', () => {
  const result = normalizeOpenAICompatibleResponse({ choices: [{ message: { content: [{ type: 'text', text: 'Hola ' }, { type: 'text', text: 'mundo' }] }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
  assert.equal(result.choices[0].message.content, 'Hola mundo');
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.equal(result.usage.total_tokens, 5);
});
test('normaliza Responses API y contabiliza tokens de entrada/salida', () => {
  const result = normalizeOpenAICompatibleResponse({ output_text: 'respuesta final', usage: { input_tokens: 7, output_tokens: 4 } });
  assert.equal(result.choices[0].message.content, 'respuesta final');
  assert.equal(result.usage.prompt_tokens, 7);
  assert.equal(result.usage.completion_tokens, 4);
  assert.equal(result.usage.total_tokens, 11);
});
test('normaliza output[].content[] y alias comunes de salida', () => {
  assert.equal(normalizeOpenAICompatibleResponse({ output: [{ content: [{ type: 'output_text', text: 'A' }, { type: 'output_text', text: 'B' }] }] }).choices[0].message.content, 'AB');
  assert.equal(normalizeOpenAICompatibleResponse({ response: 'respuesta' }).choices[0].message.content, 'respuesta');
  assert.equal(normalizeOpenAICompatibleResponse({ result: 'resultado' }).choices[0].message.content, 'resultado');
});
test('rechaza formatos desconocidos en vez de pasarlos silenciosamente al agente', () => {
  assert.throws(() => normalizeOpenAICompatibleResponse({ data: { generated: { words: ['x'] } } }), error => error.code === 'PROVIDER_UNSUPPORTED_RESPONSE');
});
test('valida estructura Gemini y reconoce respuestas bloqueadas', () => {
  assert.deepEqual(validateGeminiResponse({ candidates: [] }), { candidates: [] });
  assert.deepEqual(validateGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }), { promptFeedback: { blockReason: 'SAFETY' } });
  assert.throws(() => validateGeminiResponse({ data: [] }), error => error.code === 'PROVIDER_UNSUPPORTED_RESPONSE');
});

test('traduce respuestas nativas de Anthropic al contrato canónico sin perder uso ni fin', () => {
  const result = normalizeProviderResponse({
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-test',
    content: [{ type: 'text', text: 'Hola desde Anthropic.' }],
    stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 7 }
  });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.status, 'success');
  assert.equal(result.provider, 'Anthropic');
  assert.equal(result.model, 'claude-test');
  assert.equal(result.content, 'Hola desde Anthropic.');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7, totalTokens: 19 });
});

test('normaliza respuesta Gemini al mismo contrato y marca bloqueos de seguridad', () => {
  const result = normalizeProviderResponse({
    candidates: [{ content: { parts: [{ text: 'Gemini listo' }] }, finishReason: 'MAX_TOKENS' }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 }
  });
  assert.equal(result.content, 'Gemini listo');
  assert.equal(result.finishReason, 'length');
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 6, totalTokens: 10 });
  const blocked = normalizeProviderResponse({ promptFeedback: { blockReason: 'SAFETY' } });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.finishReason, 'content_filter');
  assert.ok(blocked.warnings.includes('GEMINI_PROMPT_BLOCKED'));
});

test('preserva llamadas a herramientas en metadatos y no las confunde con texto', () => {
  const result = normalizeProviderResponse({
    choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }] }, finish_reason: 'tool_calls' }]
  });
  assert.equal(result.content, '');
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(result.toolCalls, [{ id: 'call-1', name: 'search', arguments: '{"q":"x"}' }]);
});

test('normaliza llamadas a herramientas nativas de Anthropic al formato común', () => {
  const native = normalizeProviderResponse({ type: 'message', role: 'assistant', model: 'claude-test', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool-1', name: 'workspace_list', input: {} }] });
  assert.equal(native.toolCalls[0].name, 'workspace_list');
  assert.deepEqual(native.toolCalls[0].input, {});
  const compatible = normalizeOpenAICompatibleResponse({ type: 'message', role: 'assistant', model: 'claude-test', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool-1', name: 'workspace_list', input: { path: 'src' } }] });
  assert.equal(compatible.choices[0].message.tool_calls[0].function.name, 'workspace_list');
  assert.deepEqual(JSON.parse(compatible.choices[0].message.tool_calls[0].function.arguments), { path: 'src' });
});
test('normaliza llamadas a funciones nativas de Gemini', () => {
  const result = normalizeProviderResponse({ candidates: [{ content: { parts: [{ functionCall: { name: 'workspace_read', args: { path: 'src/app.js' }, id: 'call-gemini' } }] }, finishReason: 'STOP' }] });
  assert.equal(result.toolCalls[0].name, 'workspace_read');
  assert.deepEqual(result.toolCalls[0].arguments, { path: 'src/app.js' });
});
test('adapta Responses API y conserva estado incompleto como truncamiento', () => {
  const result = normalizeProviderResponse({ output: [{ content: [{ type: 'output_text', text: 'parcial' }] }], status: 'incomplete', usage: { input_tokens: 2, output_tokens: 3 } });
  assert.equal(result.content, 'parcial');
  assert.equal(result.finishReason, 'length');
  assert.equal(result.usage.totalTokens, 5);
});


test('preserva la thought signature de Gemini al traducir llamadas a herramientas', () => {
  const signature = 'sig-gemini-roundtrip-test';
  const native = { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'agent_tasks_list', args: { status: 'open' }, id: 'call-1' }, thoughtSignature: signature }] }, finishReason: 'TOOL_CALLS' }] };
  const normalized = normalizeProviderResponse(native);
  assert.equal(normalized.toolCalls[0].thoughtSignature, signature);
  const compatible = normalizeOpenAICompatibleResponse(native);
  assert.equal(compatible.choices[0].message.tool_calls[0].thought_signature, signature);
});
