import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const moduleUrl = new URL('../apps/worker/services/runnerClient.js', import.meta.url).href;

test('Worker client authenticates, sends idempotency, polls asynchronously, and parses toolchain results', async t => {
  const seen = [];
  const pollSecrets = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
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
  const { runAgentCommand, runProjectToolchainChecks } = await import('../apps/worker/services/runnerClient.js?test=' + randomUUID());

  const job = await runAgentCommand({
    taskId: '22222222-2222-4222-8222-222222222222',
    files: [{ path: 'main.js', content: 'console.log(1)' }],
    command: ['node', 'main.js'],
    idempotencyKey: 'worker-client-test-key-0001',
    timeoutMs: 5000,
    includeArtifacts: true
  });
  assert.equal(job.ok, true);
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
  assert.equal(seen[1].body.network, 'none');
  assert.equal(seen[2].body.command[0], 'npm');
  assert.equal(seen[2].body.command[1], 'ci');
  assert.equal(seen[2].body.network, 'restricted');
  assert.equal(seen[2].body.resetWorkspace, false);
  assert.equal(seen[3].body.command[1], 'test');
  assert.equal(seen[3].body.network, 'none');
  assert.equal(seen[3].body.resetWorkspace, false);
  const requestsBeforeSecret = seen.length;
  const blocked = await runProjectToolchainChecks({
    taskId: '44444444-4444-4444-8444-444444444444',
    round: 1,
    files: new Map([['id_rsa', { content: '-----BEGIN OPENSSH PRIVATE KEY-----\\nnot-a-real-key\\n-----END OPENSSH PRIVATE KEY-----' }]])
  });
  assert.equal(blocked.infraError, true);
  assert.match(blocked.message, /no se envió ningún archivo/i);
  assert.equal(seen.length, requestsBeforeSecret);
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

  const optional = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await m.runAgentCommand({files:[],command:['true']})))`],
  { encoding: 'utf8', env: { PATH: process.env.PATH || '', AGENT_RUNNER_REQUIRED: 'false' } });
  assert.equal(optional.status, 0, optional.stderr);
  const skipped = JSON.parse(optional.stdout.trim());
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.ok, true);
});
