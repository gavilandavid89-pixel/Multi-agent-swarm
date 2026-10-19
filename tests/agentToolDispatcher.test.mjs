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
    execute: async args => { executed.push(args); return { jobId: runnerJobId, exitCode: 0, stdout: args.command.includes('--large-output') ? 'x'.repeat(15000) : args.command.includes('--secret-output') ? 'ghp_abcdefghijklmnopqrstuvwxyz1234567890' : 'ok' }; },
    check: async () => ({ ok: true }),
    jobStatus: async ({ jobId }) => ({ jobId, status: 'succeeded', apiKey: 'sensitive-value', clientSecret: 'client-secret-value', accessToken: 'access-token-value', privateKey: 'private-key-value', nested: { sessionToken: 'session-token-value', Cookie: 'session-cookie-value' } }),
    cancel: async ({ jobId }) => ({ jobId, cancelled: true }),
    artifact: async args => args,
    dependency: async args => ({ prepared: args.manifest })
  };
  return { files, executed, runnerJobId, dispatcher: createAgentToolDispatcher({ role, workspace, runner, jobId: 'task-1', maxCalls }) };
}

test('tool schemas use strict object arguments', () => {
  assert.ok(AGENT_TOOL_DEFINITIONS.length >= 8);
  assert.ok(AGENT_TOOL_DEFINITIONS.every(t => t.function.parameters.additionalProperties === false));
  const executeTool = AGENT_TOOL_DEFINITIONS.find(t => t.function.name === 'runner_execute');
  assert.equal(Object.hasOwn(executeTool.function.parameters.properties, 'network'), false);
  assert.equal(executeTool.function.parameters.properties.stdin.maxLength, 16384);
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
  assert.equal(f.executed[0].network, 'none');
});
test('tool outputs redact known credentials and sensitive object fields', async () => {
  const f = fixture();
  const response = await f.dispatcher.invoke({
    name: 'runner_execute',
    arguments: { command: ['node', '--secret-output'] }
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.stdout, '[REDACTED_CREDENTIAL]');
  await f.dispatcher.invoke({
    name: 'runner_execute',
    arguments: { command: ['node', '--version'] }
  });
  const status = await f.dispatcher.invoke({
    name: 'runner_job_status',
    arguments: { jobId: f.runnerJobId }
  });
  assert.equal(status.result.apiKey, '[REDACTED]');
  assert.equal(status.result.clientSecret, '[REDACTED]');
  assert.equal(status.result.accessToken, '[REDACTED]');
  assert.equal(status.result.privateKey, '[REDACTED]');
  assert.equal(status.result.nested.sessionToken, '[REDACTED]');
  assert.equal(status.result.nested.Cookie, '[REDACTED]');
});

test('workspace reads reject credential-bearing and oversized files', async () => {
  const f = fixture();
  f.files.set('src/secret.js', 'const key = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";');
  await assert.rejects(
    f.dispatcher.invoke({ name: 'workspace_read', arguments: { path: 'src/secret.js' } }),
    /posibles credenciales/
  );
  f.files.set('src/huge.txt', 'x'.repeat(256 * 1024 + 1));
  await assert.rejects(
    f.dispatcher.invoke({ name: 'workspace_read', arguments: { path: 'src/huge.txt' } }),
    /256 KiB/
  );
});

test('Python PDB accepts bounded stdin while other commands cannot receive stdin', async () => {
  const f = fixture();
  const commands = 'p 1 + 1\nq\n';
  await f.dispatcher.invoke({
    name: 'runner_execute',
    arguments: { command: ['python3', '-m', 'pdb', 'src/app.py'], stdin: commands }
  });
  assert.equal(f.executed[0].stdin, commands);
  assert.equal(f.executed[0].network, 'none');
  await assert.rejects(
    f.dispatcher.invoke({ name: 'runner_execute', arguments: { command: ['node', '--version'], stdin: 'q\n' } }),
    /solo se permite para sesiones por lotes de Python PDB/
  );
  await assert.rejects(
    f.dispatcher.invoke({ name: 'runner_execute', arguments: { command: ['python3', '-m', 'pdb', 'src/app.py'], stdin: 'x'.repeat(16 * 1024 + 1) } }),
    /16 KiB/
  );
});

test('oversized runner output is returned as a valid bounded result', async () => {
  const f = fixture();
  const response = await f.dispatcher.invoke({
    name: 'runner_execute',
    arguments: { command: ['node', '--large-output'] }
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.truncated, true);
  assert.equal(response.result.jobId, f.runnerJobId);
  assert.equal(response.result.exitCode, 0);
  assert.ok(response.result.serializedChars > 12000);
  assert.ok(response.result.preview.length < 12000);
  assert.match(response.result.preview, /large-output|stdout/);
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
  await assert.rejects(f.dispatcher.invoke({ name: 'runner_execute', arguments: { command: ['node', '--version'], network: 'restricted' } }), /política de red/);
  await assert.rejects(f.dispatcher.invoke({ name: 'runner_execute', arguments: { command: ['node; rm', '-rf', '/'] } }), /Binario/);
});
test('limits calls and per-file size', async () => {
  const f = fixture('desarrollador', 1);
  await f.dispatcher.invoke({ name: 'workspace_list', arguments: {} });
  await assert.rejects(f.dispatcher.invoke({ name: 'workspace_list', arguments: {} }), { code: 'AGENT_TOOL_CALL_LIMIT' });
  await assert.rejects(fixture().dispatcher.invoke({ name: 'workspace_write', arguments: { path: 'huge.txt', content: 'x'.repeat(256 * 1024 + 1) } }), /256 KiB/);
});


test('remote tool calls are checkpointed and completed results replay without another runner call', async () => {
  const f = fixture();
  const journal = [];
  const getInvocation = async query => journal.find(item =>
    item.name === query.name && item.argsHash === query.argsHash && item.role === query.role
    && item.round === query.round && item.workspaceHash === query.workspaceHash
  ) || null;
  const saveInvocation = async item => {
    const index = journal.findIndex(old => old.name === item.name && old.argsHash === item.argsHash
      && old.role === item.role && old.round === item.round && old.workspaceHash === item.workspaceHash);
    if (index >= 0) journal[index] = { ...journal[index], ...item };
    else journal.push(item);
  };
  const make = () => createAgentToolDispatcher({
    role: 'desarrollador', workspace: {
      list: async () => [...f.files].map(([path, content]) => ({ path, content })),
      read: async path => f.files.get(path) ?? null,
      write: async (path, content) => { f.files.set(path, content); return { path, bytes: content.length }; }
    }, runner: {
      execute: async args => { f.executed.push(args); return { jobId: f.runnerJobId, exitCode: 0, stdout: 'ok' }; },
      check: async () => ({ ok: true }), dependency: async () => ({ ok: true })
    }, jobId: 'stable-task', round: 1, getInvocation, saveInvocation
  });
  const first = await make().invoke({ name: 'runner_execute', arguments: { command: ['node', '--version'] } });
  assert.equal(first.result.stdout, 'ok');
  assert.equal(f.executed.length, 1);
  assert.match(f.executed[0].idempotencyKey, /^swarm-tool-/);
  assert.equal(journal[0].status, 'completed');
  const replay = await make().invoke({ name: 'runner_execute', arguments: { command: ['node', '--version'] } });
  assert.equal(replay.result.stdout, 'ok');
  assert.equal(replay.replayed, true);
  assert.equal(f.executed.length, 1);
});


test('infrastructure failures remain retryable and preserve the same idempotency key', async () => {
  const f = fixture();
  const journal = [];
  let attempts = 0;
  const getInvocation = async query => journal.find(item =>
    item.name === query.name && item.argsHash === query.argsHash && item.role === query.role
    && item.round === query.round && item.workspaceHash === query.workspaceHash
  ) || null;
  const saveInvocation = async item => {
    const index = journal.findIndex(old => old.name === item.name && old.argsHash === item.argsHash
      && old.role === item.role && old.round === item.round && old.workspaceHash === item.workspaceHash);
    if (index >= 0) journal[index] = { ...journal[index], ...item };
    else journal.push(item);
  };
  const dispatcher = createAgentToolDispatcher({
    role: 'desarrollador',
    workspace: {
      list: async () => [...f.files].map(([path, content]) => ({ path, content })),
      read: async path => f.files.get(path) ?? null,
      write: async (path, content) => { f.files.set(path, content); return { path, bytes: content.length }; }
    },
    runner: {
      execute: async args => {
        f.executed.push(args); attempts++;
        return attempts === 1
          ? { infraError: true, ok: false, message: 'runner unavailable' }
          : { infraError: false, ok: true, exitCode: 0, jobId: f.runnerJobId, stdout: 'ok' };
      }
    }, jobId: 'stable-task', round: 1, getInvocation, saveInvocation
  });
  const args = { name: 'runner_execute', arguments: { command: ['node', '--version'] } };
  await dispatcher.invoke(args);
  assert.equal(journal[0].status, 'started');
  await dispatcher.invoke(args);
  assert.equal(journal[0].status, 'completed');
  assert.equal(f.executed.length, 2);
  assert.equal(f.executed[0].idempotencyKey, f.executed[1].idempotencyKey);
});


test('a started invocation with a changed workspace gets a new idempotency key', async () => {
  const f = fixture();
  const journal = [];
  let attempts = 0;
  const getInvocation = async query => journal.find(item =>
    item.name === query.name && item.argsHash === query.argsHash && item.role === query.role
    && item.round === query.round && item.workspaceHash === query.workspaceHash
  ) || null;
  const saveInvocation = async item => {
    const index = journal.findIndex(old => old.name === item.name && old.argsHash === item.argsHash
      && old.role === item.role && old.round === item.round && old.workspaceHash === item.workspaceHash);
    if (index >= 0) journal[index] = { ...journal[index], ...item };
    else journal.push(item);
  };
  const dispatcher = createAgentToolDispatcher({
    role: 'desarrollador',
    workspace: {
      list: async () => [...f.files].map(([path, content]) => ({ path, content })),
      read: async path => f.files.get(path) ?? null,
      write: async (path, content) => { f.files.set(path, content); return { path, bytes: content.length }; }
    },
    runner: {
      execute: async args => {
        f.executed.push(args); attempts++;
        return attempts === 1
          ? { infraError: true, ok: false, message: 'runner unavailable' }
          : { infraError: false, ok: true, exitCode: 0, jobId: f.runnerJobId, stdout: 'ok' };
      }
    }, jobId: 'stable-task', round: 1, getInvocation, saveInvocation
  });
  const args = { name: 'runner_execute', arguments: { command: ['node', '--version'] } };
  await dispatcher.invoke(args);
  const firstKey = f.executed[0].idempotencyKey;
  f.files.set('src/app.js', 'workspace changed after failed call');
  await dispatcher.invoke(args);
  const secondKey = f.executed[1].idempotencyKey;
  assert.notEqual(firstKey, secondKey);
  assert.equal(journal.length, 2);
  assert.ok(journal.every(item => item.status === 'started' || item.status === 'completed'));
  assert.equal(journal.find(item => item.workspaceHash !== journal[0].workspaceHash)?.status, 'completed');
});
