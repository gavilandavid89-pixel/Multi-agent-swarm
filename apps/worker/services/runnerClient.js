import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const configuredBase = String(process.env.AGENT_RUNNER_BASE_URL || '').trim().replace(/\/+$/, '');
const configuredSecret = String(process.env.AGENT_RUNNER_SHARED_SECRET || '');
const required = process.env.AGENT_RUNNER_REQUIRED === 'true';
const terminal = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function unavailable(message) {
  return { available: Boolean(configuredBase), checked: false, ok: !required && !configuredBase, skipped: !configuredBase && !required, infraError: required && !configuredBase, message };
}
function containsSensitivePath(entries) {
  const blockedNames = new Set(['.npmrc', '.pypirc', '.netrc', '.git-credentials', '.gitconfig', '.envrc', '.dockerconfigjson', 'pip.conf', 'pip.ini', 'nuget.config', 'auth.json', 'settings.xml', 'gradle.properties', 'local.properties', 'terraform.tfvars', 'terraform.tfstate', 'secrets.yaml', 'secrets.yml', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials.json', 'service-account.json', 'kubeconfig']);
  const blockedDirs = new Set(['.git', '.godot', '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.docker', 'node_modules', '.venv', 'venv', '.swarm-go-modcache', '.swarm-cargo-home', '.swarm-m2', '.swarm-gradle', '.swarm-bundle', '.bundle']);
  return entries.some(file => {
    const parts = String(file.path || '').split('/');
    const base = parts.at(-1)?.toLowerCase() || '';
    return parts.some(part => blockedDirs.has(part.toLowerCase()))
      || blockedNames.has(base)
      || base === '.env'
      || (base.startsWith('.env.') && base !== '.env.example');
  });
}
function containsSensitiveCredential(entries) {
  const patterns = [
    /-----BEGIN (?:OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY-----/i,
    /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/,
    /https?:\/\/[^/\s:@]+:[^/\s@]+@/i
  ];
  return entries.some(file => patterns.some(pattern => pattern.test(String(file.content || ''))));
}
function isPrivateRunnerHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.')) return true;
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) return host === '::1' || /^(?:fc|fd)/i.test(host) || /^fe[89ab]/i.test(host);
  return false;
}
async function request(path, options = {}, timeoutMs = 15000) {
  const response = await fetch(configuredBase + path, {
    ...options,
    headers: { ...(options.headers || {}), 'x-swarm-runner-secret': configuredSecret },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs)
  });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const error = new Error(String(body.error || 'El runner rechazó la solicitud.').slice(0, 1000));
    error.status = response.status;
    throw error;
  }
  return body;
}

async function waitForRunnerReady(maxWaitMs = 150000) {
  const deadline = Date.now() + maxWaitMs;
  let lastError = null;
  while (Date.now() < deadline) {
    const remaining = Math.max(1000, deadline - Date.now());
    try {
      const ready = await request('/readyz', {}, Math.min(65000, remaining));
      if (ready.ok === true && ready.docker === 'ready' && ready.image === 'ready') return ready;
      lastError = new Error('El Runner API todavía no está listo.');
    } catch (error) {
      if (error.status && ![429, 502, 503, 504].includes(error.status)) throw error;
      lastError = error;
    }
    await delay(1000);
  }
  throw Object.assign(new Error('El Runner API no alcanzó estado ready en 150 segundos. ' + String(lastError?.message || '').slice(0, 300)), { status: 503 });
}

/**
 * Trusted Worker -> private Runner API protocol. Commands are argv arrays, never
 * host-shell strings; network and resource policy are enforced by the runner host.
 */
