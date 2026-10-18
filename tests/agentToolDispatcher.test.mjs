import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TOOL_DEFINITIONS, createAgentToolDispatcher } from '../apps/worker/services/agentToolDispatcher.js';

function fixture(role = 'desarrollador', maxCalls = 40) {
  const files = new Map([['src/app.js', 'hello']]);
  const executed = [];
  const runnerJobId = '123e4567-e89b-42d3-a456-426614174000';
  const workspace = {
    list: async () => [...files].map(([path, content]) => ({ path, content })),
    read: async path => files.get(path) ?? null,
    write: async (path, content) => { files.set(path, content); return { path, bytes: Buffer.byteLength(content) }; }
  };
  const runner = {
    execute: async args => { executed.push(args); return { jobId: runnerJobId, exitCode: 0, stdout: 'ok' }; },
    check: async () => ({ ok: true }),
    jobStatus: async ({ jobId }) => ({ jobId, status: 'succeeded' }),
    cancel: async ({ jobId }) => ({ jobId, cancelled: true }),
    artifact: async args => args,
    dependency: async args => ({ prepared: args.manifest })
  };
  return { files, executed, runnerJobId, dispatcher: createAgentToolDispatcher({ role, workspace, runner, jobId: 'task-1', maxCalls }) };
}

test('tool schemas use strict object arguments', () => {
  assert.ok(AGENT_TOOL_DEFINITIONS.length >= 8);
  assert.ok(AGENT_TOOL_DEFINITIONS.every(t => t.function.parameters.additionalProperties === false));
});
test('developer can read/write files and execute allowlisted binary without shell', async () => {
  const f = fixture();
  const listed = (await f.dispatcher.invoke({ name: 'workspace_list', arguments: {} })).result;
  assert.deepEqual(listed, [{ path: 'src/app.js', bytes: 5 }]);
  assert.equal(Object.hasOwn(listed[0], 'content'), false);
  assert.equal((await f.dispatcher.invoke({ name: 'workspace_read', arguments: { path: 'src/app.js' } })).result, 'hello');
  await f.dispatcher.invoke({ name: 'workspace_write', arguments: { path: 'src/app.js', content: 'updated' } });
  assert.equal(f.files.get('src/app.js'), 'updated');
  assert.equal((await f.dispatcher.invoke({ name: 'runner_execute', arguments: { command: ['node', '--version'] } })).result.exitCode, 0);
  assert.deepEqual(f.executed[0].command, ['node', '--version']);
});
test('effective role permissions deny writes and execution to validator/auditor', async () => {
  const validator = fixture('validador').dispatcher;
  await assert.rejects(validator.invoke({ name: 'workspace_write', arguments: { path: 'x.js', content: 'x' } }), { code: 'AGENT_TOOL_ROLE_DENIED' });
  await assert.rejects(validator.invoke({ name: 'runner_execute', arguments: { command: ['node', '--version'] } }), { code: 'AGENT_TOOL_ROLE_DENIED' });
  await assert.rejects(fixture('esceptico').dispatcher.invoke({ name: 'runner_check', arguments: {} }), { code: 'AGENT_TOOL_ROLE_DENIED' });
});
test('runner job tools cannot inspect, cancel, or read artifacts for an unowned job', async () => {
  const f = fixture();
  const foreignJobId = '123e4567-e89b-42d3-a456-426614174999';
  await assert.rejects(
    f.dispatcher.invoke({ name: 'runner_job_status', arguments: { jobId: foreignJobId } }),
    { code: 'AGENT_TOOL_JOB_NOT_OWNED' }
  );
  await assert.rejects(
    f.dispatcher.invoke({ name: 'runner_cancel', arguments: { jobId: foreignJobId } }),
    { code: 'AGENT_TOOL_JOB_NOT_OWNED' }
  );
  await assert.rejects(
    f.dispatcher.invoke({ name: 'runner_artifact', arguments: { jobId: foreignJobId, artifactId: 'src/app.js' } }),
    { code: 'AGENT_TOOL_JOB_NOT_OWNED' }
  );
  await f.dispatcher.invoke({ name: 'runner_execute', arguments: { command: ['node', '--version'] } });
  assert.equal((await f.dispatcher.invoke({ name: 'runner_job_status', arguments: { jobId: f.runnerJobId } })).result.status, 'succeeded');
  assert.equal((await f.dispatcher.invoke({ name: 'runner_cancel', arguments: { jobId: f.runnerJobId } })).result.cancelled, true);
  assert.equal((await f.dispatcher.invoke({ name: 'runner_artifact', arguments: { jobId: f.runnerJobId, artifactId: 'src/app.js' } })).result.jobId, f.runnerJobId);
});
test('rejects traversal, secret paths, credential content, and shell injection', async () => {
  const f = fixture();
  await assert.rejects(f.dispatcher.invoke({ name: 'workspace_read', arguments: { path: '../outside' } }), /Ruta/);
  await assert.rejects(f.dispatcher.invoke({ name: 'workspace_write', arguments: { path: '.env', content: 'x' } }), /sensible/);
  await assert.rejects(f.dispatcher.invoke({ name: 'workspace_write', arguments: { path: 'secret.txt', content: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890' } }), /credenciales/);
  await assert.rejects(f.dispatcher.invoke({ name: 'runner_execute', arguments: { command: ['bash', '-c', 'id'] } }), /Binario/);
  await assert.rejects(f.dispatcher.invoke({ name: 'runner_execute', arguments: { command: ['node; rm', '-rf', '/'] } }), /Binario/);
});
test('limits calls and per-file size', async () => {
  const f = fixture('desarrollador', 1);
  await f.dispatcher.invoke({ name: 'workspace_list', arguments: {} });
  await assert.rejects(f.dispatcher.invoke({ name: 'workspace_list', arguments: {} }), { code: 'AGENT_TOOL_CALL_LIMIT' });
  await assert.rejects(fixture().dispatcher.invoke({ name: 'workspace_write', arguments: { path: 'huge.txt', content: 'x'.repeat(256 * 1024 + 1) } }), /256 KiB/);
});
