import test from 'node:test';
import assert from 'node:assert/strict';
import { runSandboxTests } from '../apps/worker/services/sandboxRunner.js';

test('sin archivos no intenta ejecutar texto arbitrario', async () => {
  const result = await runSandboxTests('Una explicación sin archivos.');
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /No se detectaron archivos/);
});

test('rechaza rutas de archivo que intentan salir del workspace', async () => {
  const result = await runSandboxTests('### Archivo: ../escape.js\n```js\nconsole.log(1)\n```');
  assert.equal(result.status, 'skipped');
});

test('no requiere URL en modo opcional pero lo bloquea si se declara obligatorio', async () => {
  const oldUrl = process.env.SANDBOX_RUNNER_URL;
  const oldRequired = process.env.SANDBOX_RUNNER_REQUIRED;
  const oldSecret = process.env.SANDBOX_RUNNER_SECRET;
  delete process.env.SANDBOX_RUNNER_URL;
  delete process.env.SANDBOX_RUNNER_SECRET;
  process.env.SANDBOX_RUNNER_REQUIRED = 'false';
  const optional = await runSandboxTests('### Archivo: index.js\n```js\nconsole.log("ok")\n```');
  assert.equal(optional.status, 'skipped');
  process.env.SANDBOX_RUNNER_REQUIRED = 'true';
  const required = await runSandboxTests('### Archivo: index.js\n```js\nconsole.log("ok")\n```');
  assert.equal(required.status, 'blocked');
  if (oldUrl === undefined) delete process.env.SANDBOX_RUNNER_URL; else process.env.SANDBOX_RUNNER_URL = oldUrl;
  if (oldRequired === undefined) delete process.env.SANDBOX_RUNNER_REQUIRED; else process.env.SANDBOX_RUNNER_REQUIRED = oldRequired;
  if (oldSecret === undefined) delete process.env.SANDBOX_RUNNER_SECRET; else process.env.SANDBOX_RUNNER_SECRET = oldSecret;
});