export async function runAgentCommand({ taskId, workspaceId, resetWorkspace = true, files, command, network = 'none', timeoutMs = 60000, idempotencyKey, includeArtifacts = false } = {}) {
  if (!configuredBase) return unavailable(required ? 'AGENT_RUNNER_REQUIRED está activo, pero falta AGENT_RUNNER_BASE_URL.' : 'Runner remoto no configurado; se mantiene la validación determinista local.');
  if (configuredSecret.length < 32) return { available: true, checked: false, ok: false, infraError: true, message: 'AGENT_RUNNER_SHARED_SECRET debe contener al menos 32 caracteres.' };
  let baseUrl;
  try { baseUrl = new URL(configuredBase); } catch { return { available: true, checked: false, ok: false, infraError: true, message: 'AGENT_RUNNER_BASE_URL no es una URL válida.' }; }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) return { available: true, checked: false, ok: false, infraError: true, message: 'El protocolo del runner debe ser HTTP(S) sobre una red privada.' };
  if (baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash || baseUrl.username || baseUrl.password) {
    return { available: true, checked: false, ok: false, infraError: true, message: 'AGENT_RUNNER_BASE_URL debe ser el origen del Runner API, sin rutas, query, fragmentos ni credenciales embebidas.' };
  }
  if (baseUrl.protocol === 'http:' && !isPrivateRunnerHost(baseUrl.hostname)) {
    return { available: true, checked: false, ok: false, infraError: true, message: 'HTTP solo se admite para hosts privados/locales del runner; para un host público se exige HTTPS.' };
  }
  if (!Array.isArray(command) || !command.length || command.length > 32 || command.some(arg => typeof arg !== 'string' || arg.length > 4096)) {
    return { available: true, checked: false, ok: false, message: 'La herramienta solicitó un comando inválido.' };
  }
  try { await waitForRunnerReady(); }
  catch (error) {
    return { available: true, checked: true, ok: false, infraError: true, skipped: false, message: 'El runner no está listo para aceptar trabajos: ' + String(error?.message || error).slice(0, 600) };
  }
  const key = String(idempotencyKey || (String(taskId || randomUUID()) + ':exec:' + randomUUID())).replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128);
  const selectedWorkspaceId = String(workspaceId || taskId || randomUUID());
  const safeWorkspaceId = /^[0-9a-f-]{36}$/i.test(selectedWorkspaceId) ? selectedWorkspaceId : randomUUID();
  let created;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      created = await request('/v1/jobs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-swarm-runner-secret': configuredSecret,
          'x-swarm-idempotency-key': key
        },
        body: JSON.stringify({ files, command, network, timeoutMs, workspaceId: safeWorkspaceId, resetWorkspace })
      }, 65000);
      break;
    } catch (error) {
      lastError = error;
      if (error.status && error.status !== 429 && error.status < 500) break;
      if (attempt < 2) await delay(1500 * (attempt + 1));
    }
  }
  if (!created?.id) return { available: true, checked: false, ok: false, infraError: true, message: 'No se pudo crear la ejecución aislada: ' + String(lastError?.message || 'el runner no respondió').slice(0, 1000) };
  const maxWait = Math.min(300000, Math.max(90000, Number(timeoutMs) + 90000));
  const deadline = Date.now() + maxWait;
  let latest = created;
  while (Date.now() < deadline) {
    if (terminal.has(latest.status)) {
      const ok = latest.status === 'succeeded' && latest.exitCode === 0 && !latest.timedOut;
      let artifacts = [];
      if (includeArtifacts && ok) {
        try {
          const response = await request('/v1/jobs/' + encodeURIComponent(latest.id) + '/files', {}, 15000);
          artifacts = Array.isArray(response.files) ? response.files.slice(0, 100).map(file => ({
            path: String(file.path || '').slice(0, 240),
            content: String(file.content || '').slice(0, 256 * 1024)
          })) : [];
        } catch (error) {
          return { available: true, checked: true, ok: false, infraError: true, jobId: latest.id, exitCode: latest.exitCode, timedOut: false, stdout: String(latest.stdout || '').slice(-12000), stderr: String(latest.stderr || '').slice(-12000), message: 'La ejecución terminó, pero no se pudieron recuperar sus artefactos: ' + String(error?.message || error).slice(0, 500) };
        }
      }
      return {
        available: true, checked: true, ok, skipped: false, jobId: latest.id,
        infraError: Boolean(latest.error || [125, 126, 127].includes(latest.exitCode)),
        exitCode: latest.exitCode, timedOut: Boolean(latest.timedOut), durationMs: latest.durationMs,
        stdout: String(latest.stdout || '').slice(-12000), stderr: String(latest.stderr || '').slice(-12000),
        ...(includeArtifacts ? { artifacts } : {}),
        message: ok
          ? 'La ejecución aislada terminó correctamente en ' + (Number(latest.durationMs) || 0) + ' ms.'
          : 'La ejecución aislada terminó con estado ' + latest.status + (latest.exitCode === null ? '' : ' (código ' + latest.exitCode + ')') + '.'
      };
    }
    await delay(1250);
    try { latest = await request('/v1/jobs/' + encodeURIComponent(created.id), {}, 15000); }
    catch (error) { lastError = error; }
  }
  try { await request('/v1/jobs/' + encodeURIComponent(created.id) + '/cancel', { method: 'POST' }, 5000); } catch {}
  return { available: true, checked: true, ok: false, infraError: true, jobId: created.id, timedOut: true, message: 'El runner no completó la tarea dentro de la ventana de espera; se solicitó cancelación y se conserva el ID ' + created.id + '. ' + String(lastError?.message || '').slice(0, 300) };
}

