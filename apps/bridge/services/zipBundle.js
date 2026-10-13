import { deflateRawSync } from 'node:zlib';

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[n] = value >>> 0;
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function safeName(value) {
  const name = String(value || '').replace(/\\/g, '/');
  if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) return null;
  if (name.split('/').some(part => !/^[\p{L}\p{N}._-]+$/u.test(part)) || Buffer.byteLength(name, 'utf8') > 240) return null;
  return name;
}
export function createZip(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > 41) throw new Error('El paquete debe contener entre 1 y 41 archivos.');
  const localParts = []; const centralParts = []; let offset = 0; let count = 0;
  const names = new Set();
  for (const file of files) {
    const name = safeName(file.path);
    if (!name || names.has(name)) continue;
    names.add(name);
    const filename = Buffer.from(name, 'utf8');
    const source = Buffer.from(String(file.content ?? ''), 'utf8');
    if (source.length > 2 * 1024 * 1024) throw new Error('Un archivo supera el tamaño permitido para empaquetar.');
    const compressed = deflateRawSync(source);
    const crc = crc32(source);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(filename.length, 26); local.writeUInt16LE(0, 28);
    localParts.push(local, filename, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centralParts.push(central, filename);
    offset += local.length + filename.length + compressed.length;
    count++;
  }
  if (!count) throw new Error('No hay archivos válidos para empaquetar.');
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}
