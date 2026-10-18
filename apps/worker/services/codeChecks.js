import { spawn } from 'node:child_process';
import path from 'node:path';

const runCheck = source => new Promise(resolve => {
  const child = spawn(process.execPath, ['--check', '--input-type=module'], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { if (stderr.length < 12000) stderr += chunk; });
  child.on('error', error => resolve({ ok: false, error: error.message }));
  child.on('close', code => resolve({ ok: code === 0, error: stderr.trim() }));
  child.stdin.end(source);
});

export function extractFiles(delivery) {
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
  const browser = html ? {
    available: false, checked: false, ok: true,
    message: 'Prueba de navegador NO EJECUTADA dentro del Worker; solo se ejecutará si está configurado el runner aislado.'
  } : { checked: false, ok: true, message: '' };
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