const CHECK_SCRIPT = String.raw`#!/usr/bin/env bash
set -uo pipefail
failed=0
checked=0
runtime_checked=0
mapfile -d '' files < <(find . -type f \
  -not -path './.git/*' -not -path './node_modules/*' -not -path './.venv/*' \
  -not -path './target/*' -not -path './vendor/*' -print0)
for file in "${'${files[@]}'}"; do
  case "$file" in
    *.js|*.mjs|*.cjs)
      checked=$((checked + 1)); node --check "$file" || { echo "FAIL node --check: $file"; failed=1; } ;;
    *.py)
      checked=$((checked + 1)); python3 -m py_compile "$file" || { echo "FAIL py_compile: $file"; failed=1; } ;;
    *.php)
      checked=$((checked + 1)); php -l "$file" >/dev/null || { echo "FAIL php -l: $file"; failed=1; } ;;
    *.rb)
      checked=$((checked + 1)); ruby -c "$file" >/dev/null || { echo "FAIL ruby -c: $file"; failed=1; } ;;
    *.go)
      checked=$((checked + 1)); gofmt -d "$file" >/dev/null || { echo "FAIL gofmt parse: $file"; failed=1; } ;;
    *.c)
      checked=$((checked + 1)); gcc -fsyntax-only -I. "$file" || { echo "FAIL gcc syntax: $file"; failed=1; } ;;
    *.cc|*.cpp|*.cxx)
      checked=$((checked + 1)); g++ -fsyntax-only -I. "$file" || { echo "FAIL g++ syntax: $file"; failed=1; } ;;
    *.sh)
      checked=$((checked + 1)); bash -n "$file" || { echo "FAIL bash -n: $file"; failed=1; } ;;
    *.json)
      checked=$((checked + 1)); node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$file" || { echo "FAIL JSON parse: $file"; failed=1; } ;;
  esac
done
if [ -f go.mod ] && [ -d vendor ]; then
  checked=$((checked + 1)); runtime_checked=$((runtime_checked + 1)); GOPROXY=off go test -mod=vendor ./... || { echo "FAIL go test -mod=vendor"; failed=1; }
fi
mapfile -d '' java_files < <(find . -type f -name '*.java' -not -path './.git/*' -not -path './target/*' -print0)
if [ "${'${#java_files[@]}'}" -gt 0 ] && [ ! -f pom.xml ] && [ ! -f build.gradle ] && [ ! -f build.gradle.kts ]; then
  checked=$((checked + 1)); mkdir -p /tmp/swarm-java-classes
  javac -proc:none -d /tmp/swarm-java-classes "${'${java_files[@]}'}" || { echo "FAIL javac"; failed=1; }
fi
if [ -f Cargo.toml ] && [ -f Cargo.lock ] && [ -d vendor ]; then
  checked=$((checked + 1)); runtime_checked=$((runtime_checked + 1)); CARGO_NET_OFFLINE=true cargo test --offline || { echo "FAIL cargo test --offline"; failed=1; }
fi
printf 'SWARM_RUNNER_CHECKED=%s\n' "$checked"
printf 'SWARM_RUNNER_TESTS=%s\n' "$runtime_checked"
exit "$failed"
`;

