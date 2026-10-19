import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeAgentToolResult } from '../apps/worker/services/agentToolResult.js';

test('tool result serialization preserves ordinary JSON results', () => {
  const result = { ok: true, result: { jobId: 'job-1', exitCode: 0, stdout: 'ok' } };
  assert.deepEqual(JSON.parse(serializeAgentToolResult(result)), result);
});

test('oversized escaped output is summarized without cutting JSON', () => {
  const result = { ok: true, result: { stdout: '\\\\n'.repeat(12000) } };
  const serialized = serializeAgentToolResult(result);
  assert.ok(serialized.length <= 16000);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.serializedChars > 16000);
  assert.ok(parsed.preview.length > 0);
});

test('non-serializable tool results return valid fallback JSON', () => {
  const result = {};
  result.self = result;
  const serialized = serializeAgentToolResult(result);
  assert.deepEqual(JSON.parse(serialized), { ok: false, error: 'Resultado no serializable.' });
});
