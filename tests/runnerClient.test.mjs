import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { deriveAgentWorkspaceId } from '../apps/worker/services/agentWorkspace.js';

const moduleUrl = new URL('../apps/worker/services/runnerClient.js', import.meta.url).href;

test('Worker client authenticates, sends idempotency, polls asynchronously, and parses toolchain results', async t => {
  const seen = [];
  const pollSecrets = [];
  let readyAttempts = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/readyz' && req.method === 'GET') {
      pollSecrets.push(req.headers['x-swarm-runner-secret']);
      readyAttempts += 1;
      if (readyAttempts < 3) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, starting: true }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, docker: 'ready', image: 'ready' }));
      }
      return;
    }
    if (req.url === '/v1/capabilities' && req.method === 'GET') {
      pollSecrets.push(req.headers['x-swarm-runner-secret']);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        schemaVersion: 1,
        execution: { defaultNetwork: 'none', concurrency: 1 },
        output: { streams: ['stdout', 'stderr'], maxRetainedCharsPerStream: 65536 },
        debugging: { stdin: { maxBytes: 16384 }, debuggers: [{ id: 'python-pdb' }] },
        workspaceIsolation: { status: 'worker-primitives-implemented; model-tool-dispatch-pending', concurrency: { globalRunner: 1 }, merge: 'conflicts fail closed' },
        toolchains: [{ id: 'typescript', commands: ['tsc', 'tsx'] }]
      }));
      return;
    }
    if (req.url === '/v1/jobs' && req.method === 'POST') {
      seen.push({ method: req.method, secret: req.headers['x-swarm-runner-secret'], key: req.headers['x-swarm-idempotency-key'], body: JSON.parse(raw) });
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', status: 'queued' }));
      return;
    }
    if (req.url === '/v1/jobs/11111111-1111-4111-8111-111111111111' && req.method === 'GET') {
      pollSecrets.push(req.headers['x-swarm-runner-secret']);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', status: 'succeeded', exitCode: 0, timedOut: false, stdout: 'SWARM_RUNNER_CHECKED=2\\nrunner-ok', stderr: '', durationMs: 15 }));
      return;
    }
    if (req.url === '/v1/jobs/11111111-1111-4111-8111-111111111111/files' && req.method === 'GET') {
      pollSecrets.push(req.headers['x-swarm-runner-secret']);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ files: [{ path: 'generated.txt', content: 'artifact-ok' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  process.env.AGENT_RUNNER_BASE_URL = 'http://127.0.0.1:' + server.address().port;
  process.env.AGENT_RUNNER_SHARED_SECRET = 'test-runner-secret-that-is-long-enough-32';
  process.env.AGENT_RUNNER_REQUIRED = 'false';
  const { getAgentRunnerCapabilities, runAgentCommand, runProjectToolchainChecks } = await import('../apps/worker/services/runnerClient.js?test=' + randomUUID());

  const job = await runAgentCommand({
    taskId: '22222222-2222-4222-8222-222222222222',
    files: [{ path: 'main.js', content: 'console.log(1)' }],
    command: ['node', 'main.js'],
    idempotencyKey: 'worker-client-test-key-0001',
    timeoutMs: 5000,
    includeArtifacts: true
  });
  assert.equal(job.ok, true);
  assert.equal(readyAttempts, 3, 'Worker should retry transient readiness responses');
  assert.equal(job.checked, true);
  assert.equal(job.exitCode, 0);
  assert.equal(seen[0].secret, 'test-runner-secret-that-is-long-enough-32');
  assert.ok(pollSecrets.length > 0);
  assert.ok(pollSecrets.every(secret => secret === 'test-runner-secret-that-is-long-enough-32'));
  assert.deepEqual(job.artifacts, [{ path: 'generated.txt', content: 'artifact-ok' }]);
  assert.equal(seen[0].key, 'worker-client-test-key-0001');
  assert.equal(seen[0].body.network, 'none');
  assert.equal(seen[0].body.workspaceId, '22222222-2222-4222-8222-222222222222');
  assert.equal(seen[0].body.resetWorkspace, true);

  const catalog = await getAgentRunnerCapabilities();
  assert.equal(catalog.ok, true);
  assert.equal(catalog.capabilities.execution.defaultNetwork, 'none');
  assert.equal(catalog.capabilities.toolchains[0].id, 'typescript');
  assert.deepEqual(catalog.capabilities.output.streams, ['stdout', 'stderr']);
  assert.equal(catalog.capabilities.debugging.debuggers[0].id, 'python-pdb');
  assert.equal(catalog.capabilities.workspaceIsolation.concurrency.globalRunner, 1);
  assert.ok(pollSecrets.every(secret => secret === 'test-runner-secret-that-is-long-enough-32'));

  const checks = await runProjectToolchainChecks({
    taskId: '33333333-3333-4333-8333-333333333333',
    round: 1,
    files: new Map([
      ['main.js', { content: 'console.log(1)' }],
      ['package.json', { content: '{"scripts":{"test":"node --test"}}' }],
      ['package-lock.json', { content: '{"lockfileVersion":3,"packages":{}}' }]
    ])
  });
  assert.equal(checks.ok, true);
  assert.equal(checks.filesChecked, 2);
  assert.equal(checks.runtimeChecks.length, 2);
  assert.equal(seen[1].body.command[0], 'bash');
  assert.match(seen[1].key, /:validation:1:[a-f0-9]{16}$/i, 'validation idempotency keys should include a source-content fingerprint');
  assert.equal(seen[1].body.network, 'none');
  assert.equal(seen[1].body.workspaceId, deriveAgentWorkspaceId('33333333-3333-4333-8333-333333333333', 'validador', 'round-1'));
  assert.notEqual(seen[1].body.workspaceId, '33333333-3333-4333-8333-333333333333', 'validation must not share the task/agent integration workspace');
  assert.equal(seen[2].body.workspaceId, seen[1].body.workspaceId, 'dependency preparation and tests must reuse the same isolated validation workspace');
  assert.equal(seen[2].body.command[0], 'npm');
  assert.equal(seen[2].body.command[1], 'ci');
  assert.equal(seen[2].body.network, 'restricted');
  assert.equal(seen[2].body.resetWorkspace, false);
  assert.equal(seen[3].body.command[1], 'test');
  assert.equal(seen[3].body.network, 'none');
  assert.equal(seen[3].body.resetWorkspace, false);
  // A changed delivery must not collide with a previous round's idempotency key.
  const requestsBeforeSecret = seen.length;
  const blocked = await runProjectToolchainChecks({
    taskId: '44444444-4444-4444-8444-444444444444',
    round: 1,
    files: new Map([['id_rsa', { content: '-----BEGIN OPENSSH PRIVATE KEY-----\\nnot-a-real-key\\n-----END OPENSSH PRIVATE KEY-----' }]])
  });
  assert.equal(blocked.infraError, true);
  assert.match(blocked.message, /no se envió ningún archivo/i);
  assert.equal(seen.length, requestsBeforeSecret);

  const debugInput = 'p 6 * 7\nq\n';
  const debugJob = await runAgentCommand({
    taskId: '66666666-6666-4666-8666-666666666666',
    files: [{ path: 'debug.py', content: 'print("debug target")' }],
    command: ['python3', '-m', 'pdb', 'debug.py'],
    stdin: debugInput,
    network: 'none',
    idempotencyKey: 'worker-client-debug-input-0001',
    timeoutMs: 5000
  });
  assert.equal(debugJob.ok, true);
  assert.equal(seen.at(-1).body.stdin, debugInput);
  const requestsBeforeRejectedInput = seen.length;
  const unsafeDebug = await runAgentCommand({
    taskId: '77777777-7777-4777-8777-777777777777',
    files: [],
    command: ['python3', '-m', 'pdb'],
    stdin: debugInput,
    network: 'restricted'
  });
  assert.equal(unsafeDebug.ok, false);
  assert.match(unsafeDebug.message, /network none/i);
  assert.equal(seen.length, requestsBeforeRejectedInput, 'unsafe debugger input must be rejected before contacting the runner');
});

test('Worker refuses public HTTP runner endpoints and skips optional unconfigured runner', () => {
  const publicHttp = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await m.runAgentCommand({files:[],command:['true']})))`],
  { encoding: 'utf8', env: { PATH: process.env.PATH || '', AGENT_RUNNER_BASE_URL: 'http://example.com', AGENT_RUNNER_SHARED_SECRET: 'test-runner-secret-that-is-long-enough-32' } });
  assert.equal(publicHttp.status, 0, publicHttp.stderr);
  const rejected = JSON.parse(publicHttp.stdout.trim());
  assert.equal(rejected.ok, false);
  assert.equal(rejected.infraError, true);
  assert.match(rejected.message, /HTTPS/);

  for (const host of ['169.254.169.254', '100.100.100.200', '192.0.2.1', '224.0.0.1', '[fe80::1]', '[::ffff:169.254.169.254]']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const m=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await m.runAgentCommand({files:[],command:['true']})))`],
    { encoding: 'utf8', env: { PATH: process.env.PATH || '', AGENT_RUNNER_BASE_URL: 'http://' + host, AGENT_RUNNER_SHARED_SECRET: 'test-runner-secret-that-is-long-enough-32' } });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.ok, false, host + ' must not be accepted as a plaintext runner host');
    assert.match(output.message, /HTTPS/);
  }

  const optional = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await m.runAgentCommand({files:[],command:['true']})))`],
  { encoding: 'utf8', env: { PATH: process.env.PATH || '', AGENT_RUNNER_REQUIRED: 'false' } });
  assert.equal(optional.status, 0, optional.stderr);
  const skipped = JSON.parse(optional.stdout.trim());
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.ok, true);
});