function detectRuntimeProfiles(entries) {
  const paths = new Set(entries.map(file => file.path));
  const contents = new Map(entries.map(file => [file.path, file.content]));
  const profiles = [];
  if (paths.has('project.godot')) {
    profiles.push({
      name: 'Godot headless import and startup',
      test: ['bash', '/opt/swarm-runner/godot-smoke.sh'],
      testTimeoutMs: 60000
    });
  }
  if (entries.some(file => /\.html?$/i.test(file.path))) {
    profiles.push({
      name: 'Chromium/Xvfb browser smoke',
      test: ['node', '/opt/swarm-runner/browser-smoke.mjs'],
      testTimeoutMs: 45000
    });
  }
  let pkg = null;
  try { if (contents.has('package.json')) pkg = JSON.parse(contents.get('package.json')); } catch {}
  const hasNodeTest = Boolean(pkg?.scripts?.test);
  const hasNodeBuild = Boolean(pkg?.scripts?.build);
  const nodeChecks = hasNodeTest && hasNodeBuild
    ? ['bash', '-lc', 'npm test && npm run build']
    : hasNodeTest ? ['npm', 'test'] : ['npm', 'run', 'build'];
  if (hasNodeTest || hasNodeBuild) {
    const locked = paths.has('package-lock.json') || paths.has('npm-shrinkwrap.json');
    profiles.push({
      name: hasNodeTest && hasNodeBuild ? 'npm test and build' : hasNodeTest ? 'npm test' : 'npm build',
      ...(locked ? { prepare: ['npm', 'ci', '--no-audit', '--no-fund'], prepareTimeoutMs: 120000 } : {}),
      test: nodeChecks,
      testTimeoutMs: 60000
    });
  }
  const hasPythonTests = entries.some(file => { const base = file.path.split('/').at(-1); return (base.startsWith('test_') && base.endsWith('.py')) || base.endsWith('_test.py'); });
  if (hasPythonTests && paths.has('requirements.txt')) {
    profiles.push({
      name: 'pytest',
      prepare: ['bash', '-lc', 'python3 -m venv .venv && .venv/bin/pip install --disable-pip-version-check --no-input -r requirements.txt'],
      prepareTimeoutMs: 120000,
      test: ['bash', '-lc', './.venv/bin/python -m pytest -q'],
      testTimeoutMs: 60000
    });
  } else if (hasPythonTests) {
    profiles.push({ name: 'pytest (offline; no requirements file)', test: ['python3', '-m', 'pytest', '-q'], testTimeoutMs: 60000 });
  }
  if (paths.has('go.mod') && paths.has('go.sum') && entries.some(file => file.path.endsWith('.go')) && !entries.some(file => file.path.startsWith('vendor/'))) {
    profiles.push({
      name: 'go test',
      prepare: ['bash', '-lc', 'GOMODCACHE=/workspace/.swarm-go-modcache GOPROXY=https://proxy.golang.org go mod download'],
      prepareTimeoutMs: 120000,
      test: ['bash', '-lc', 'GOMODCACHE=/workspace/.swarm-go-modcache GOPROXY=off go test ./...'],
      testTimeoutMs: 60000
    });
  }
  if (paths.has('Cargo.toml') && paths.has('Cargo.lock') && entries.some(file => file.path.endsWith('.rs')) && !paths.has('.cargo/config.toml') && !paths.has('.cargo/config')) {
    profiles.push({
      name: 'cargo test',
      prepare: ['bash', '-lc', 'CARGO_HOME=/workspace/.swarm-cargo-home cargo fetch --locked'],
      prepareTimeoutMs: 120000,
      test: ['bash', '-lc', 'CARGO_HOME=/workspace/.swarm-cargo-home CARGO_NET_OFFLINE=true CARGO_TARGET_DIR=/tmp/swarm-cargo-target cargo test --locked --offline'],
      testTimeoutMs: 60000
    });
  }
  let composer = null;
  try { if (contents.has('composer.json')) composer = JSON.parse(contents.get('composer.json')); } catch {}
  if (composer?.scripts?.test && paths.has('composer.lock')) {
    profiles.push({
      name: 'composer test',
      prepare: ['composer', 'install', '--no-interaction', '--no-progress'],
      prepareTimeoutMs: 120000,
      test: ['composer', 'run-script', '--no-interaction', 'test'],
      testTimeoutMs: 60000
    });
  }
  const hasRubyTests = entries.some(file => {
    const base = file.path.split('/').at(-1);
    return file.path.startsWith('spec/') || base === 'Rakefile' || (base.endsWith('_test.rb')) || (base.startsWith('test_') && base.endsWith('.rb'));
  });
  if (hasRubyTests && paths.has('Gemfile') && paths.has('Gemfile.lock')) {
    profiles.push({
      name: 'bundle test',
      prepare: ['bash', '-lc', 'bundle config set --local path /workspace/.swarm-bundle && bundle install --jobs 2 --retry 1'],
      prepareTimeoutMs: 120000,
      test: paths.has('Rakefile')
        ? ['bash', '-lc', 'bundle exec rake test']
        : entries.some(file => file.path.startsWith('spec/'))
          ? ['bundle', 'exec', 'rspec']
          : ['bundle', 'exec', 'ruby', '-Itest', '-e', "Dir.glob('test/**/*_test.rb').each { |f| require_relative f }"],
      testTimeoutMs: 60000
    });
  }
  if (paths.has('pom.xml')) {
    profiles.push({
      name: 'maven test',
      prepare: ['bash', '-lc', 'MAVEN_OPTS="-Dhttps.proxyHost=172.30.0.2 -Dhttps.proxyPort=3128 -Dhttp.proxyHost=172.30.0.2 -Dhttp.proxyPort=3128" mvn -B -Dmaven.repo.local=/workspace/.swarm-m2 -DskipTests dependency:go-offline'],
      prepareTimeoutMs: 120000,
      test: ['mvn', '-o', '-B', '-Dmaven.repo.local=/workspace/.swarm-m2', 'test'],
      testTimeoutMs: 60000
    });
  }
  if (paths.has('gradlew') && (paths.has('build.gradle') || paths.has('build.gradle.kts'))) {
    profiles.push({
      name: 'gradle test',
      prepare: ['bash', '-lc', 'GRADLE_OPTS="-Dhttps.proxyHost=172.30.0.2 -Dhttps.proxyPort=3128 -Dhttp.proxyHost=172.30.0.2 -Dhttp.proxyPort=3128" GRADLE_USER_HOME=/workspace/.swarm-gradle bash ./gradlew --no-daemon testClasses'],
      prepareTimeoutMs: 120000,
      test: ['bash', '-lc', 'GRADLE_USER_HOME=/workspace/.swarm-gradle bash ./gradlew --no-daemon --offline test'],
      testTimeoutMs: 60000
    });
  }
  return profiles;
}

