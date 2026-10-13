import test from 'node:test';
import assert from 'node:assert/strict';
import { createZip } from '../apps/bridge/services/zipBundle.js';
import { parsePreviewZip } from '../apps/bridge/services/zipPreview.js';

test('ZIP de web detecta index.html y conserva assets sin extraer al disco', () => {
  const archive = createZip([
    { path: 'index.html', content: '<h1>Hola</h1><script src="app.js"></script>' },
    { path: 'app.js', content: 'document.body.dataset.ready = "yes";' },
    { path: 'assets/site.css', content: 'body { color: purple; }' },
    { path: 'game.wasm', content: 'WASMTEST' }
  ]);
  const parsed = parsePreviewZip(archive);
  assert.equal(parsed.pages.length, 1);
  assert.equal(parsed.pages[0].path, 'index.html');
  assert.equal(parsed.files.find(file => file.path === 'app.js').content.toString('utf8'), 'document.body.dataset.ready = "yes";');
  assert.equal(parsed.files.find(file => file.path === 'assets/site.css').contentType, 'text/css; charset=utf-8');
  assert.equal(parsed.totalExpandedBytes > 0, true);
  assert.equal(parsed.files.find(file => file.path === 'game.wasm').contentType, 'application/wasm');
  assert.equal(parsed.files.find(file => file.path === 'game.wasm').content.length, 8);
});

test('genera un lanzador HTML para ZIP de juego JavaScript sin HTML', () => {
  const archive = createZip([
    { path: 'src/main.js', content: \"document.body.innerHTML = '<canvas id=game></canvas>';\" },
    { path: 'src/game.js', content: 'export const ready = true;' },
    { path: 'src/game.css', content: 'canvas { width: 100vw; height: 100vh; }' },
    { path: 'assets/texture.bin', content: 'texture' },
    { path: 'setup.exe', content: 'not an executable' }
  ]);
  const parsed = parsePreviewZip(archive);
  assert.equal(parsed.pages.length, 1);
  assert.equal(parsed.pages[0].path, '__swarm_preview__/index.html');
  const shell = parsed.files.find(file => file.path === parsed.pages[0].path).content.toString('utf8');
  assert.match(shell, /type=\"module\"/);
  assert.match(shell, /src\\/main\\.js/);
  assert.match(shell, /src\\/game\\.css/);
  assert.equal(parsed.files.some(file => file.path === 'setup.exe'), false);
});

test('da un error útil si el ZIP no tiene HTML ni un entrypoint de juego reconocido', () => {
  const archive = createZip([{ path: 'setup.exe', content: 'not an executable' }, { path: 'readme.txt', content: 'hello' }, { path: 'utils.js', content: 'export const x = 1;' }]);
  assert.throws(() => parsePreviewZip(archive), /No encontramos index\\.html ni un punto de entrada JavaScript reconocido/);
});

test('rechaza datos que no son ZIP y paquetes mayores al límite', () => {
  assert.throws(() => parsePreviewZip(Buffer.from('not a zip')), /ZIP completo/);
  assert.throws(() => parsePreviewZip(Buffer.alloc(32 * 1024 * 1024 + 1)), /como máximo 32 MB/);
});

test('rechaza archivos HTML dañados por checksum', () => {
  const archive = createZip([{ path: 'index.html', content: '<h1>hola</h1>' }]);
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  archive.writeUInt32LE((archive.readUInt32LE(centralOffset + 16) ^ 1) >>> 0, centralOffset + 16);
  assert.throws(() => parsePreviewZip(archive), /suma de comprobación/);
});
