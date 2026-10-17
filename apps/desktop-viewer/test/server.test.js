import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = path.resolve(import.meta.dirname, '..');
const serverPath = path.join(repoRoot, 'server.js');
const username = 'swarm-admin-test';
const password = 'test-password-that-is-longer-than-24-chars';
let child;
let port;
let stubDir;
const probeServers = [];
let vncPort;
let noVncPort;
let debugPort;

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  await new Promise(resolve => server.close(resolve));
  return address.port;
}

async function startProbeServer(handler = (_req, res) => res.end('ok')) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  probeServers.push(server);
  return server.address().port;
}

async function startProbeSocket() {
  const server = net.createServer(socket => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  probeServers.push(server);
  return server.address().port;
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
  vncPort = await startProbeSocket();
  noVncPort = await startProbeSocket();
  debugPort = await startProbeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'Chromium/test' }));
  });
  child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH || ''}`,
      PORT: String(port),
      VIEWER_ADMIN_USERNAME: username,
      VIEWER_ADMIN_PASSWORD: password,
      DISPLAY: ':198',
      VNC_INTERNAL_PORT: String(vncPort),
      NOVNC_INTERNAL_PORT: String(noVncPort),
      CHROMIUM_DEBUG_PORT: String(debugPort)
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
    await Promise.all(probeServers.map(server => new Promise(resolve => server.close(resolve))));
    if (stubDir) await rm(stubDir, { recursive: true, force: true });
  });

  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    viewer: 'live-desktop',
    authenticated: true,
    checks: { processes: true, vnc: true, noVnc: true, chromium: true },
    failedProcesses: []
  });

  await new Promise((resolve, reject) => probeServers[1].close(error => error ? reject(error) : resolve()));
  const degraded = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(degraded.status, 503, 'health must fail when the noVNC listener is unavailable');
  assert.equal((await degraded.json()).checks.noVnc, false);

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


test('Bridge SSO tickets are signed, single-use, and disable Basic-auth bypass', async t => {
  const { createHmac, randomBytes } = await import('node:crypto');
  const localProbes = [];
  const localChildren = [];
  const localStubDir = await mkdtemp(path.join(tmpdir(), 'swarm-viewer-sso-'));
  const secret = randomBytes(32).toString('hex');
  const localPort = await freePort();
  const localVnc = await startLocalSocket(localProbes);
  const localNoVnc = await startLocalSocket(localProbes);
  const localDebug = await startLocalHttp(localProbes, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'Chromium/test' }));
  });
  for (const command of ['Xvfb', 'x11vnc', 'websockify', 'chromium']) {
    const file = path.join(localStubDir, command);
    await writeFile(file, '#!/bin/sh\nexec /bin/sleep 60\n');
    await chmod(file, 0o755);
  }
  const proc = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env, PATH: `${localStubDir}:${process.env.PATH || ''}`,
      PORT: String(localPort), DESKTOP_VIEWER_TICKET_SECRET: secret,
      VIEWER_ADMIN_USERNAME: username, VIEWER_ADMIN_PASSWORD: password,
      DISPLAY: ':197', VNC_INTERNAL_PORT: String(localVnc),
      NOVNC_INTERNAL_PORT: String(localNoVnc), CHROMIUM_DEBUG_PORT: String(localDebug)
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  localChildren.push(proc);
  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', chunk => { stderr += chunk; });
  await waitForServer(`http://127.0.0.1:${localPort}/healthz`, proc).catch(error => { throw new Error(`${error.message}; stderr: ${stderr}`); });
  t.after(async () => {
    for (const processRef of localChildren) {
      if (processRef.exitCode === null) {
        processRef.kill('SIGTERM');
        await Promise.race([once(processRef, 'exit'), new Promise(resolve => setTimeout(resolve, 2500))]);
        if (processRef.exitCode === null) processRef.kill('SIGKILL');
      }
    }
    await Promise.all(localProbes.map(server => new Promise(resolve => server.close(() => resolve()))));
    await rm(localStubDir, { recursive: true, force: true });
  });

  const health = await fetch(`http://127.0.0.1:${localPort}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).authenticated, true, 'SSO configuration counts as an authentication method');

  const basicBypass = await fetch(`http://127.0.0.1:${localPort}/`, {
    headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }
  });
  assert.equal(basicBypass.status, 401, 'Basic auth must not bypass Bridge role authorization in SSO mode');

  const makeTicket = (claims, key = secret) => {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return payload + '.' + createHmac('sha256', key).update(payload).digest('base64url');
  };
  const claims = { sub: 'admin-test', role: 'admin', aud: 'swarm-desktop-viewer', exp: Date.now() + 30_000, jti: randomBytes(16).toString('base64url') };
  const invalidSignature = makeTicket(claims, randomBytes(32).toString('hex'));
  const invalid = await fetch(`http://127.0.0.1:${localPort}/?ticket=${encodeURIComponent(invalidSignature)}`, { redirect: 'manual' });
  assert.equal(invalid.status, 401, 'ticket signed with another secret must be rejected');

  const ticket = makeTicket(claims);
  const exchange = await fetch(`http://127.0.0.1:${localPort}/?ticket=${encodeURIComponent(ticket)}`, { redirect: 'manual' });
  assert.equal(exchange.status, 303);
  assert.equal(exchange.headers.get('location'), '/');
  const cookie = exchange.headers.get('set-cookie') || '';
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=3600/);

  const replay = await fetch(`http://127.0.0.1:${localPort}/?ticket=${encodeURIComponent(ticket)}`, { redirect: 'manual' });
  assert.equal(replay.status, 401, 'the same Bridge ticket must not be exchanged twice');

  const expiredTicket = makeTicket({ ...claims, jti: randomBytes(16).toString('base64url'), exp: Date.now() - 1000 });
  const expired = await fetch(`http://127.0.0.1:${localPort}/?ticket=${encodeURIComponent(expiredTicket)}`, { redirect: 'manual' });
  assert.equal(expired.status, 401, 'expired tickets must be rejected');
});

async function startLocalSocket(servers) {
  const server = net.createServer(socket => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return server.address().port;
}

async function startLocalHttp(servers, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return server.address().port;
}
