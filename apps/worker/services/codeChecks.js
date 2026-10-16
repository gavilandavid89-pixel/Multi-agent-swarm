import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const runCheck = source => new Promise(resolve => {
  const child = spawn(process.execPath, ['--check', '--input-type=module'], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { if (stderr.length < 12000) stderr += chunk; });
  child.on('error', error => resolve({ ok: false, error: error.message }));
  child.on('close', code => resolve({ ok: code === 0, error: stderr.trim() }));
  child.stdin.end(source);
});

async function runBrowserSmokeCheck(files) {
  const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
  const xvfb = process.env.XVFB_RUN || 'xvfb-run';
  const required = process.env.NODE_ENV === 'production';
  if (!fs.existsSync(chrome)) {
    return { available: false, checked: false, ok: !required, message: required ? 'No está disponible Chromium en el worker de producción.' : 'Prueba de navegador omitida: Chromium no está instalado en este entorno.' };
  }

  const htmlEntries = [...files.entries()].filter(([name]) => /\.html?$/i.test(name));
  if (!htmlEntries.length) return { available: false, checked: false, ok: true, message: '' };
  const safePath = name => {
    const value = String(name || '').replace(/\\/g, '/');
    return value && !value.startsWith('/') && !/^[a-z]:/i.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-browser-check-'));
  const profile = path.join(directory, 'profile');
  try {
    const entry = htmlEntries.find(([name]) => /(?:^|\/)index\.html?$/i.test(name)) || htmlEntries[0];
    for (const [name, file] of files) {
      if (!safePath(name)) continue;
      const target = path.join(directory, ...name.replace(/\\/g, '/').split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(file.content || ''), { mode: 0o600 });
    }
    const entryPath = path.join(directory, ...entry[0].replace(/\\/g, '/').split('/'));
    let document = fs.readFileSync(entryPath, 'utf8');
    const monitor = '<script>(()=>{const e=[];addEventListener("error",x=>{if(x.target===window)e.push(String(x.message||"Error JavaScript"));},true);addEventListener("unhandledrejection",x=>{const m=String(x.reason&&x.reason.message||x.reason||"Promesa rechazada");if(!/failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(m))e.push(m)});addEventListener("load",()=>setTimeout(()=>{document.documentElement.setAttribute("data-swarm-js-errors",encodeURIComponent(JSON.stringify(e.slice(0,20))));},350));})();</script>';
    if (/<head\b[^>]*>/i.test(document)) document = document.replace(/<head\b[^>]*>/i, match => match + monitor);
    else if (/<html\b[^>]*>/i.test(document)) document = document.replace(/<html\b[^>]*>/i, match => match + monitor);
    else document = monitor + document;
    fs.writeFileSync(entryPath, document, { mode: 0o600 });

    const result = await new Promise(resolve => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let timer;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const child = spawn(xvfb, [
        '-a', '-s', '-screen 0 1280x900x24 -nolisten tcp',
        chrome, '--headless=new', '--disable-background-networking',
        '--disable-sync', '--disable-extensions', '--disable-component-update',
        '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run',
        '--no-default-browser-check', '--host-resolver-rules=MAP * ~NOTFOUND', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
        '--virtual-time-budget=1500', '--dump-dom',
        '--user-data-dir=' + profile, pathToFileURL(entryPath).href
      ], {
        cwd: directory,
        env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: directory, LANG: 'C.UTF-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      });
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { child.kill('SIGKILL'); }
      }, 30000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { if (stdout.length < 2500000) stdout += chunk; });
      child.stderr.on('data', chunk => { if (stderr.length < 12000) stderr += chunk; });
      child.on('error', error => finish({ exitCode: null, stdout, stderr, error: error.message, timedOut }));
      child.on('close', exitCode => finish({ exitCode, stdout, stderr, error: '', timedOut }));
    });
    if (result.timedOut) return { available: true, checked: true, ok: false, message: 'La prueba de navegador superó los 30 segundos y se detuvo por seguridad.' };
    if (result.exitCode !== 0) {
      const sandboxUnavailable = /failed to move to new namespace|no usable sandbox|operation not permitted/i.test(result.stderr || '');
      if (sandboxUnavailable && required) return { available: true, checked: false, ok: true, message: 'Prueba de navegador omitida: el runtime no permite el sandbox de Chromium; siguen activas las comprobaciones deterministas.' };
      return { available: true, checked: true, ok: false, message: 'Chromium no pudo ejecutar la vista previa: ' + String(result.error || result.stderr || 'código de salida ' + result.exitCode).slice(0, 1200) };
    }
    const encoded = result.stdout.match(/data-swarm-js-errors="([^"]*)"/i)?.[1];
    if (!encoded) return { available: true, checked: true, ok: false, message: 'Chromium no devolvió el marcador de la prueba; la ejecución HTML quedó incompleta.' };
    let errors = [];
    try { errors = JSON.parse(decodeURIComponent(encoded)); } catch { errors = ['No se pudo leer el resultado de errores JavaScript del navegador.']; }
    if (errors.length) return { available: true, checked: true, ok: false, message: 'La prueba de navegador detectó errores JavaScript: ' + errors.join('; ').slice(0, 1600) };
    return { available: true, checked: true, ok: true, message: 'Chromium + Xvfb abrió el HTML de entrada y no detectó excepciones JavaScript durante la prueba de humo.' };
  } catch (error) {
    return { available: true, checked: true, ok: false, message: 'Falló la prueba aislada del navegador: ' + String(error?.message || error).slice(0, 1200) };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function extractFiles(delivery) {
  const files = new Map();
  const re = /(?:^|\n)(?:#{1,6}\s+([^\n]+)|\*\*([^*\n]+)\*\*|(?:Archivo|File|Ruta)\s*:\s*([^\n]+))\s*\n\s*`{3}([^\n]*)\n([\s\S]*?)\n`{3}/g;
  let match;
  while ((match = re.exec(String(delivery || '')))) {
    let name = String(match[1] || match[2] || match[3] || '').replace(/^(?:Archivo|File|Ruta)\s*:\s*/i, '').trim().replace(/^\x60|\x60$/g, '').replace(/^\.\//, '');
    if (name && !name.includes('..') && !name.startsWith('/') && !/^[a-z]:/i.test(name) && !name.includes('\\') && name.length < 180) files.set(name, { content: match[5], language: match[4].trim().toLowerCase() });
  }
  return files;
}

export async function checkJavascriptSyntax(delivery) {
  const sourceText = String(delivery || '');
  const files = extractFiles(sourceText);
  const issues = [];
  const declaredNames = [...sourceText.matchAll(/^(?:#{1,6})\s+(?:Archivo|File|Ruta)\s*:\s*(.+)$/gim)]
    .map(match => match[1].trim().replace(/[`"]/g, '').replace(/^\.\//, ''));
  const seenNames = new Set();
  for (const name of declaredNames) {
    if (seenNames.has(name)) issues.push(`La ruta ${name} aparece más de una vez en la entrega; la integración sería ambigua.`);
    seenNames.add(name);
  }
  const jsFiles = [...files.entries()].filter(([name, file]) => /\.(?:js|mjs|cjs)$/i.test(name) || /^(?:javascript|js|mjs|cjs)$/.test(file.language));
  const blocks = [...String(delivery || '').matchAll(/```(?:javascript|js|mjs|cjs)\s*\n([\s\S]*?)```/gi)];
  const sources = jsFiles.length ? jsFiles.map(([name, file]) => ({ name, content: file.content })) : blocks.map((block, i) => ({ name: `bloque ${i + 1}`, content: block[1] }));
  for (const file of sources) {
    const result = await runCheck(file.content);
    if (!result.ok) issues.push(`${file.name}: ${(result.error || 'error de sintaxis').slice(0, 1200)}`);
  }
  if (files.has('package.json')) {
    try { JSON.parse(files.get('package.json').content); }
    catch (error) { issues.push(`package.json: JSON inválido (${error.message})`); }
  }
  // Verificá imports relativos contra el inventario completo; la revisión de IA no puede reemplazar este control.
  const knownFiles = new Set(files.keys());
  const resolveLocalImport = (from, specifier) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
    const extensions = ['', '.js', '.mjs', '.cjs', '.json', '.css', '.html'];
    const candidates = [...extensions.map(ext => base.endsWith(ext) ? base : base + ext), ...['index.js', 'index.mjs', 'index.cjs'].map(index => path.posix.join(base, index))];
    return candidates.some(candidate => knownFiles.has(candidate) || [...knownFiles].some(name => name.endsWith('/' + candidate)));
  };
  for (const [name, file] of files) {
    if (!/\.(?:js|mjs|cjs)$/i.test(name)) continue;
    const importPatterns = [
      /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
      /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g,
      /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g
    ];
    for (const pattern of importPatterns) {
      for (const match of file.content.matchAll(pattern)) {
        if (!resolveLocalImport(name, match[1])) issues.push(name + ' importa ' + match[1] + ', pero no se encontró ese archivo en la entrega.');
      }
    }
  }
  for (const [name, file] of files) {
    if (/\.css$/i.test(name)) {
      const css = file.content;
      if ((css.match(/{/g) || []).length !== (css.match(/}/g) || []).length) issues.push(`${name}: llaves CSS desbalanceadas; posible bloque truncado.`);
      if (/\@media[^{}]*\{[^{}]*$/s.test(css)) issues.push(`${name}: bloque @media incompleto al final del archivo.`);
    }
  }
  const htmlEntries = [...files.entries()].filter(([name]) => /\.html?$/i.test(name));
  const html = htmlEntries.map(([, file]) => file.content).join('\n');
  if (html) {
    for (const [, rawPath] of html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|mjs|css))["']/gi)) {
      const target = rawPath.replace(/^\.\//, '').replace(/^\//, '');
      const exists = [...files.keys()].some(name => name === target || name.endsWith('/' + target));
      if (!exists && !/^(?:https?:|data:)/i.test(rawPath)) issues.push('HTML referencia ' + rawPath + ', pero ese archivo no aparece en la entrega.');
    }
  }
  const browser = html ? await runBrowserSmokeCheck(files) : { checked: false, ok: true, message: '' };
  if (!browser.ok) issues.push(browser.message);
  for (const [name, file] of files) {
    if (name === 'package.json') {
      try {
        const pkg = JSON.parse(file.content);
        for (const command of Object.values(pkg.scripts || {})) {
          const match = String(command).match(/(?:node\s+)([\w./-]+\.(?:js|mjs|cjs))/);
          if (match && ![...files.keys()].some(path => path === match[1] || path.endsWith('/' + match[1]))) issues.push(`package.json declara un script que apunta a ${match[1]}, pero ese archivo no está en la entrega.`);
        }
      } catch {}
    }
  }
  if (issues.length) return { checked: sources.length > 0 || files.size > 0, ok: false, message: issues.slice(0, 20).join('\n').slice(0, 4000), filesChecked: files.size, javascriptChecked: sources.length, browserChecked: Boolean(browser.checked) };
  if (!sources.length && !files.size) return { checked: false, ok: true, message: 'No se encontraron archivos o bloques de código verificables; la entrega solo recibió revisión de IA.' };
  const browserNote = browser.message ? ' ' + browser.message : '';
  return { checked: true, ok: true, message: 'Comprobación determinista superada: ' + files.size + ' archivo(s) detectado(s), ' + sources.length + ' archivo(s)/bloque(s) JavaScript comprobado(s), JSON y referencias locales inspeccionados cuando correspondía.' + browserNote, filesChecked: files.size, javascriptChecked: sources.length, browserChecked: Boolean(browser.checked) };
}
