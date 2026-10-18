import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');

test('runner API is authenticated, bounded, and uses a fixed hardened Docker invocation', () => {
  for (const required of [
    'RUNNER_SHARED_SECRET', 'RUNNER_BIND_HOST', 'RUNNER_CONCURRENCY', 'ServerVersion', "'info'", 'image', 'inspect', 'Construí apps/runner/Dockerfile antes de iniciar la API.', 'MAX_CONCURRENCY = 1', 'red aislada por trabajo', "'127.0.0.1'", 'initialized', 'starting; retry shortly', 'timingSafeEqual', 'MAX_BODY_BYTES',
    'MAX_TOTAL_FILE_BYTES', 'MAX_FILES', '--network', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '--memory', '--cpus', '--tmpfs',
    '--cidfile', 'no-new-privileges:true', 'MAX_OUTPUT_CHARS',
    '/input,readonly', '/workspace:rw,nosuid,nodev,size=256m,mode=0777',
    'workspaceId', 'resetWorkspace', 'workspaceBusy', 'artifactSnapshot', 'finalizing', 'recopilando artefactos', 'finalizing', 'recopilando artefactos',
    'MAX_PENDING_JOBS', 'MAX_RETAINED_JOBS', 'pruneOldJobs',
    'No existe el workspace para reutilizar', 'el contenedor fue detenido',
    'containsCredential', '.npmrc', 'auth.json', 'settings.xml', 'service-account.json', 'PRIVATE KEY', 'createHash', 'requestHash', 'clave de idempotencia ya se usó', 'const hasStdin', 'stdin supera el límite de 16 KiB.', 'stdin interactivo solo se permite con network none.', 'currentChild.stdin.end(stdin || \'\')', 'pendingInput', 'job.hasStdin', 'La entrada interactiva del depurador no se conserva tras reiniciar el runner',
    'swarm-agent-egress', 'ensureRestrictedNetwork', 'chmod(ROOT, 0o700)', 'chmod(WORKSPACES, 0o700)', 'chmod(STATE, 0o700)', "basename === '.env'", "basename.startsWith('.env.')", "'credentials.json'"
  ]) assert.ok(source.includes(required), 'missing runner control: ' + required);
  assert.equal(source.includes('--privileged'), false);
  assert.equal(source.includes('/var/run/docker.sock'), false);
  assert.equal(source.includes('dst=/workspace,rw'), false);
  assert.ok(source.includes('cp -R -P /input/. /workspace/ && find /workspace -mindepth 1 -type d -exec chmod 0777 {} + && find /workspace -mindepth 1 -type f -exec chmod a+rw {} + && touch /tmp/swarm-runner-ready && exec tail -f /dev/null'));
  assert.ok(source.includes("['exec', ...(job.hasStdin ? ['-i'] : []), '--workdir', '/workspace', '--user', '65532:65532', cid, 'timeout'"));
  assert.ok(source.includes("'--workdir', '/workspace', '--user', '10001:10001'"));
  assert.ok(source.includes("content.includes('\\u0000') || containsCredential(content)"));
  assert.ok(source.includes("safeWorkspaceCopyPath"));
  assert.ok(source.includes("validateWorkspaceSnapshot"));
  assert.ok(source.includes("const exportScript ="));
  assert.ok(source.includes("Buffer.from([0])"));
  assert.ok(source.includes("Buffer.concat(paths.flatMap(p=>[Buffer.from(p),nul]))"));
  assert.ok(source.includes("function safe(p)"));
  assert.ok(source.includes("p.split('/').some(x=>!x||x==='.'||x==='..')"));
  assert.ok(source.includes("if(paths.length>50000)"));
  assert.ok(source.includes("chmod 0777 {} +"));
  assert.ok(source.includes("chmod a+rw {} +"));
  assert.ok(source.includes("test -w /workspace && test -z"));
  assert.equal(source.includes("paths.map(p=>p+'\\\\\\\\0').join('')"), false);
  assert.ok(source.includes("spawn('tar'"));
  assert.ok(source.includes("'--no-recursion'"));
  assert.ok(source.includes("MAX_WORKSPACE_BYTES = 256 * 1024 * 1024"));
  assert.ok(source.includes("MAX_WORKSPACE_ENTRIES = 50000"));
  assert.ok(source.includes("archiveBytes > MAX_WORKSPACE_BYTES + 64 * 1024 * 1024"));
  assert.ok(source.includes("pkill', '-KILL', '-u', '65532'"));
  assert.ok(source.includes("maxOutputChars = 4000"));
  assert.ok(source.includes("'--user', '65532:65532'"));
  assert.ok(source.includes("mode: 0o755"));
  assert.ok(source.includes("mode: 0o644"));
  assert.equal(source.includes('process.env, stdio'), false);
});

test('runner API exposes authenticated capability discovery without widening job permissions', () => {
  assert.ok(source.includes("new URL('../runner/capabilities.json', import.meta.url)"));
  assert.ok(source.includes("req.method === 'GET' && url.pathname === '/v1/capabilities'"));
  assert.ok(source.includes("safeEqual(req.headers['x-swarm-runner-secret'], SECRET)"));
});

test('runner API exposes health and async job lifecycle endpoints', () => {
  for (const route of [
    '/healthz', '/readyz', '/v1/jobs', '([0-9a-f-]{36})',
    'cancel', 'files', 'idempotencyKey', 'JOB_TTL_MS'
  ]) assert.ok(source.includes(route), 'missing API behavior: ' + route);
});


const capabilities = JSON.parse(await readFile(new URL('../runner/capabilities.json', import.meta.url), 'utf8'));

test('capability catalog accurately describes implemented dispatcher and sandbox defaults', () => {
  assert.equal(capabilities.schemaVersion, 1);
  assert.equal(capabilities.execution.defaultNetwork, 'none');
  assert.equal(capabilities.execution.concurrency, 1);
  assert.match(capabilities.execution.workspace, /task \+ agent \+ purpose/);
  assert.equal(capabilities.workspaceIsolation.status, 'worker-primitives-and-model-tool-dispatch-implemented');
  assert.equal(capabilities.workspaceIsolation.concurrency.globalRunner, 1);
  assert.match(capabilities.workspaceIsolation.merge, /fail closed/);
  assert.ok(capabilities.toolchains.some(item => item.id === 'typescript'));
  assert.ok(capabilities.toolchains.some(item => item.id === 'godot'));
  assert.ok(capabilities.toolchains.some(item => item.id === 'data-files'));
  assert.deepEqual(capabilities.agentToolContract.notYetImplemented, []);
  assert.equal(capabilities.agentToolContract.rolePolicyStatus, 'enforced-by-worker-dispatcher');
  assert.ok(capabilities.agentToolContract.rolePolicy.Desarrollador.allow.includes('workspace.write'));
  assert.ok(capabilities.notIncluded.some(item => item.includes('credenciales')));
});
