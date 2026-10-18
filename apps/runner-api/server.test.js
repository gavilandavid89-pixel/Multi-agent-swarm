import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');

test('runner API is authenticated, bounded, and uses a fixed hardened Docker invocation', () => {
  for (const required of [
    'RUNNER_SHARED_SECRET', 'RUNNER_BIND_HOST', "'127.0.0.1'", 'initialized', 'starting; retry shortly', 'timingSafeEqual', 'MAX_BODY_BYTES',
    'MAX_TOTAL_FILE_BYTES', 'MAX_FILES', '--network', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '--memory', '--cpus', '--tmpfs',
    '--cidfile', 'no-new-privileges:true', 'MAX_OUTPUT_CHARS',
    '/input,readonly', '/workspace:rw,nosuid,nodev,size=256m,mode=1777',
    'workspaceId', 'resetWorkspace', 'workspaceBusy', 'artifactSnapshot', 'finalizing', 'recopilando artefactos',
    'MAX_PENDING_JOBS', 'MAX_RETAINED_JOBS', 'pruneOldJobs',
    'No existe el workspace para reutilizar', 'el contenedor fue detenido',
    'containsCredential', '.npmrc', 'auth.json', 'settings.xml', 'service-account.json', 'PRIVATE KEY',
    'swarm-agent-egress', 'ensureRestrictedNetwork'
  ]) assert.ok(source.includes(required), 'missing runner control: ' + required);
  assert.equal(source.includes('--privileged'), false);
  assert.equal(source.includes('/var/run/docker.sock'), false);
  assert.equal(source.includes('dst=/workspace,rw'), false);
  assert.ok(source.includes('cp -R -P /input/. /workspace/ && find /workspace -mindepth 1 ! -type l -exec chmod a+rwX,u-s,g-s,o-t {} + && touch /tmp/swarm-runner-ready && exec tail -f /dev/null'));
  assert.ok(source.includes("'exec', '--user', '10001:10001', cid, 'timeout'"));
  assert.ok(source.includes("'--user', '65532:65532'"));
  assert.ok(source.includes("mode: 0o755"));
  assert.ok(source.includes("mode: 0o644"));
  assert.equal(source.includes('process.env, stdio'), false);
});

test('runner API exposes health and async job lifecycle endpoints', () => {
  for (const route of [
    '/healthz', '/readyz', '/v1/jobs', '([0-9a-f-]{36})',
    'cancel', 'files', 'idempotencyKey', 'JOB_TTL_MS'
  ]) assert.ok(source.includes(route), 'missing API behavior: ' + route);
});
