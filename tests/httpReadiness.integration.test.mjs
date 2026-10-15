import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Pool } = require('../apps/bridge/node_modules/pg');

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
  if (!child) return true;
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode === 0;
  let forced = false;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      forced = true;
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
  return !forced && child.exitCode === 0;
}

async function apiJson(base, path, { method = 'GET', token = '', body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000)
  });
  return { response, payload: await response.json().catch(() => ({})) };
}

test('smoke HTTP funcional de cuentas, sesiones, invitaciones y readiness PostgreSQL', { timeout: 90000 }, async t => {
  const sourceDatabaseUrl = process.env.SWARM_DATABASE_URL;
  assert.ok(sourceDatabaseUrl, 'CI debe proporcionar PostgreSQL temporal');
  const schemaPool = new Pool({ connectionString: sourceDatabaseUrl, max: 1 });
  const schemaName = `swarm_http_${randomUUID().replace(/-/g, '')}`;
  let worker;
  let bridge;
  t.after(async () => {
    const bridgeStopped = await stopChild(bridge);
    const workerStopped = await stopChild(worker);
    assert.equal(bridgeStopped, true, `Bridge no cerró de forma ordenada. Logs: ${bridge?.logs || ''}`);
    assert.equal(workerStopped, true, `Worker no cerró de forma ordenada. Logs: ${worker?.logs || ''}`);
    await schemaPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {});
    await schemaPool.end().catch(() => {});
  });
  await schemaPool.query(`CREATE SCHEMA "${schemaName}"`);
  // Simulate a previously deployed database: app_users exists without the newer disabled_at column.
  await schemaPool.query(`CREATE TABLE "${schemaName}".app_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const isolatedUrl = new URL(sourceDatabaseUrl);
  isolatedUrl.searchParams.set('options', `-c search_path=${schemaName}`);
  const databaseUrl = isolatedUrl.toString();
  const bridgePort = await reservePort();
  const workerPort = await reservePort();
  const sharedSecret = 'swarm-http-smoke-secret-1234567890';
  const bootstrapPassword = 'swarm-http-smoke-bootstrap-key-123456';
  const workerUrl = `http://127.0.0.1:${workerPort}`;
  const commonEnv = {
    NODE_ENV: 'test',
    SWARM_DATABASE_URL: databaseUrl,
    SWARM_API_ENCRYPTION_KEY: process.env.SWARM_API_ENCRYPTION_KEY || '0'.repeat(64),
    DATABASE_URL: databaseUrl,
    HISTORY_ENCRYPTION_KEY: 'a'.repeat(64),
    WORKER_SHARED_SECRET: sharedSecret
  };
  worker = launch('apps/worker/server.js', {
    ...commonEnv,
    PORT: String(workerPort),
    DATABASE_PATH: './data/swarm-smoke-does-not-exist.sqlite',
    WORKER_CONCURRENCY: '1'
  });
  bridge = launch('apps/bridge/server.js', {
    ...commonEnv,
    PORT: String(bridgePort),
    WORKER_BASE_URL: workerUrl,
    APP_ACCESS_KEY: bootstrapPassword
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

  // First-admin bootstrap must work end-to-end against the isolated HTTP stack.
  const beforeBootstrap = await apiJson(bridgeUrl, '/api/auth/bootstrap-status');
  assert.equal(beforeBootstrap.response.status, 200);
  assert.equal(beforeBootstrap.payload.initialized, false);
  const adminLogin = await apiJson(bridgeUrl, '/api/auth/login', {
    method: 'POST', body: { username: 'admin', password: bootstrapPassword }
  });
  assert.equal(adminLogin.response.status, 200, JSON.stringify(adminLogin.payload));
  assert.equal(adminLogin.payload.user.role, 'admin');
  const adminToken = adminLogin.payload.token;
  const adminId = adminLogin.payload.user.id;
  assert.ok(adminToken);

  const afterBootstrap = await apiJson(bridgeUrl, '/api/auth/bootstrap-status');
  assert.equal(afterBootstrap.payload.initialized, true);
  const adminAccount = await apiJson(bridgeUrl, '/api/account', { token: adminToken });
  assert.equal(adminAccount.response.status, 200);
  assert.equal(adminAccount.payload.user.id, adminId);

  const selfDisable = await apiJson(bridgeUrl, `/api/admin/users/${adminId}/status`, {
    method: 'PATCH', token: adminToken, body: { disabled: true }
  });
  assert.equal(selfDisable.response.status, 403, 'admin accounts must not be disabled by the user-management endpoint');

  const invite = await apiJson(bridgeUrl, '/api/admin/invites', {
    method: 'POST', token: adminToken, body: { hours: 1 }
  });
  assert.equal(invite.response.status, 201, JSON.stringify(invite.payload));
  assert.ok(invite.payload.code);
  const reservedAdmin = await apiJson(bridgeUrl, '/api/auth/register', {
    method: 'POST', body: { username: 'admin', password: 'reserved-admin-password-123', invite: invite.payload.code }
  });
  assert.equal(reservedAdmin.response.status, 400, 'the admin bootstrap username must be reserved');
  const suffix = Date.now().toString().slice(-7);
  const username = `smoke-user-${suffix}`;
  const oldPassword = 'old-http-smoke-password-123';
  const newPassword = 'new-http-smoke-password-456';
  const registration = await apiJson(bridgeUrl, '/api/auth/register', {
    method: 'POST', body: { username, password: oldPassword, invite: invite.payload.code }
  });
  assert.equal(registration.response.status, 201, JSON.stringify(registration.payload));
  assert.equal(registration.payload.user.role, 'user');
  const originalUserToken = registration.payload.token;
  const userId = registration.payload.user.id;

  const duplicateInvite = await apiJson(bridgeUrl, '/api/auth/register', {
    method: 'POST', body: { username: `reuse-${suffix}`, password: oldPassword, invite: invite.payload.code }
  });
  assert.equal(duplicateInvite.response.status, 400, 'an invite must not be reusable');

  const userApis = await apiJson(bridgeUrl, '/api/account/apis', { token: originalUserToken });
  assert.equal(userApis.response.status, 200);
  assert.deepEqual(userApis.payload.apis, []);

  // Connection checks are metadata-only, and abuse is throttled before forwarding to the worker.
  for (let attempt = 0; attempt < 20; attempt++) {
    const check = await apiJson(bridgeUrl, '/api/account/apis/1/test', {
      method: 'POST', token: originalUserToken, body: {}
    });
    assert.equal(check.response.status, 404, 'an empty API slot should fail without contacting a provider');
  }
  const throttledCheck = await apiJson(bridgeUrl, '/api/account/apis/1/test', {
    method: 'POST', token: originalUserToken, body: {}
  });
  assert.equal(throttledCheck.response.status, 429, 'provider connection checks must be rate limited per account');
  assert.ok(Number(throttledCheck.response.headers.get('retry-after')) > 0);
  const forbiddenAdminList = await apiJson(bridgeUrl, '/api/admin/users', { token: originalUserToken });
  assert.equal(forbiddenAdminList.response.status, 403);

  const passwordChange = await apiJson(bridgeUrl, '/api/account/password', {
    method: 'PATCH', token: originalUserToken,
    body: { currentPassword: oldPassword, newPassword }
  });
  assert.equal(passwordChange.response.status, 200, JSON.stringify(passwordChange.payload));
  const rotatedToken = passwordChange.payload.token;
  assert.ok(rotatedToken);
  assert.notEqual(rotatedToken, originalUserToken);
  const priorSession = await apiJson(bridgeUrl, '/api/account', { token: originalUserToken });
  assert.equal(priorSession.response.status, 401, 'password changes must rotate the active session token');

  const oldPasswordLogin = await apiJson(bridgeUrl, '/api/auth/login', {
    method: 'POST', body: { username, password: oldPassword }
  });
  assert.equal(oldPasswordLogin.response.status, 401, 'the previous password must stop working');
  const newPasswordLogin = await apiJson(bridgeUrl, '/api/auth/login', {
    method: 'POST', body: { username, password: newPassword }
  });
  assert.equal(newPasswordLogin.response.status, 200, JSON.stringify(newPasswordLogin.payload));
  const newLoginToken = newPasswordLogin.payload.token;

  const managedUsers = await apiJson(bridgeUrl, '/api/admin/users', { token: adminToken });
  assert.equal(managedUsers.response.status, 200);
  const managedUser = managedUsers.payload.users.find(user => user.id === userId);
  assert.ok(managedUser);
  assert.equal(Object.hasOwn(managedUser, 'password_hash'), false);

  const disable = await apiJson(bridgeUrl, `/api/admin/users/${userId}/status`, {
    method: 'PATCH', token: adminToken, body: { disabled: true }
  });
  assert.equal(disable.response.status, 200, JSON.stringify(disable.payload));
  assert.ok(disable.payload.user.disabledAt);
  assert.equal((await apiJson(bridgeUrl, '/api/account', { token: rotatedToken })).response.status, 401);
  assert.equal((await apiJson(bridgeUrl, '/api/account', { token: newLoginToken })).response.status, 401);

  const reactivate = await apiJson(bridgeUrl, `/api/admin/users/${userId}/status`, {
    method: 'PATCH', token: adminToken, body: { disabled: false }
  });
  assert.equal(reactivate.response.status, 200, JSON.stringify(reactivate.payload));
  assert.equal(reactivate.payload.user.disabledAt, null);
  assert.equal((await apiJson(bridgeUrl, '/api/account', { token: newLoginToken })).response.status, 401,
    'reactivation must not revive revoked session tokens');
  const finalLogin = await apiJson(bridgeUrl, '/api/auth/login', {
    method: 'POST', body: { username, password: newPassword }
  });
  assert.equal(finalLogin.response.status, 200, JSON.stringify(finalLogin.payload));
  assert.equal((await apiJson(bridgeUrl, '/api/account', { token: finalLogin.payload.token })).response.status, 200);
});
