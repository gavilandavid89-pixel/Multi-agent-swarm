import test from 'node:test';
import assert from 'node:assert/strict';
import { consultarWithProviderContext } from '../apps/worker/services/aiProviders.js';

function jsonResponse(payload) {
  return { ok: true, status: 200, text: async () => JSON.stringify(payload), headers: { get: () => null } };
}
function openAIReply(toolCalls) {
  return { choices: [{ message: { content: '', tool_calls: toolCalls }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
}

test('OpenAI-compatible provider executes a tool call and resumes the same conversation', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let call = 0;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    call++;
    if (call === 1) return jsonResponse(openAIReply([{ id: 'call-1', type: 'function', function: { name: 'workspace_list', arguments: '{}' } }]));
    return jsonResponse({ choices: [{ message: { content: 'Archivos revisados.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } });
  };
  try {
    const toolResults = [];
    const env = { NODE_ENV: 'test', TEST_PROVIDER_KEY: 'test-secret', AI_FALLBACK_PROVIDERS: JSON.stringify([{ name: 'Fixture', baseUrl: 'https://fixture.test/v1', apiKeyEnv: 'TEST_PROVIDER_KEY', model: 'fixture-model' }]) };
    const result = await consultarWithProviderContext({
      model: 'fixture-model', maxTokens: 500, messages: [{ role: 'user', content: 'Revisá el workspace' }],
      tools: [{ type: 'function', function: { name: 'workspace_list', description: 'list', parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
      onToolCall: async input => { toolResults.push(input); return { ok: true, result: [{ path: 'src/app.js' }] }; }
    }, null, env);
    assert.equal(result, 'Archivos revisados.');
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].name, 'workspace_list');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.tools[0].function.name, 'workspace_list');
    assert.equal(requests[1].body.messages.at(-1).role, 'tool');
    assert.match(requests[1].body.messages.at(-1).content, /src\/app.js/);
  } finally { globalThis.fetch = originalFetch; }
});

test('Anthropic native tool_use is converted, dispatched, and returned as tool_result', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let call = 0;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    call++;
    if (call === 1) return jsonResponse({ id: 'msg-1', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool-1', name: 'workspace_list', input: {} }], usage: { input_tokens: 3, output_tokens: 2 } });
    return jsonResponse({ id: 'msg-2', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Listo.' }], usage: { input_tokens: 5, output_tokens: 2 } });
  };
  try {
    let calls = 0;
    const env = { NODE_ENV: 'test', TEST_ANTHROPIC_KEY: 'test-secret', AI_FALLBACK_PROVIDERS: JSON.stringify([{ name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'TEST_ANTHROPIC_KEY', model: 'claude-test' }]) };
    const result = await consultarWithProviderContext({
      model: 'claude-test', maxTokens: 500, messages: [{ role: 'user', content: 'Listá archivos' }],
      tools: [{ type: 'function', function: { name: 'workspace_list', description: 'list', parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
      onToolCall: async input => { calls++; assert.equal(input.name, 'workspace_list'); return { ok: true, result: [{ path: 'README.md' }] }; }
    }, null, env);
    assert.equal(result, 'Listo.');
    assert.equal(calls, 1);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.tools[0].name, 'workspace_list');
    assert.equal(requests[1].body.messages.at(-1).content[0].type, 'tool_result');
    assert.match(requests[1].body.messages.at(-1).content[0].content, /README.md/);
  } finally { globalThis.fetch = originalFetch; }
});
