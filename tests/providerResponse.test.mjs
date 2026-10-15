import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenAICompatibleResponse, parseProviderResponseBody, validateGeminiResponse } from '../apps/worker/services/providerResponse.js';
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
