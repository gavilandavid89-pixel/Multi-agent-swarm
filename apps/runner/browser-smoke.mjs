import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const sourceRoot = process.cwd();
const excluded = new Set(['.git', '.godot', 'node_modules', '.venv', 'venv', 'target', 'vendor', '.cache', '__pycache__', '.swarm-go-modcache', '.swarm-cargo-home', '.swarm-m2', '.swarm-gradle', '.swarm-bundle', '.bundle']);
const maxFiles = 500;
const maxBytes = 20 * 1024 * 1024;
let copiedFiles = 0;
let copiedBytes = 0;

async function copyProject(source, target, relative = '') {
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && excluded.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(to, { recursive: true, mode: 0o700 });
      await copyProject(from, to, relative ? relative + '/' + entry.name : entry.name);
    } else if (entry.isFile()) {
      const stat = await fs.stat(from);
      if (copiedFiles + 1 > maxFiles || copiedBytes + stat.size > maxBytes) {
        throw new Error('El proyecto supera el límite de copia para la prueba de navegador (500 archivos / 20 MiB).');
      }
      await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      await fs.copyFile(from, to);
      copiedFiles += 1;
      copiedBytes += stat.size;
    }
  }
}

function runBrowser(args, env, timeoutMs = 30000) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1280x900x24 -nolisten tcp', 'timeout', '--signal=TERM', '--kill-after=2s', '20s', 'chromium', ...args], {
      env, stdio: ['ignore', 'pipe', 'pipe']
    });
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (stdout.length < 1_000_000) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 12_000) stderr += chunk; });
    child.on('error', error => finish({ code: null, stdout, stderr: error.message, timedOut: false }));
    child.on('close', code => finish({ code, stdout, stderr, timedOut: false }));
  });
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-browser-check-'));
try {
  await copyProject(sourceRoot, temporaryRoot);
  const htmlFiles = [];
  async function findHtml(directory, relative = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (entry.isDirectory() && excluded.has(entry.name))) continue;
      const childPath = path.join(directory, entry.name);
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await findHtml(childPath, name);
      else if (entry.isFile() && /\.html?$/i.test(entry.name)) htmlFiles.push(name);
    }
  }
  await findHtml(temporaryRoot);
  if (!htmlFiles.length) throw new Error('No se encontró ningún archivo HTML para la prueba de navegador.');
  htmlFiles.sort((a, b) => Number(/(?:^|\/)index\.html?$/i.test(b)) - Number(/(?:^|\/)index\.html?$/i.test(a)));
  const entry = path.join(temporaryRoot, ...htmlFiles[0].split('/'));
  let document = await fs.readFile(entry, 'utf8');
  const monitor = '<script>(()=>{const e=[];addEventListener("error",x=>{if(x.target===window)e.push(String(x.message||"Error JavaScript"));},true);addEventListener("unhandledrejection",x=>{const m=String(x.reason&&x.reason.message||x.reason||"Promesa rechazada");if(!/failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(m))e.push(m)});addEventListener("load",()=>setTimeout(()=>{document.documentElement.setAttribute("data-swarm-js-errors",encodeURIComponent(JSON.stringify(e.slice(0,20))));},350));})();</script>';
  if (/<head\b[^>]*>/i.test(document)) document = document.replace(/<head\b[^>]*>/i, match => match + monitor);
  else if (/<html\b[^>]*>/i.test(document)) document = document.replace(/<html\b[^>]*>/i, match => match + monitor);
  else document = monitor + document;
  await fs.writeFile(entry, document, { mode: 0o600 });
  const profile = path.join(temporaryRoot, '.chromium-profile');
  const result = await runBrowser([
    '--timeout=10000', '--headless=new', '--no-sandbox', '--disable-background-networking',
    '--disable-sync', '--disable-extensions', '--disable-component-update',
    '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--host-resolver-rules=MAP * ~NOTFOUND',
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
    '--virtual-time-budget=1500', '--dump-dom', '--user-data-dir=' + profile,
    pathToFileURL(entry).href
  ], { PATH: process.env.PATH || '/usr/bin:/bin', HOME: temporaryRoot, LANG: 'C.UTF-8' });
  if (result.timedOut) throw new Error('Chromium/Xvfb superó el límite de 25 segundos.');
  if (result.code !== 0) throw new Error('Chromium/Xvfb falló: ' + String(result.stderr || result.stdout || 'código ' + result.code).slice(0, 1000));
  const encoded = result.stdout.match(/data-swarm-js-errors="([^"]*)"/i)?.[1];
  if (!encoded) throw new Error('Chromium no devolvió el marcador de errores JavaScript.');
  let errors;
  try { errors = JSON.parse(decodeURIComponent(encoded)); } catch { throw new Error('No se pudo leer el resultado del navegador.'); }
  if (errors.length) throw new Error('Se detectaron errores JavaScript en el navegador: ' + errors.join('; ').slice(0, 1500));
  console.log('SWARM_BROWSER_CHECKED=1');
  console.log('Chromium abrió ' + htmlFiles[0] + ' sin excepciones JavaScript detectadas.');
} catch (error) {
  console.error(String(error?.message || error).slice(0, 2000));
  process.exitCode = 1;
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
