import { timingSafeEqual, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const app = express();
const PORT = Number(process.env.PORT || 3200);
const TOKEN = process.env.RUNNER_SHARED_SECRET || '';
const ROOT = path.resolve(process.env.RUNNER_WORKDIR || path.join(os.tmpdir(), 'swarm-runs'));
const MAX_BODY = Number(process.env.RUNNER_MAX_BODY_BYTES || 2_000_000);
const MAX_FILES = Number(process.env.RUNNER_MAX_FILES || 100);
const MAX_FILE_BYTES = Number(process.env.RUNNER_MAX_FILE_BYTES || 1_000_000);
const MAX_RUNTIME_MS = Number(process.env.RUNNER_MAX_RUNTIME_MS || 60_000);
const MAX_OUTPUT_BYTES = Number(process.env.RUNNER_MAX_OUTPUT_BYTES || 200_000);
const MAX_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.RUNNER_CONCURRENCY || 2)));
let active = 0;

if (TOKEN.length < 32 || /replace-with|your-/i.test(TOKEN)) {
  throw new Error('RUNNER_SHARED_SECRET debe ser aleatorio y tener al menos 32 caracteres.');
}
app.disable('x-powered-by');
app.use(express.json({ limit: MAX_BODY, strict: true }));

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
function auth(req, res, next) {
  if (!safeEqual(req.get('x-swarm-runner-secret') || '', TOKEN)) return res.status(401).json({ error: 'No autorizado.' });
  next();
}
function validRelativePath(name) {
  if (typeof name !== 'string' || !name || name.length > 240 || name.includes('\\') || name.includes('\0')) return false;
  if (name.startsWith('/') || /^[a-z]:/i.test(name)) return false;
  const parts = name.split('/');
  return parts.every(part => part && part !== '.' && part !== '..') && !parts.some(part => part === '.git' || part === 'node_modules');
}
function safeCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return false;
  const { program, args = [] } = command;
  if (!['npm', 'node', 'python3', 'pytest', 'xvfb-run', 'chromium'].includes(program)) return false;
  if (!Array.isArray(args) || args.length > 40 || args.some(x => typeof x !== 'string' || x.length > 500)) return false;
  // Avoid shell execution and direct attempts to override Chromium's network isolation.
  if (program === 'npm' && !['test', 'run', 'ci', 'install'].includes(args[0])) return false;
  if (program === 'xvfb-run' && args.some(x => /proxy|host-resolver|remote-debugging-port|load-extension/i.test(x))) return false;
  return true;
}
app.get('/healthz', (_req, res) => res.json({ ok: true, role: 'agent-runner', active, capacity: MAX_CONCURRENCY }));
app.post('/v1/run', auth, async (req, res) => {
  if (active >= MAX_CONCURRENCY) return res.status(429).json({ error: 'Runner ocupado; reintentar más tarde.' });
  const body = req.body || {};
  const files = body.files;
  const command = body.command;
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) return res.status(400).json({ error: 'files debe contener entre 1 y ' + MAX_FILES + ' archivos.' });
  if (!safeCommand(command)) return res.status(400).json({ error: 'Comando no permitido. No se acepta shell ni una cadena de comandos.' });
  let total = 0;
  for (const file of files) {
    if (!file || !validRelativePath(file.path) || typeof file.content !== 'string') return res.status(400).json({ error: 'Ruta o contenido de archivo inválido.' });
    total += Buffer.byteLength(file.content, 'utf8');
    if (Buffer.byteLength(file.content, 'utf8') > MAX_FILE_BYTES) return res.status(413).json({ error: 'Un archivo supera el límite permitido.' });
  }
  if (total > MAX_BODY) return res.status(413).json({ error: 'El conjunto de archivos supera el límite permitido.' });
  active++;
  const id = randomUUID();
  const workspace = path.join(ROOT, id);
  let response;
  try {
    await fs.mkdir(workspace, { recursive: false, mode: 0o700 });
    for (const file of files) {
      const target = path.resolve(workspace, file.path);
      if (!target.startsWith(workspace + path.sep)) throw new Error('Ruta fuera del workspace.');
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, file.content, { mode: 0o600, flag: 'wx' });
    }
    response = await new Promise(resolve => {
      let stdout = '', stderr = '', outputBytes = 0, timedOut = false, settled = false, timer;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const child = spawn(command.program, command.args, {
        cwd: workspace,
        shell: false,
        detached: process.platform !== 'win32',
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: '/tmp/runner-home',
          TMPDIR: workspace,
          LANG: 'C.UTF-8',
          CI: 'true',
          CHROME_BIN: process.env.CHROME_BIN || '/usr/bin/chromium',
          // Network is expected to be denied by the runner container's network policy by default.
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const collect = (target, chunk) => {
        outputBytes += Buffer.byteLength(chunk);
        if (target === 'stdout' && stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString().slice(0, MAX_OUTPUT_BYTES - stdout.length);
        if (target === 'stderr' && stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString().slice(0, MAX_OUTPUT_BYTES - stderr.length);
        if (outputBytes > MAX_OUTPUT_BYTES * 2) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      };
      child.stdout.on('data', chunk => collect('stdout', chunk));
      child.stderr.on('data', chunk => collect('stderr', chunk));
      timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }, MAX_RUNTIME_MS);
      child.on('error', error => finish({ exitCode: null, stdout, stderr, error: error.message, timedOut }));
      child.on('close', exitCode => finish({ exitCode, stdout, stderr, error: '', timedOut }));
    });
    res.status(200).json({ id, ok: response.exitCode === 0 && !response.timedOut, ...response });
  } catch (error) {
    res.status(500).json({ id, error: String(error?.message || error).slice(0, 500) });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    active--;
  }
});
app.listen(PORT, '0.0.0.0', () => console.log(JSON.stringify({ event: 'runner_ready', port: PORT, capacity: MAX_CONCURRENCY, network: 'must be restricted by container/network policy' })));
