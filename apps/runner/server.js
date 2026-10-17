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
if (TOKEN.length < 32 || /replace-with|your-/i.test(TOKEN)) throw new Error('RUNNER_SHARED_SECRET debe ser aleatorio y tener al menos 32 caracteres.');
app.disable('x-powered-by');
app.use(express.json({ limit: MAX_BODY, strict: true }));
function safeEqual(a, b) { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length > 0 && x.length === y.length && timingSafeEqual(x, y); }
function auth(req, res, next) { if (!safeEqual(req.get('x-swarm-runner-secret') || '', TOKEN)) return res.status(401).json({ error: 'No autorizado.' }); next(); }
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
  if (program === 'npm' && !['test', 'run', 'ci', 'install'].includes(args[0])) return false;
  if (program === 'xvfb-run' && args.some(x => /proxy|host-resolver|remote-debugging-port|load-extension/i.test(x))) return false;
  return true;
}
function runProcess(program, args, cwd, timeoutMs = MAX_RUNTIME_MS) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', outputBytes = 0, timedOut = false, settled = false, timer;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const child = spawn(program, args, {
      cwd, shell: false, detached: process.platform !== 'win32',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp/runner-home', TMPDIR: cwd, LANG: 'C.UTF-8', CI: 'true', CHROME_BIN: process.env.CHROME_BIN || '/usr/bin/chromium' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const collect = (target, chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (target === 'stdout' && stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString().slice(0, MAX_OUTPUT_BYTES - stdout.length);
      if (target === 'stderr' && stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString().slice(0, MAX_OUTPUT_BYTES - stderr.length);
      if (outputBytes > MAX_OUTPUT_BYTES * 2) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeoutMs);
    child.on('error', error => finish({ exitCode: null, stdout, stderr, error: error.message, timedOut }));
    child.on('close', exitCode => finish({ exitCode, stdout, stderr, error: '', timedOut }));
  });
}
async function withWorkspace(files, callback) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) throw Object.assign(new Error('files debe contener entre 1 y ' + MAX_FILES + ' archivos.'), { status: 400 });
  let total = 0;
  for (const file of files) {
    if (!file || !validRelativePath(file.path) || typeof file.content !== 'string') throw Object.assign(new Error('Ruta o contenido de archivo inválido.'), { status: 400 });
    const bytes = Buffer.byteLength(file.content, 'utf8'); total += bytes;
    if (bytes > MAX_FILE_BYTES) throw Object.assign(new Error('Un archivo supera el límite permitido.'), { status: 413 });
  }
  if (total > MAX_BODY) throw Object.assign(new Error('El conjunto de archivos supera el límite permitido.'), { status: 413 });
  const id = randomUUID(), workspace = path.join(ROOT, id);
  await fs.mkdir(workspace, { recursive: false, mode: 0o700 });
  try {
    for (const file of files) {
      const target = path.resolve(workspace, file.path);
      if (!target.startsWith(workspace + path.sep)) throw Object.assign(new Error('Ruta fuera del workspace.'), { status: 400 });
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, file.content, { mode: 0o600, flag: 'wx' });
    }
    return await callback({ id, workspace, files });
  } finally { await fs.rm(workspace, { recursive: true, force: true }).catch(() => {}); }
}
app.get('/healthz', (_req, res) => res.json({ ok: true, role: 'agent-runner', active, capacity: MAX_CONCURRENCY }));
app.post('/v1/run', auth, async (req, res) => {
  if (active >= MAX_CONCURRENCY) return res.status(429).json({ error: 'Runner ocupado; reintentar más tarde.' });
  if (!safeCommand(req.body?.command)) return res.status(400).json({ error: 'Comando no permitido. No se acepta shell ni una cadena de comandos.' });
  active++;
  try {
    const result = await withWorkspace(req.body.files, ({ id, workspace }) => runProcess(req.body.command.program, req.body.command.args || [], workspace).then(result => ({ id, ok: result.exitCode === 0 && !result.timedOut, ...result })));
    res.json(result);
  } catch (error) { res.status(error.status || 500).json({ error: String(error?.message || error).slice(0, 500) }); }
  finally { active--; }
});
app.post('/v1/check', auth, async (req, res) => {
  if (active >= MAX_CONCURRENCY) return res.status(429).json({ error: 'Runner ocupado; reintentar más tarde.' });
  active++;
  try {
    const result = await withWorkspace(req.body?.files, async ({ id, workspace, files }) => {
      const jsFiles = files.filter(f => /\.(?:js|mjs|cjs)$/i.test(f.path));
      const syntax = [];
      for (const file of jsFiles) {
        const checked = await runProcess(process.execPath, ['--check', path.resolve(workspace, file.path)], workspace, Math.min(MAX_RUNTIME_MS, 10000));
        syntax.push({ path: file.path, ok: checked.exitCode === 0 && !checked.timedOut, stderr: checked.stderr.slice(0, 3000), timedOut: checked.timedOut });
        if (!syntax.at(-1).ok) break;
      }
      const htmlEntry = files.find(f => /(?:^|\/)index\.html?$/i.test(f.path)) || files.find(f => /\.html?$/i.test(f.path));
      let browser = { checked: false, ok: true, message: 'No se entregó HTML; prueba visual omitida.' };
      if (htmlEntry && syntax.every(item => item.ok)) {
        const target = path.resolve(workspace, htmlEntry.path);
        const args = ['-a', '-s', '-screen 0 1280x900x24 -nolisten tcp', process.env.CHROME_BIN || '/usr/bin/chromium',
          '--headless=new', '--disable-background-networking', '--disable-sync', '--disable-extensions',
          '--disable-component-update', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run',
          '--no-default-browser-check', '--host-resolver-rules=MAP * ~NOTFOUND', '--proxy-server=http://127.0.0.1:9',
          '--proxy-bypass-list=<-loopback>', '--virtual-time-budget=1500', '--dump-dom', '--user-data-dir=' + path.join(workspace, '.chrome-profile'),
          new URL('file://' + target).href];
        const checked = await runProcess('xvfb-run', args, workspace, Math.min(MAX_RUNTIME_MS, 30000));
        browser = { checked: true, ok: checked.exitCode === 0 && !checked.timedOut, message: checked.timedOut ? 'Chromium/Xvfb superó el tiempo límite.' : checked.exitCode === 0 ? 'Chromium/Xvfb abrió el HTML con red deshabilitada.' : (checked.stderr || checked.error || 'Chromium falló.').slice(0, 3000) };
      }
      return { id, ok: syntax.every(item => item.ok) && browser.ok, filesChecked: files.length, syntax, browser };
    });
    res.json(result);
  } catch (error) { res.status(error.status || 500).json({ error: String(error?.message || error).slice(0, 500) }); }
  finally { active--; }
});
app.listen(PORT, '0.0.0.0', () => console.log(JSON.stringify({ event: 'runner_ready', port: PORT, capacity: MAX_CONCURRENCY, network: 'must be restricted by container/network policy' })));
