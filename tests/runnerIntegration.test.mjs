import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const client = await readFile(new URL('../apps/worker/services/runnerClient.js', import.meta.url), 'utf8');
const engine = await readFile(new URL('../apps/worker/services/multiAiEngine.js', import.meta.url), 'utf8');
const checks = await readFile(new URL('../apps/worker/services/codeChecks.js', import.meta.url), 'utf8');
const render = await readFile(new URL('../render.yaml', import.meta.url), 'utf8');

test('Worker runner integration is optional by default and authenticates remote requests', () => {
  assert.ok(client.includes("process.env.AGENT_RUNNER_BASE_URL"));
  assert.ok(client.includes("process.env.AGENT_RUNNER_SHARED_SECRET"));
  assert.ok(client.includes("process.env.AGENT_RUNNER_REQUIRED === 'true'"));
  assert.ok(client.includes("'x-swarm-runner-secret': configuredSecret"));
  assert.ok(client.includes("'x-swarm-idempotency-key': key"));
  assert.ok(client.includes("network: 'none'"));
  assert.ok(client.includes("timeoutMs: 60000"));
  assert.ok(client.includes("timeoutMs + 90000"));
  assert.ok(client.includes("infraError: true"));
  assert.ok(client.includes("isPrivateRunnerHost"));
  assert.ok(client.includes("baseUrl.protocol === 'http:' && !isPrivateRunnerHost(baseUrl.hostname)"));
  assert.ok(render.includes('key: AGENT_RUNNER_REQUIRED\n        value: "false"'));
});

test('The Swarm validation/repair loop consumes real sandbox results', () => {
  assert.ok(checks.includes('export function extractFiles(delivery)'));
  assert.ok(engine.includes("import { runProjectToolchainChecks } from './runnerClient.js'"));
  assert.ok(engine.includes('runProjectToolchainChecks({ taskId: jobId, round, files: extractFiles(delivery) })'));
  assert.ok(engine.includes('ok: Boolean(syntax.ok && runnerExecution.ok)'));
  assert.ok(engine.includes('syntax?.runnerExecution?.infraError'));
  assert.ok(engine.includes("lastCheckpoint: 'runner-infra-error'"));
});
