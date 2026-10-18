import { createServer } from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT || 3200);
const BIND_HOST = process.env.RUNNER_BIND_HOST || '127.0.0.1';
const SECRET = process.env.RUNNER_SHARED_SECRET || '';
const DOCKER = process.env.RUNNER_DOCKER_BIN || 'docker';
const IMAGE = process.env.SWARM_RUNNER_IMAGE || 'swarm-agent-runner:local';
const ROOT = path.resolve(process.env.RUNNER_STATE_DIR || '/var/lib/swarm-runner');
const WORKSPACES = path.join(ROOT, 'workspaces');
const STATE = path.join(ROOT, 'jobs');
const MAX_CONCURRENCY = Math.max(1, Math.min(2, Number.parseInt(process.env.RUNNER_CONCURRENCY || '1', 10) || 1));
const MAX_PENDING_JOBS = 25;
const MAX_RETAINED_JOBS = 20;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_OUTPUT_CHARS = 64 * 1024;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const jobs = new Map();
const idempotency = new Map();
const queue = [];
const running = new Map();
const workspaceBusy = new Map();
let active = 0;
let closing = false;
let initialized = false;

if (SECRET.length < 32 || /replace-with|your-/i.test(SECRET)) {
  throw new Error('RUNNER_SHARED_SECRET debe ser un secreto aleatorio de al menos 32 caracteres.');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('El cuerpo supera el límite permitido.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON inválido.'), { status: 400 }); }
}
function safeRelativePath(input) {
  if (typeof input !== 'string' || !input || input.length > 240 || input.includes('\\') || input.includes('\0') || input.startsWith('/') || /^[a-z]:/i.test(input)) return false;
  const parts = input.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return false;
  if (parts.some(part => ['.git', '.godot', '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.docker', 'node_modules', '.venv', 'venv', '.swarm-go-modcache', '.swarm-cargo-home', '.swarm-m2', '.swarm-gradle', '.swarm-bundle', '.bundle'].includes(part))) return false;
  const base = parts.at(-1).toLowerCase();
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) return false;
  if (['.npmrc', '.pypirc', '.netrc', '.git-credentials', '.gitconfig', '.envrc', '.dockerconfigjson', 'pip.conf', 'pip.ini', 'nuget.config', 'auth.json', 'settings.xml', 'gradle.properties', 'local.properties', 'terraform.tfvars', 'terraform.tfstate', 'secrets.yaml', 'secrets.yml', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials.json', 'service-account.json', 'kubeconfig'].includes(base)) return false;
  return true;
}
function containsCredential(content) {
  return /-----BEGIN (?:OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY-----/i.test(content)
    || /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/.test(content)
    || /https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(content);
}
function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Cuerpo de solicitud inválido.'), { status: 400 });
  if (!Array.isArray(body.command) || body.command.length < 1 || body.command.length > 32) throw Object.assign(new Error('command debe ser un arreglo de 1 a 32 argumentos.'), { status: 400 });
  const command = body.command.map(value => {
    if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw Object.assign(new Error('Argumento de comando inválido.'), { status: 400 });
    return value;
  });
  if (!command[0] || command[0].startsWith('-')) throw Object.assign(new Error('El ejecutable debe ser explícito.'), { status: 400 });
  const network = body.network === undefined ? 'none' : body.network;
  if (!['none', 'restricted'].includes(network)) throw Object.assign(new Error('network solo admite none o restricted.'), { status: 400 });
  const workspaceId = body.workspaceId === undefined ? null : String(body.workspaceId);
  if (workspaceId !== null && !/^[0-9a-f-]{36}$/i.test(workspaceId)) throw Object.assign(new Error('workspaceId debe ser un UUID.'), { status: 400 });
  const resetWorkspace = body.resetWorkspace !== false;
  const timeoutMs = Number(body.timeoutMs || 60000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw Object.assign(new Error('timeoutMs debe estar entre 1000 y 120000.'), { status: 400 });
  if (!Array.isArray(body.files) || body.files.length > MAX_FILES) throw Object.assign(new Error('files debe contener como máximo 200 archivos.'), { status: 400 });
  let total = 0; const seen = new Set();
  const files = body.files.map(file => {
    if (!file || !safeRelativePath(file.path) || typeof file.content !== 'string') throw Object.assign(new Error('Ruta o contenido de archivo inválido.'), { status: 400 });
    if (seen.has(file.path)) throw Object.assign(new Error('Hay rutas de archivo duplicadas.'), { status: 400 });
    seen.add(file.path);
    if (containsCredential(file.content)) throw Object.assign(new Error('No se permite enviar archivos con credenciales detectables al runner.'), { status: 400 });
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw Object.assign(new Error('Un archivo supera 256 KiB.'), { status: 413 });
    total += bytes;
    if (total > MAX_TOTAL_FILE_BYTES) throw Object.assign(new Error('El proyecto supera 2 MiB.'), { status: 413 });
    return { path: file.path, content: file.content };
  });
  if (!resetWorkspace && (!workspaceId || files.length)) throw Object.assign(new Error('Reutilizar workspace requiere workspaceId y files vacío.'), { status: 400 });
  return { command, network, timeoutMs, files, workspaceId, resetWorkspace };
}
function publicJob(job) {
  return {
    id: job.id, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt,
    startedAt: job.startedAt || null, finishedAt: job.finishedAt || null,
    exitCode: job.exitCode ?? null, timedOut: Boolean(job.timedOut), cancelled: Boolean(job.cancelled),
    stdout: job.stdout || '', stderr: job.stderr || '', error: job.error || null,
    durationMs: job.durationMs ?? null, artifactCount: job.artifactCount ?? 0
  };
}
async function save(job) {
  job.updatedAt = new Date().toISOString();
  const target = path.join(STATE, job.id + '.json');
  const temp = target + '.tmp';
  await fsp.writeFile(temp, JSON.stringify(job), { mode: 0o600 });
  await fsp.rename(temp, target);
}
async function writeWorkspace(job, files, resetWorkspace) {
  if (resetWorkspace) {
    await fsp.rm(job.workspace, { recursive: true, force: true });
    await fsp.mkdir(job.workspace, { recursive: false, mode: 0o755 });
  } else {
    let workspaceStat;
    try { workspaceStat = await fsp.stat(job.workspace); }
    catch (error) {
      if (error.code === 'ENOENT') throw Object.assign(new Error('No existe el workspace para reutilizar.'), { status: 404 });
      throw error;
    }
    if (!workspaceStat.isDirectory()) throw Object.assign(new Error('El workspace existente no es un directorio.'), { status: 409 });
    if (files.length) throw Object.assign(new Error('No se pueden añadir archivos a un workspace existente sin reset.'), { status: 400 });
  }
  for (const file of files) {
    const target = path.resolve(job.workspace, ...file.path.split('/'));
    if (!target.startsWith(job.workspace + path.sep)) throw new Error('La ruta sale del workspace.');
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await fsp.writeFile(target, file.content, { flag: 'wx', mode: 0o644 });
  }
}
function dockerArgs(job) {
  const args = [
    'run', '-d', '--init', '--cidfile', path.join(STATE, job.id + '.cid'),
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '128', '--memory', '1g', '--cpus', '2',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
    '--tmpfs', '/workspace:rw,nosuid,nodev,size=256m,mode=1777',
    '--mount', 'type=bind,src=' + job.workspace + ',dst=/input,readonly',
    '--workdir', '/workspace', '--user', '65532:65532',
    '--env', 'HOME=/tmp', '--env', 'CI=true', '--env', 'LANG=C.UTF-8',
    '--env', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '--env', 'CHROME_BIN=/usr/bin/chromium'
  ];
  if (job.network === 'restricted') {
    args.push('--network', 'swarm-agent-egress', '--dns', '127.0.0.1',
      '--env', 'HTTP_PROXY=http://172.30.0.2:3128',
      '--env', 'HTTPS_PROXY=http://172.30.0.2:3128',
      '--env', 'ALL_PROXY=http://172.30.0.2:3128',
      '--env', 'NO_PROXY=localhost,127.0.0.1,::1');
  } else args.push('--network', 'none');
  // Keep the container alive while docker cp snapshots its size-limited tmpfs workspace.
  // The project command is passed separately to docker exec as argv, never through a host shell.
  args.push(IMAGE, 'bash', '-c', 'cp -R -P /input/. /workspace/ && find /workspace -mindepth 1 ! -type l -exec chmod a+rwX,u-s,g-s,o-t {} + && touch /tmp/swarm-runner-ready && exec tail -f /dev/null');
  return args;
}
function appendOutput(job, key, chunk) {
  const current = job[key] || '';
  const next = current + chunk.toString('utf8');
  job[key] = next.length > MAX_OUTPUT_CHARS ? next.slice(-MAX_OUTPUT_CHARS) : next;
}
async function dockerCommand(args, timeoutMs = 5000) {
  return new Promise(resolve => {
    const child = spawn(DOCKER, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let done = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ code: null, stdout, stderr: 'Docker command timeout.' }); }, timeoutMs);
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    child.stdout.on('data', chunk => { if (stdout.length < 4000) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk.toString('utf8'); });
    child.on('error', error => finish({ code: null, stdout, stderr: error.message }));
    child.on('close', code => finish({ code, stdout, stderr }));
  });
}
async function ensureRestrictedNetwork() {
  const net = await dockerCommand(['network', 'inspect', '--format', '{{.Internal}}', 'swarm-agent-egress']);
  if (net.code !== 0 || net.stdout.trim() !== 'true') {
    throw Object.assign(new Error('La red swarm-agent-egress no existe o no es internal=true.'), { status: 503 });
  }
  const proxy = await dockerCommand(['inspect', '--format', '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', 'swarm-egress-proxy'], 5000);
  if (proxy.code !== 0 || String(proxy.stdout).trim() !== 'true|healthy') {
    throw Object.assign(new Error('El proxy swarm-egress-proxy no está healthy; se rechaza la preparación de dependencias.'), { status: 503 });
  }
  const proxyIp = await dockerCommand(['inspect', '--format', '{{with index .NetworkSettings.Networks "swarm-agent-egress"}}{{.IPAddress}}{{end}}', 'swarm-egress-proxy']);
  const outboundIp = await dockerCommand(['inspect', '--format', '{{with index .NetworkSettings.Networks "swarm-egress-outbound"}}{{.IPAddress}}{{end}}', 'swarm-egress-proxy']);
  if (proxyIp.code !== 0 || proxyIp.stdout.trim() !== '172.30.0.2' || outboundIp.code !== 0 || !outboundIp.stdout.trim()) {
    throw Object.assign(new Error('El proxy no está conectado a las dos redes esperadas o su IP interna cambió.'), { status: 503 });
  }
}
async function readContainerId(job) {
  try {
    const cid = (await fsp.readFile(path.join(STATE, job.id + '.cid'), 'utf8')).trim();
    return /^[0-9a-f]{12,64}$/i.test(cid) ? cid : '';
  } catch { return ''; }
}
async function killJobContainer(job) {
  const cid = await readContainerId(job);
  if (cid) await dockerCommand(['kill', cid], 5000);
}
async function removeJobContainer(job) {
  const cid = await readContainerId(job);
  if (cid) await dockerCommand(['rm', '-f', cid], 5000);
}
async function copyWorkspaceFromContainer(job) {
  const cid = await readContainerId(job);
  if (!cid) return;
  const copied = await dockerCommand(['cp', cid + ':/workspace/.', job.workspace + path.sep], 15000);
  if (copied.code !== 0) throw new Error('No se pudieron recuperar los archivos de salida del contenedor: ' + copied.stderr.slice(0, 600));
}
async function collectFiles(workspace) {
  const files = []; let total = 0;
  async function walk(directory, relative = '') {
    if (files.length >= 100 || total >= MAX_TOTAL_FILE_BYTES) return;
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= 100 || total >= MAX_TOTAL_FILE_BYTES) break;
      if (entry.isSymbolicLink() || ['.git', '.godot', '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.docker', 'node_modules', '.venv', 'venv', '.swarm-go-modcache', '.swarm-cargo-home', '.swarm-m2', '.swarm-gradle', '.swarm-bundle', '.bundle', 'vendor', '.cache', '__pycache__', 'target'].includes(entry.name)) continue;
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (!safeRelativePath(name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target, name);
      else if (entry.isFile()) {
        const stat = await fsp.stat(target);
        if (stat.size > MAX_FILE_BYTES || total + stat.size > MAX_TOTAL_FILE_BYTES) continue;
        const content = await fsp.readFile(target, 'utf8');
        if (content.includes('\u0000') || containsCredential(content)) continue;
        files.push({ path: name, content }); total += stat.size;
      }
    }
  }
  await walk(workspace);
  return files;
}
async function runJob(job) {
  active++;
  job.status = 'running'; job.startedAt = new Date().toISOString();
  const started = Date.now();
  let timedOut = false; let cancelled = false; let timer; let currentChild = null; let workspaceCopied = false;
  let stopPromise = Promise.resolve();
  const snapshotBeforeStop = async () => {
    if (workspaceCopied || !(await readContainerId(job))) return;
    try { await copyWorkspaceFromContainer(job); workspaceCopied = true; } catch {}
  };
  const stop = () => {
    stopPromise = (async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      await snapshotBeforeStop();
      await killJobContainer(job);
      try { currentChild?.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { currentChild?.kill('SIGKILL'); } catch {} }, 3000).unref();
    })();
  };
  const cancel = () => { cancelled = true; stop(); };
  running.set(job.id, { cancel });
  // The in-container GNU timeout handles normal expiry. This outer timer is a
  // safety net for a wedged Docker exec/daemon and snapshots files before kill.
  timer = setTimeout(() => {
    if (cancelled || timedOut) return;
    timedOut = true;
    job.error = 'El contenedor excedió el límite de seguridad externo del runner.';
    stop();
  }, job.timeoutMs + 5000);
  try {
    await save(job);
    if (job.network === 'restricted') await ensureRestrictedNetwork();
    if (timedOut || cancelled) throw new Error('La ejecución fue cancelada antes de iniciar el contenedor.');
    await fsp.rm(path.join(STATE, job.id + '.cid'), { force: true });
    const launched = await dockerCommand(dockerArgs(job), 15000);
    if (launched.code !== 0) throw new Error('No se pudo iniciar el contenedor: ' + String(launched.stderr || launched.stdout || 'docker run falló').slice(0, 800));
    const cid = await readContainerId(job);
    if (!cid) throw new Error('Docker no devolvió un identificador de contenedor.');
    let ready = false;
    for (let i = 0; i < 50 && !timedOut && !cancelled; i++) {
      const probe = await dockerCommand(['exec', cid, 'test', '-f', '/tmp/swarm-runner-ready'], 1000);
      if (probe.code === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) {
      const state = await dockerCommand(['inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}|{{.State.Error}}', cid], 2000);
      const logs = await dockerCommand(['logs', cid], 2000);
      throw new Error('El workspace del contenedor no quedó listo dentro del límite. state=' + String(state.stdout || state.stderr || '').trim().slice(0, 160) + ' logs=' + String((logs.stdout || '') + (logs.stderr || '')).trim().slice(0, 500));
    }
    if (timedOut || cancelled) throw new Error('La ejecución fue cancelada antes de ejecutar el comando.');
    const timeoutSeconds = Math.max(1, Math.ceil(job.timeoutMs / 1000));
    const result = await new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; resolve(value); };
      currentChild = spawn(DOCKER, ['exec', '--workdir', '/workspace', '--user', '10001:10001', cid, 'timeout', '--signal=TERM', '--kill-after=3s', timeoutSeconds + 's', ...job.command], { stdio: ['ignore', 'pipe', 'pipe'] });
      currentChild.stdout.on('data', chunk => appendOutput(job, 'stdout', chunk));
      currentChild.stderr.on('data', chunk => appendOutput(job, 'stderr', chunk));
      currentChild.on('error', error => finish({ code: null, error: error.message }));
      currentChild.on('close', code => finish({ code, error: null }));
    });
    job.exitCode = result.code;
    if (result.error) job.error = result.error;
    if (result.code === 124) timedOut = true;
  } catch (error) {
    job.error = String(error?.message || error).slice(0, 1200);
  } finally {
    clearTimeout(timer);
    if (timedOut || cancelled) await stopPromise;
    if (await readContainerId(job)) {
      if (!workspaceCopied) {
        try { await copyWorkspaceFromContainer(job); workspaceCopied = true; }
        catch (error) { job.error = String(error?.message || error).slice(0, 1200); }
      }
      await removeJobContainer(job);
    }
    job.timedOut = timedOut;
    job.cancelled = cancelled;
    job.finalizing = true;
    try {
      job.artifactSnapshot = await collectFiles(job.workspace);
      job.artifactCount = job.artifactSnapshot.length;
    } catch {
      job.artifactSnapshot = []; job.artifactCount = 0;
      job.error = job.error || 'No se pudieron recopilar los artefactos del workspace.';
    }
    job.status = cancelled ? 'cancelled' : timedOut ? 'timed_out' : job.error ? 'failed' : job.exitCode === 0 ? 'succeeded' : 'failed';
    delete job.finalizing;
    running.delete(job.id);
    job.durationMs = Date.now() - started;
    job.finishedAt = new Date().toISOString();
    await save(job).catch(() => {});
    active--;
    if (workspaceBusy.get(job.workspaceId) === job.id) workspaceBusy.delete(job.workspaceId);
    pump();
  }
}
async function pruneOldJobs() {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (running.has(job.id) || job.status === 'queued') continue;
    if (now - Date.parse(job.updatedAt) > JOB_TTL_MS) await deleteJob(job);
  }
  const completed = [...jobs.values()]
    .filter(job => !running.has(job.id) && job.status !== 'queued' && job.status !== 'running')
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  while (completed.length > MAX_RETAINED_JOBS) await deleteJob(completed.shift());
}
async function deleteJob(job) {
  jobs.delete(job.id);
  if (job.idempotencyKey && idempotency.get(job.idempotencyKey) === job.id) idempotency.delete(job.idempotencyKey);
  await fsp.rm(path.join(STATE, job.id + '.json'), { force: true });
  await fsp.rm(path.join(STATE, job.id + '.cid'), { force: true });
  const workspaceStillReferenced = [...jobs.values()].some(other => other.workspaceId === job.workspaceId);
  if (!workspaceStillReferenced) await fsp.rm(job.workspace, { recursive: true, force: true });
}
async function pump() {
  if (closing) return;
  while (active < MAX_CONCURRENCY && queue.length) {
    const id = queue.shift(); const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    void runJob(job);
  }
}
async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://runner.local');
  if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, role: 'agent-runner-api' });
  if (req.method === 'GET' && url.pathname === '/readyz') {
    if (!initialized) return json(res, 503, { ok: false, starting: true });
    const info = await dockerCommand(['info', '--format', '{{.ServerVersion}}'], 5000);
    if (info.code !== 0) return json(res, 503, { ok: false, docker: 'unavailable' });
    const image = await dockerCommand(['image', 'inspect', IMAGE], 5000);
    if (image.code !== 0) return json(res, 503, { ok: false, docker: 'ready', image: 'missing' });
    return json(res, 200, { ok: true, docker: 'ready', image: 'ready', queue: queue.length, active });
  }
  if (!initialized) return json(res, 503, { error: 'Runner is starting; retry shortly.' });
  if (!url.pathname.startsWith('/v1/')) return json(res, 404, { error: 'No encontrado.' });
  if (!safeEqual(req.headers['x-swarm-runner-secret'], SECRET)) return json(res, 401, { error: 'No autorizado.' });
  if (req.method === 'POST' && url.pathname === '/v1/jobs') {
    const body = validateRequest(await readJson(req));
    const key = String(req.headers['x-swarm-idempotency-key'] || '');
    if (key && !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return json(res, 400, { error: 'Clave de idempotencia inválida.' });
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (key && idempotency.has(key)) {
      const existing = jobs.get(idempotency.get(key));
      if (!existing || existing.requestHash !== requestHash) return json(res, 409, { error: 'La clave de idempotencia ya se usó con una solicitud diferente.' });
      return json(res, 200, publicJob(existing));
    }
    if (closing) return json(res, 503, { error: 'El runner se está apagando.' });
    if (queue.length + active >= MAX_PENDING_JOBS) return json(res, 429, { error: 'La cola del runner está llena; reintentá con la misma clave de idempotencia.' });
    await pruneOldJobs();
    const id = randomUUID(); const now = new Date().toISOString();
    const workspaceId = body.workspaceId || id;
    if (workspaceBusy.has(workspaceId)) return json(res, 409, { error: 'Ya hay una ejecución en cola o activa para este workspace.' });
    const job = { id, workspaceId, status: 'queued', createdAt: now, updatedAt: now, command: body.command, network: body.network, timeoutMs: body.timeoutMs, workspace: path.join(WORKSPACES, workspaceId), stdout: '', stderr: '', exitCode: null, timedOut: false, cancelled: false, error: null, idempotencyKey: key || null, requestHash, artifactSnapshot: [] };
    workspaceBusy.set(workspaceId, id);
    jobs.set(id, job);
    if (key) idempotency.set(key, id);
    try {
      await writeWorkspace(job, body.files, body.resetWorkspace);
      await save(job); queue.push(id); void pump();
    } catch (error) {
      if (workspaceBusy.get(workspaceId) === id) workspaceBusy.delete(workspaceId);
      if (body.resetWorkspace) await fsp.rm(job.workspace, { recursive: true, force: true }).catch(() => {});
      job.status = 'failed';
      job.error = String(error?.message || error).slice(0, 1200);
      job.finishedAt = new Date().toISOString();
      await save(job).catch(() => {});
      throw error;
    }
    return json(res, 202, publicJob(job));
  }
  const match = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]{36})(?:\/(files|cancel))?$/i);
  if (!match) return json(res, 404, { error: 'No encontrado.' });
  const job = jobs.get(match[1]);
  if (!job) return json(res, 404, { error: 'No existe esa ejecución.' });
  if (req.method === 'GET' && !match[2]) return json(res, 200, publicJob(job));
  if (req.method === 'GET' && match[2] === 'files') return json(res, 200, { files: Array.isArray(job.artifactSnapshot) ? job.artifactSnapshot : await collectFiles(job.workspace) });
  if (req.method === 'POST' && match[2] === 'cancel') {
    if (job.finalizing) return json(res, 409, { error: 'El trabajo está recopilando artefactos y ya no admite cancelación.' });
    if (['succeeded', 'failed', 'timed_out', 'cancelled'].includes(job.status)) return json(res, 200, publicJob(job));
    if (job.status === 'queued') {
      job.status = 'cancelled'; job.cancelled = true; job.finishedAt = new Date().toISOString(); await save(job);
      if (workspaceBusy.get(job.workspaceId) === job.id) workspaceBusy.delete(job.workspaceId);
    }
    else running.get(job.id)?.cancel();
    return json(res, 202, publicJob(job));
  }
  return json(res, 405, { error: 'Método no permitido.' });
}
async function initialize() {
  await fsp.mkdir(WORKSPACES, { recursive: true, mode: 0o700 });
  await fsp.mkdir(STATE, { recursive: true, mode: 0o700 });
  for (const name of await fsp.readdir(STATE)) {
    if (!name.endsWith('.json')) continue;
    try {
      const job = JSON.parse(await fsp.readFile(path.join(STATE, name), 'utf8'));
      if (!job || !/^[0-9a-f-]{36}$/i.test(job.id) || !['queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled'].includes(job.status)) continue;
      if (Date.now() - Date.parse(job.updatedAt) > JOB_TTL_MS) {
        await fsp.rm(path.join(STATE, name), { force: true });
        await fsp.rm(path.join(WORKSPACES, job.workspaceId || job.id), { recursive: true, force: true });
        continue;
      }
      if (job.status === 'running') {
        await killJobContainer(job).catch(() => {});
        await removeJobContainer(job).catch(() => {});
        job.status = 'failed'; job.error = 'El servicio se reinició durante la ejecución; el contenedor fue detenido y se requiere reintentar.';
        job.finishedAt = new Date().toISOString(); await save(job);
      }
      jobs.set(job.id, job);
      if (job.idempotencyKey) idempotency.set(job.idempotencyKey, job.id);
      if (job.status === 'queued') {
        if (workspaceBusy.has(job.workspaceId)) {
          job.status = 'failed'; job.error = 'Se detectaron trabajos duplicados para el mismo workspace durante la recuperación.';
          job.finishedAt = new Date().toISOString(); await save(job);
        } else {
          workspaceBusy.set(job.workspaceId, job.id);
          queue.push(job.id);
        }
      }
    } catch {}
  }
  await pruneOldJobs();
  const knownWorkspaces = new Set([...jobs.values()].map(job => job.workspaceId));
  for (const entry of await fsp.readdir(WORKSPACES, { withFileTypes: true })) {
    if (entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name) && !knownWorkspaces.has(entry.name)) {
      await fsp.rm(path.join(WORKSPACES, entry.name), { recursive: true, force: true });
    }
  }
  await pump();
  setInterval(() => { void pruneOldJobs().catch(() => {}); }, 10 * 60 * 1000).unref();
  initialized = true;
}
const server = createServer((req, res) => {
  void handle(req, res).catch(error => {
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Error interno del runner.' });
    else res.destroy();
  });
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.listen(PORT, BIND_HOST, () => {
  void initialize().then(() => {
    console.log('[runner-api] listening', JSON.stringify({ port: PORT, concurrency: MAX_CONCURRENCY, image: IMAGE }));
  }).catch(error => {
    console.error('[runner-api] initialization failed', error?.message || error);
    process.exit(1);
  });
});
function shutdown() {
  if (closing) return;
  closing = true;
  for (const entry of running.values()) { entry.cancel(); }
  server.close();
  const wait = setTimeout(() => process.exit(0), 10000); wait.unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
