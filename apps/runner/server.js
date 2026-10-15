import { timingSafeEqual } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const app = express();
const PORT = Number(process.env.PORT || 10000);
const RUNNER_SECRET = process.env.RUNNER_SHARED_SECRET || '';
const MAX_FILES = 40, MAX_FILE_BYTES = 256_000, MAX_TOTAL_BYTES = 1_500_000;
const MAX_RUN_MS = Math.min(60000, Math.max(3000, Number.parseInt(process.env.RUNNER_TIMEOUT_MS || '30000', 10) || 30000));
const MAX_CONCURRENT_RUNS = 1;
let activeRuns = 0;
if (RUNNER_SECRET.length < 32) throw new Error('RUNNER_SHARED_SECRET debe tener al menos 32 caracteres aleatorios.');
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb', strict: true }));

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  return aa.length > 0 && aa.length === bb.length && timingSafeEqual(aa, bb);
}
function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 180 || value.includes('\\') || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && /^[a-zA-Z0-9._@+-]+$/.test(part));
}
async function writeFiles(root, files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) throw new Error('La entrega debe incluir entre 1 y 40 archivos.');
  let total = 0;
  const seen = new Set();
  for (const file of files) {
    if (!file || !safePath(file.path) || typeof file.content !== 'string') throw new Error('Ruta o contenido de archivo inválido.');
    if (seen.has(file.path)) throw new Error('La entrega contiene rutas duplicadas.');
    seen.add(file.path);
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new Error('Un archivo supera el límite permitido.');
    total += bytes;
    if (total > MAX_TOTAL_BYTES) throw new Error('La entrega supera el tamaño total permitido.');
    const destination = path.join(root, file.path);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  await mkdir(path.join(root, '.home'), { mode: 0o700 });
  return { count: files.length, bytes: total, paths: seen };
}
function runSandbox(root, mode, paths) {
  return new Promise(resolve => {
    const hasHtml = [...paths].some(p => /(^|\/)index\.html?$/i.test(p) || /\.html?$/i.test(p));
    const testFiles = [...paths].filter(p => /(?:^|\/)[^/]*\.test\.(?:mjs|cjs|js)$/i.test(p));
    const jsFiles = [...paths].filter(p => /\.(?:mjs|cjs|js)$/i.test(p) && !/\.test\.(?:mjs|cjs|js)$/i.test(p));
    const pythonFiles = [...paths].filter(p => /\.py$/i.test(p));
    const pythonTests = pythonFiles.filter(p => /(?:^|\/)test[^/]*\.py$/i.test(p));
    let command, args, testMode = mode;
    if (mode === 'browser' || (mode === 'auto' && hasHtml)) {
      const html = [...paths].find(p => /(^|\/)index\.html?$/i.test(p)) || [...paths].find(p => /\.html?$/i.test(p));
      if (!html) return resolve({ status: 'skipped', reason: 'No se encontró un archivo HTML para la prueba gráfica.', exitCode: null, stdout: '', stderr: '' });
      testMode = 'browser';
      command = 'bwrap';
      args = sandboxArgs(root, ['/usr/bin/xvfb-run', '-a', '/usr/local/bin/node', '/app/browser-harness.mjs', html]);
    } else if (mode === 'node' || (mode === 'auto' && (testFiles.length || jsFiles.length))) {
      testMode = 'node';
      let inner;
      if (testFiles.length) inner = ['/usr/local/bin/node', '--test', ...testFiles];
      else {
        let entry = ['index.js','index.mjs','main.js','main.mjs','app.js','app.mjs','server.js'].find(p => paths.includes(p)) || (jsFiles.length === 1 ? jsFiles[0] : null);
        if (!entry) return resolve({ status: 'skipped', reason: 'No hay pruebas automatizadas ni punto de entrada inequívoco; no se ejecuta un archivo arbitrario por suposición.', exitCode: null, stdout: '', stderr: '' });
        inner = ['/usr/local/bin/node', '--disable-proto=throw', entry];
      }
      command = 'bwrap';
      args = sandboxArgs(root, inner);
    } else if (mode === 'auto' && pythonFiles.length) {
      testMode = 'python';
      let inner;
      if (pythonTests.length) inner = ['/usr/bin/python3', '-m', 'unittest', 'discover', '-s', '.', '-p', 'test*.py'];
      else {
        const entry = ['main.py','app.py','index.py'].find(p => paths.includes(p)) || (pythonFiles.length === 1 ? pythonFiles[0] : null);
        if (!entry) return resolve({ status: 'skipped', reason: 'No hay pruebas Python ni punto de entrada inequívoco.', exitCode: null, stdout: '', stderr: '' });
        inner = ['/usr/bin/python3', '-I', entry];
      }
      command = 'bwrap';
      args = sandboxArgs(root, inner);
    } else {
      return resolve({ status: 'skipped', reason: 'No se detectó una aplicación ejecutable compatible.', exitCode: null, stdout: '', stderr: '' });
    }
    const start = Date.now();
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8' }, detached: true });
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const cap = 12000;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (stdout.length < cap) stdout += chunk.slice(0, cap - stdout.length); });
    child.stderr.on('data', chunk => { if (stderr.length < cap) stderr += chunk.slice(0, cap - stderr.length); });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, MAX_RUN_MS);
    child.on('error', error => { if (settled) return; settled = true; clearTimeout(timer); resolve({ status: 'blocked', reason: error.message.includes('ENOENT') ? 'No está disponible bubblewrap/Xvfb; el ejecutor falla de forma segura.' : 'No se pudo iniciar el entorno aislado.', exitCode: null, stdout, stderr: error.message.slice(0, 1200), durationMs: Date.now() - start, mode: testMode }); });
    child.on('close', code => { if (settled) return; settled = true; clearTimeout(timer); resolve({ status: timedOut ? 'timeout' : code === 0 ? 'passed' : 'failed', reason: timedOut ? 'Se alcanzó el límite de tiempo.' : code === 0 ? 'Las pruebas de ejecución finalizaron sin errores.' : 'El proceso de prueba devolvió un código distinto de cero.', exitCode: code, stdout, stderr, durationMs: Date.now() - start, mode: testMode }); });
  });
}
function sandboxArgs(root, command) {
  return [
    '--unshare-all', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/etc', '/etc',
    '--ro-bind', '/app', '/app',
    '--ro-bind', '/ms-playwright', '/ms-playwright',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--chmod', '1777', '/tmp',
    '--ro-bind', root, '/input',
    '--size', '67108864', '--tmpfs', '/workspace', '--chdir', '/workspace',
    '--setenv', 'HOME', '/workspace/.home',
    '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    '--setenv', 'PLAYWRIGHT_BROWSERS_PATH', '/ms-playwright',
    '--setenv', 'NODE_PATH', '/app/node_modules',
    '--', '/usr/bin/prlimit', '--cpu=30', '--nproc=128', '--fsize=10485760', '--nofile=256', '--',
    '/usr/local/bin/node', '/app/sandbox-bootstrap.mjs', '/input', '/workspace', '--', ...command
  ];
}
async function removeTree(root) {
  if (!root) return;
  // The workspace is temporary; never follow symlinks during cleanup.
  await rm(root, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
}
app.get('/healthz', (_req, res) => {
  const probe = spawnSync('bwrap', ['--unshare-all', '--ro-bind', '/usr', '/usr', '--proc', '/proc', '--dev', '/dev', '--', '/usr/bin/true'], { encoding: 'utf8', timeout: 1500 });
  res.status(200).json({ ok: true, role: 'isolated-runner', sandboxAvailable: probe.status === 0, sandbox: probe.status === 0 ? 'bubblewrap-ready' : 'unavailable', sandboxError: probe.status === 0 ? null : String(probe.stderr || probe.error?.message || 'bubblewrap no disponible').slice(0, 500), xvfb: Boolean(process.env.RUNNER_XVFB_ENABLED === 'true') });
});
app.use('/v1', (req, res, next) => {
  if (!safeEqual(req.get('x-swarm-runner-secret'), RUNNER_SECRET)) return res.status(401).json({ error: 'No autorizado.' });
  next();
});
app.post('/v1/run', async (req, res) => {
  if (activeRuns >= MAX_CONCURRENT_RUNS) return res.status(429).json({ status: 'blocked', error: 'El ejecutor ya está procesando otra tarea; reintentá más tarde.' });
  activeRuns++;
  const mode = ['auto', 'node', 'browser'].includes(req.body?.mode) ? req.body.mode : 'auto';
  let root = '';
  try {
    root = await mkdtemp(path.join(os.tmpdir(), 'swarm-sandbox-'));
    const inventory = await writeFiles(root, req.body?.files);
    const result = await runSandbox(root, mode, inventory.paths);
    res.status(200).json({ ...result, filesReceived: inventory.count, bytesReceived: inventory.bytes, network: 'isolated', sandbox: 'bubblewrap' });
  } catch (error) {
    res.status(400).json({ status: 'rejected', error: String(error?.message || 'Solicitud de ejecución inválida.').slice(0, 1000) });
  } finally {
    await removeTree(root);
    activeRuns = Math.max(0, activeRuns - 1);
  }
});
app.listen(PORT, '0.0.0.0', () => console.log('[runner] isolated execution API listening on ' + PORT));
