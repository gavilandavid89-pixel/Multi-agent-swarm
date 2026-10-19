import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const client = await readFile(new URL('../apps/worker/services/runnerClient.js', import.meta.url), 'utf8');
const engine = await readFile(new URL('../apps/worker/services/multiAiEngine.js', import.meta.url), 'utf8');
const checks = await readFile(new URL('../apps/worker/services/codeChecks.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../apps/worker/server.js', import.meta.url), 'utf8');
const sandboxSmoke = await readFile(new URL('../scripts/agent-sandbox-smoke.sh', import.meta.url), 'utf8');

test('Worker runner integration is optional by default and authenticates remote requests', () => {
  assert.ok(client.includes("process.env.AGENT_RUNNER_BASE_URL"));
  assert.ok(client.includes("name: 'Chromium/Xvfb browser smoke'"));
  assert.ok(client.includes("name: 'Godot headless import and startup'"));
  assert.ok(client.includes('Missing modules/imports are usually actionable project failures'));
  assert.ok(!client.includes('infraError: Boolean(tested.infraError || missingDependency'));
  assert.ok(client.includes('/opt/swarm-runner/godot-smoke.sh'));
  assert.ok(client.includes("'/opt/swarm-runner/browser-smoke.mjs'"));
  assert.ok(client.includes("process.env.AGENT_RUNNER_SHARED_SECRET"));
  assert.ok(client.includes("process.env.AGENT_RUNNER_REQUIRED === 'true'"));
  assert.ok(client.includes("'x-swarm-runner-secret': configuredSecret"));
  assert.ok(client.includes('containsSensitivePath(files)'));
  assert.ok(client.includes('containsSensitiveCredential(files)'));
  assert.ok(client.includes('no se envió ningún archivo al runner'));
  assert.ok(client.includes("redirect: 'error'"));
  assert.ok(client.includes("async function waitForRunnerReady(maxWaitMs = 150000)"));
  assert.ok(client.includes("await waitForRunnerReady()"));
  assert.ok(client.includes("'x-swarm-idempotency-key': key"));
  assert.ok(client.includes("network: 'none'"));
  assert.ok(client.includes("timeoutMs: 60000"));
  assert.ok(client.includes("Number(timeoutMs) + 90000"));
  assert.ok(client.includes("infraError: true"));
  assert.ok(client.includes('infraError: Boolean(latest.error || latest.exitCode === 125)'));
  assert.ok(client.includes('retryableTerminalInfrastructureFailure: Boolean(latest.error || latest.exitCode === 125)'));
  assert.ok(client.includes("isPrivateRunnerHost"));
  assert.ok(client.includes("baseUrl.protocol === 'http:' && !isPrivateRunnerHost(baseUrl.hostname)"));
  assert.ok(client.includes('baseUrl.username || baseUrl.password'));
  assert.ok(client.includes('sin rutas, query, fragmentos ni credenciales embebidas'));
});

test('The Swarm validation/repair loop consumes real sandbox results', () => {
  assert.ok(checks.includes('export function extractFiles(delivery)'));
  assert.ok(engine.includes('runProjectToolchainChecks') && engine.includes('runAgentCommand') && engine.includes("from './runnerClient.js'"));
  assert.ok(engine.includes('runProjectToolchainChecks({ taskId: jobId, round, files: await readFiles() })'));
  assert.ok(engine.includes('mergeAgentWorkspaceChanges'));
  assert.ok(engine.includes("lastCheckpoint: 'workspace-merge-conflict'"));
  assert.ok(engine.includes("createAgentToolContext(jobId, round, 'validador', delivery)"));
  assert.ok(engine.includes('ok: Boolean(syntax.ok && runnerExecution.ok)'));
  assert.ok(engine.includes("runnerExecution.skipped ? 'NO EJECUTADO' : 'NO DISPONIBLE'"));
  assert.ok(engine.includes("item.phase === 'tests'"));
  assert.ok(engine.includes("'SOLO ESTÁTICO'"));
  assert.ok(engine.includes("'Runner aislado (' + executionStatus + '): '"));
  assert.ok(engine.includes("'ai_syntax_and_runtime'"));
  assert.ok(engine.includes("executionStatus: syntax.executionStatus || 'NO EJECUTADO'"));
  assert.ok(engine.includes('pruebas de proyecto no confirmadas'));
  assert.ok(engine.includes('syntax?.runnerExecution?.infraError'));
  assert.ok(engine.includes("lastCheckpoint: 'runner-infra-error'"));
  assert.ok(engine.includes("payload.resumeMode === 'runner-only'"));
  assert.ok(engine.includes("lastCheckpoint: runnerExecution.infraError ? 'runner-infra-error' : 'runner-recheck'"));
  assert.ok(engine.includes('retryFailedStep, retryAttempt'));
  assert.ok(client.includes('retryFailedStep = null, retryAttempt = 0'));
  assert.ok(client.includes("retry-' + String(Math.trunc(Number(retryAttempt)))"));
  assert.ok(server.includes('runnerRetryCount: Math.max(0, Number(record.payload.runnerRetryCount) || 0) + 1'));
  assert.ok(server.includes('getRetryRecoveryMode(record.payload)'));
  assert.ok(server.includes("resumeMode: 'runner-only'"));
  assert.ok(server.includes('Reintento acotado: se conserva la entrega y la validación de IA ya guardadas'));
});

test('journal checkpoint identity includes workspace hash when updating a started invocation', () => {
  const pendingIndexBlock = engine.slice(engine.indexOf('const pendingIndex ='), engine.indexOf('const identityIndex ='));
  assert.ok(pendingIndexBlock.includes('item?.workspaceHash === invocation.workspaceHash'));
});

test('runner restart smoke reads the container id from the persisted jobs directory', () => {
  assert.ok(sandboxSmoke.includes('restart_cid_file="${workspace}-runner-state/jobs/${restart_id}.cid"'));
});
