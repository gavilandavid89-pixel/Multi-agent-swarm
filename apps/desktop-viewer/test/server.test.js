import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = path.resolve(import.meta.dirname, '..');
const serverPath = path.join(repoRoot, 'server.js');
const username = 'swarm-admin-test';
const password = 'test-password-that-is-longer-than-24-chars';
let child;
let port;
let stubDir;

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  await new Promise(resolve => server.close(resolve));
  return address.port;
}

async function waitForServer(url, processRef) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (processRef.exitCode !== null) throw new Error(`viewer exited with code ${processRef.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(300) });
      if (response.status) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('viewer server did not become ready in time');
}

test('viewer HTTP access requires the configured administrator credentials', async t => {
  stubDir = await mkdtemp(path.join(tmpdir(), 'swarm-viewer-stubs-'));
  for (const command of ['Xvfb', 'x11vnc', 'websockify', 'chromium']) {
    const file = path.join(stubDir, command);
    await writeFile(file, '#!/bin/sh\nexec /bin/sleep 60\n');
    await chmod(file, 0o755);
  }
  port = await freePort();
  child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH || ''}`,
      PORT: String(port),
      VIEWER_ADMIN_USERNAME: username,
      VIEWER_ADMIN_PASSWORD: password,
      DISPLAY: ':198'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  await waitForServer(`http://127.0.0.1:${port}/healthz`, child).catch(error => {
    throw new Error(`${error.message}; stderr: ${stderr}`);
  });

  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2500))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    if (stubDir) await rm(stubDir, { recursive: true, force: true });
  });

  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    viewer: 'live-desktop',
    authenticated: true,
    failedProcesses: []
  });

  const anonymous = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate') || '', /Swarm admin desktop/);

  const invalid = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { authorization: `Basic ${Buffer.from(`${username}:wrong-password`).toString('base64')}` }
  });
  assert.equal(invalid.status, 401);

  const admin = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }
  });
  assert.notEqual(admin.status, 401, 'valid administrator credentials must pass the authentication gate');
  assert.equal(admin.status, 502, 'the stub upstream is intentionally unavailable; authentication must still succeed');
});