function isDependencyInfrastructureFailure(result) {
  const output = String(result?.stdout || '') + '\\n' + String(result?.stderr || '') + '\\n' + String(result?.message || '');
  return Boolean(result?.infraError) || /EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|E403|proxy error|access denied|network is unreachable|could not resolve|temporary failure in name resolution|newconnectionerror|could not get|could not transfer artifact|failed to transfer|unknownhostexception|handshake_failure|PKIX path building failed|fetch failed|no space left on device|disk quota exceeded|failed to download|unable to download/i.test(output);
}

export async function runProjectToolchainChecks({ taskId, round, files } = {}) {
  const entries = files instanceof Map
    ? [...files.entries()].map(([filePath, file]) => ({ path: filePath, content: String(file?.content || '') }))
    : Array.isArray(files) ? files : [];
  if (!entries.length) return { available: false, checked: false, ok: true, skipped: true, message: 'No hay archivos extraídos para ejecutar en el runner.' };
  if (configuredBase && (containsSensitivePath(entries) || containsSensitiveCredential(entries))) {
    return { available: true, checked: false, ok: false, infraError: true, message: 'Se detectó una ruta de credenciales/caché o una credencial de alta confianza; no se envió ningún archivo al runner.' };
  }
  const workspaceId = /^[0-9a-f-]{36}$/i.test(String(taskId || '')) ? String(taskId) : randomUUID();
  const taskKey = String(taskId || workspaceId).replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 60);
  const result = await runAgentCommand({
    taskId, workspaceId, resetWorkspace: true, files: entries,
    command: ['bash', '-lc', CHECK_SCRIPT], network: 'none', timeoutMs: 60000,
    idempotencyKey: taskKey + ':validation:' + String(round || 1)
  });
  if (!result.checked) return result;
  if (!result.ok) {
    const details = [result.message, result.stdout, result.stderr].filter(Boolean).join('\\n').slice(0, 3500);
    return { ...result, checked: true, ok: false, message: details };
  }
  const match = (String(result.stdout || '') + '\\n' + String(result.stderr || '')).match(/SWARM_RUNNER_CHECKED=(\d+)/);
  const checked = Number(match?.[1] || 0);
  const profiles = detectRuntimeProfiles(entries);
  if (!checked && !profiles.length) return { ...result, checked: false, ok: true, skipped: true, message: 'El runner respondió, pero no encontró archivos o perfiles de prueba compatibles.' };
  const bundledTestMatch = (String(result.stdout || '') + '\\n' + String(result.stderr || '')).match(/SWARM_RUNNER_TESTS=(\d+)/);
  const bundledTestCount = Number(bundledTestMatch?.[1] || 0);
  const runtimeChecks = bundledTestCount > 0
    ? [{ profile: 'tests vendorizados', phase: 'tests', ok: true, exitCode: 0 }]
    : [];
  for (const profile of profiles) {
    const profileKey = profile.name.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').slice(0, 30);
    if (profile.prepare) {
      const prep = await runAgentCommand({
        taskId, workspaceId, resetWorkspace: false, files: [],
        command: profile.prepare, network: 'restricted', timeoutMs: profile.prepareTimeoutMs,
        idempotencyKey: taskKey + ':deps:' + String(round || 1) + ':' + profileKey
      });
      runtimeChecks.push({ profile: profile.name, phase: 'dependency-preparation', ok: prep.ok, exitCode: prep.exitCode, durationMs: prep.durationMs });
      if (!prep.ok) {
        const infraError = isDependencyInfrastructureFailure(prep);
        return {
          ...prep, checked: true, ok: false, infraError,
          filesChecked: checked, runtimeChecks,
          message: [result.message, profile.name + ' · preparación de dependencias: ' + prep.message, prep.stdout, prep.stderr].filter(Boolean).join('\\n').slice(0, 5000)
        };
      }
    }
    const tested = await runAgentCommand({
      taskId, workspaceId, resetWorkspace: false, files: [],
      command: profile.test, network: 'none', timeoutMs: profile.testTimeoutMs,
      idempotencyKey: taskKey + ':tests:' + String(round || 1) + ':' + profileKey
    });
    runtimeChecks.push({ profile: profile.name, phase: 'tests', ok: tested.ok, exitCode: tested.exitCode, durationMs: tested.durationMs });
    if (!tested.ok) {
      const output = String(tested.stdout || '') + '\\n' + String(tested.stderr || '');
      return {
        ...tested, checked: true, ok: false,
        // Missing modules/imports are usually actionable project failures for the repair loop.
        // Only runner/daemon failures and exhausted sandbox storage are infrastructure failures.
        infraError: Boolean(tested.infraError || /no space left on device|disk quota exceeded/i.test(output)),
        filesChecked: checked, runtimeChecks,
        message: [result.message, profile.name + ' · pruebas: ' + tested.message, tested.stdout, tested.stderr].filter(Boolean).join('\\n').slice(0, 5000)
      };
    }
  }
  const runtimeSummary = runtimeChecks.map(item => item.profile + ' (' + item.phase + '): ' + (item.ok ? 'OK' : 'FAIL')).join('; ');
  const details = [result.message, result.stdout, result.stderr, runtimeSummary ? 'Pruebas de proyecto: ' + runtimeSummary : ''].filter(Boolean).join('\\n').slice(0, 5000);
  return { ...result, checked: checked > 0 || runtimeChecks.length > 0, ok: true, filesChecked: checked, runtimeChecks, message: details };
}
