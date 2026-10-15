import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function launch(script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.logs = '';
  const record = chunk => { child.logs = (child.logs + chunk.toString()).slice(-10000); };
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  return child;
}

async function waitUntilReady(child, url, name) {
  const deadline = Date.now() + 20000;
  let lastProblem = 'todavía no respondió';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${name} terminó antes de estar listo. Salida: ${child.logs}`);
    }
    try {
      const response = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return await response.json();
      lastProblem = `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`;
    } catch (error) {
      lastProblem = error?.message || String(error);
    }
    await pause(200);
  }
  throw new Error(`${name} no estuvo listo en 20 segundos (${lastProblem}). Logs: ${child.logs}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

test('bridge y worker inician por HTTP y verifican PostgreSQL en /readyz', { timeout: 40000 }, async t => {
  const databaseUrl = process.env.SWARM_DATABASE_URL;
  assert.ok(databaseUrl, 'CI debe proporcionar PostgreSQL temporal');
  const bridgePort = await reservePort();
  const workerPort = await reservePort();
  const sharedSecret = 'swarm-http-smoke-secret-1234567890';
  const workerUrl = `http://127.0.0.1:${workerPort}`;
  const commonEnv = {
    NODE_ENV: 'test',
    SWARM_DATABASE_URL: databaseUrl,
    SWARM_API_ENCRYPTION_KEY: process.env.SWARM_API_ENCRYPTION_KEY || '0'.repeat(64),
    DATABASE_URL: databaseUrl,
    HISTORY_ENCRYPTION_KEY: 'a'.repeat(64),
    WORKER_SHARED_SECRET: sharedSecret
  };
  const worker = launch('apps/worker/server.js', {
    ...commonEnv,
    PORT: String(workerPort),
    DATABASE_PATH: './data/swarm-smoke-does-not-exist.sqlite',
    WORKER_CONCURRENCY: '1'
  });
  const bridge = launch('apps/bridge/server.js', {
    ...commonEnv,
    PORT: String(bridgePort),
    WORKER_BASE_URL: workerUrl,
    APP_ACCESS_KEY: 'swarm-http-smoke-bootstrap-key-123456'
  });
  t.after(async () => {
    await stopChild(bridge);
    await stopChild(worker);
  });

  const workerReady = await waitUntilReady(worker, workerUrl, 'Worker');
  assert.equal(workerReady.ok, true);
  assert.equal(workerReady.role, 'worker');
  assert.equal(workerReady.database, 'ready');

  const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
  const bridgeReady = await waitUntilReady(bridge, bridgeUrl, 'Bridge');
  assert.equal(bridgeReady.ok, true);
  assert.equal(bridgeReady.role, 'bridge');
  assert.equal(bridgeReady.database, 'ready');
  assert.equal(bridgeReady.workerConfigured, true);

  for (const [url, role] of [[bridgeUrl, 'bridge'], [workerUrl, 'worker']]) {
    const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.role, role);
  }
});
