import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { createZip } from '../apps/bridge/services/zipBundle.js';

test('crea un ZIP válido con nombres de ruta y contenido íntegro', () => {
  const archive = createZip([
    { path: 'index.html', content: '<h1>Hola Swarm</h1>' },
    { path: 'src/main.js', content: 'console.log("ok");' }
  ]);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  const nameLength = archive.readUInt16LE(26);
  const extraLength = archive.readUInt16LE(28);
  const compressedSize = archive.readUInt32LE(18);
  assert.equal(archive.subarray(30, 30 + nameLength).toString('utf8'), 'index.html');
  const bodyStart = 30 + nameLength + extraLength;
  assert.equal(inflateRawSync(archive.subarray(bodyStart, bodyStart + compressedSize)).toString('utf8'), '<h1>Hola Swarm</h1>');
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endOffset > 0);
  assert.equal(archive.readUInt16LE(endOffset + 10), 2);
});

test('rechaza un paquete vacío y descarta rutas inseguras', () => {
  assert.throws(() => createZip([]), /entre 1 y 41/);
  assert.throws(() => createZip([{ path: '../secreto.txt', content: 'no' }]), /No hay archivos válidos/);
});
