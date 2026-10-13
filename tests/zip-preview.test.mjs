import test from 'node:test';
import assert from 'node:assert/strict';
import { createZip } from '../apps/bridge/services/zipBundle.js';
import { parsePreviewZip } from '../apps/bridge/services/zipPreview.js';

test('ZIP de web detecta index.html y conserva assets sin extraer al disco', () => {
  const archive = createZip([
    { path: 'index.html', content: '<h1>Hola</h1><script src="app.js"></script>' },
    { path: 'app.js', content: 'document.body.dataset.ready = "yes";' },
    { path: 'assets/site.css', content: 'body { color: purple; }' },
    { path: 'game.wasm', content: '\\0asm\\u0001\\0\\0\\0' }
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

test('excluye formatos ejecutables y falla si no queda HTML para previsualizar', () => {
  const archive = createZip([{ path: 'setup.exe', content: 'not an executable' }, { path: 'readme.txt', content: 'hello' }]);
  assert.throws(() => parsePreviewZip(archive), /no encontramos ninguna página/);
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
