import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const configuredBase = String(process.env.AGENT_RUNNER_BASE_URL || '').trim().replace(/\/+$/, '');
const configuredSecret = String(process.env.AGENT_RUNNER_SHARED_SECRET || '');
const required = process.env.AGENT_RUNNER_REQUIRED === 'true';
const terminal = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function unavailable(message) {
  return { available: Boolean(configuredBase), checked: false, ok: !required && !configuredBase, skipped: !configuredBase && !required, message };
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
  const response = await fetch(configuredBase + path, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const error = new Error(String(body.error || 'El runner rechazó la solicitud.').slice(0, 1000));
    error.status = response.status;
    throw error;
  }
  return body;
}

/**
 * Trusted Worker -> private Runner API protocol. Commands are argv arrays, never
 * host-shell strings; network and resource policy are enforced by the runner host.
 */
export async function runAgentCommand({ taskId, workspaceId, resetWorkspace = true, files, command, network = 'none', timeoutMs = 60000, idempotencyKey } = {}) {
  if (!configuredBase) return unavailable(required ? 'AGENT_RUNNER_REQUIRED está activo, pero falta AGENT_RUNNER_BASE_URL.' : 'Runner remoto no configurado; se mantiene la validación determinista local.');
  if (configuredSecret.length < 32) return { available: true, checked: false, ok: false, message: 'AGENT_RUNNER_SHARED_SECRET debe contener al menos 32 caracteres.' };
  let baseUrl;
  try { baseUrl = new URL(configuredBase); } catch { return { available: true, checked: false, ok: false, message: 'AGENT_RUNNER_BASE_URL no es una URL válida.' }; }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) return { available: true, checked: false, ok: false, message: 'El protocolo del runner debe ser HTTP(S) sobre una red privada.' };
  if (baseUrl.protocol === 'http:' && !isPrivateRunnerHost(baseUrl.hostname)) {
    return { available: true, checked: false, ok: false, message: 'HTTP solo se admite para hosts privados/locales del runner; para un host público se exige HTTPS.' };
  }
  if (!Array.isArray(command) || !command.length || command.length > 32 || command.some(arg => typeof arg !== 'string' || arg.length > 4096)) {
    return { available: true, checked: false, ok: false, message: 'La herramienta solicitó un comando inválido.' };
  }
  const key = String(idempotencyKey || (String(taskId || randomUUID()) + ':exec:' + randomUUID())).slice(0, 128);
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
  if (!created?.id) return { available: true, checked: false, ok: false, message: 'No se pudo crear la ejecución aislada: ' + String(lastError?.message || 'el runner no respondió').slice(0, 1000) };
  const maxWait = Math.min(180000, Math.max(75000, Number(timeoutMs) + 60000));
  const deadline = Date.now() + maxWait;
  let latest = created;
  while (Date.now() < deadline) {
    if (terminal.has(latest.status)) {
      const ok = latest.status === 'succeeded' && latest.exitCode === 0 && !latest.timedOut;
      return {
        available: true, checked: true, ok, skipped: false, jobId: latest.id,
        exitCode: latest.exitCode, timedOut: Boolean(latest.timedOut), durationMs: latest.durationMs,
        stdout: String(latest.stdout || '').slice(-12000), stderr: String(latest.stderr || '').slice(-12000),
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
  return { available: true, checked: true, ok: false, jobId: created.id, timedOut: true, message: 'El runner no completó la tarea dentro de la ventana de espera; se solicitó cancelación y se conserva el ID ' + created.id + '. ' + String(lastError?.message || '').slice(0, 300) };
}

const CHECK_SCRIPT = String.raw`#!/usr/bin/env bash
set -uo pipefail
failed=0
checked=0
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
  esac
done
if [ -f go.mod ] && [ -d vendor ]; then
  checked=$((checked + 1)); GOPROXY=off go test -mod=vendor ./... || { echo "FAIL go test -mod=vendor"; failed=1; }
fi
mapfile -d '' java_files < <(find . -type f -name '*.java' -not -path './.git/*' -not -path './target/*' -print0)
if [ "${'${#java_files[@]}'}" -gt 0 ] && [ ! -f pom.xml ] && [ ! -f build.gradle ] && [ ! -f build.gradle.kts ]; then
  checked=$((checked + 1)); mkdir -p /tmp/swarm-java-classes
  javac -proc:none -d /tmp/swarm-java-classes "${'${java_files[@]}'}" || { echo "FAIL javac"; failed=1; }
fi
if [ -f Cargo.toml ] && [ -f Cargo.lock ] && [ -d vendor ]; then
  checked=$((checked + 1)); CARGO_NET_OFFLINE=true cargo test --offline || { echo "FAIL cargo test --offline"; failed=1; }
fi
if [ -f package.json ] && [ -d node_modules ]; then
  checked=$((checked + 1)); npm test --if-present || { echo "FAIL npm test"; failed=1; }
fi
if [ -f requirements.txt ] && find . -type f \( -name 'test_*.py' -o -name '*_test.py' \) -print -quit | grep -q .; then
  checked=$((checked + 1)); python3 -m pytest -q || { echo "FAIL pytest"; failed=1; }
fi
printf 'SWARM_RUNNER_CHECKED=%s\n' "$checked"
exit "$failed"
`;

export async function runProjectToolchainChecks({ taskId, round, files } = {}) {
  const entries = files instanceof Map
    ? [...files.entries()].map(([filePath, file]) => ({ path: filePath, content: String(file?.content || '') }))
    : Array.isArray(files) ? files : [];
  if (!entries.length) return { available: false, checked: false, ok: true, skipped: true, message: 'No hay archivos extraídos para ejecutar en el runner.' };
  const result = await runAgentCommand({
    taskId,
    workspaceId: /^[0-9a-f-]{36}$/i.test(String(taskId || '')) ? String(taskId) : undefined,
    resetWorkspace: true,
    files: entries,
    command: ['bash', '-lc', CHECK_SCRIPT],
    network: 'none',
    timeoutMs: 60000,
    idempotencyKey: String(taskId || randomUUID()) + ':validation:' + String(round || 1)
  });
  if (!result.checked) return result;
  const match = (String(result.stdout || '') + '\n' + String(result.stderr || '')).match(/SWARM_RUNNER_CHECKED=(\d+)/);
  const checked = Number(match?.[1] || 0);
  if (!checked && result.ok) return { ...result, checked: false, ok: true, skipped: true, message: 'El runner respondió, pero no encontró archivos compatibles con las comprobaciones de toolchain.' };
  const details = [result.message, result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 3500);
  return { ...result, checked: checked > 0, ok: result.ok, filesChecked: checked, message: details };
}
