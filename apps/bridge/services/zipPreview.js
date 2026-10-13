import { inflateRawSync } from 'node:zlib';

const MAX_FILES = 250;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.mp4',
  '.webm', '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.mid', '.midi', '.txt', '.xml', '.wasm', '.bin', '.mem', '.dat', '.data',
  '.csv', '.map', '.webmanifest', '.glb', '.gltf', '.obj', '.mtl', '.ktx', '.ktx2',
  '.basis', '.hdr', '.exr', '.vert', '.frag', '.glsl', '.shader', '.pck', '.unityweb', '.assetbundle', '.bytes'
]);
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.com', '.bat', '.cmd', '.sh', '.ps1', '.msi',
  '.apk', '.aab', '.app', '.dmg', '.pkg', '.deb', '.rpm', '.jar', '.class',
  '.scr', '.hta', '.vbs', '.wsf', '.reg', '.lnk', '.iso'
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.mid': 'audio/midi', '.midi': 'audio/midi',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.dat': 'application/octet-stream',
  '.data': 'application/octet-stream', '.mem': 'application/octet-stream', '.pck': 'application/octet-stream', '.unityweb': 'application/octet-stream', '.assetbundle': 'application/octet-stream', '.bytes': 'application/octet-stream', '.csv': 'text/csv; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json; charset=utf-8', '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8', '.ktx': 'image/ktx', '.ktx2': 'image/ktx2',
  '.basis': 'application/octet-stream', '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream',
  '.vert': 'text/plain; charset=utf-8', '.frag': 'text/plain; charset=utf-8'
};
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
function extensionOf(name) {
  const leaf = name.split('/').pop();
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(dot).toLowerCase() : '';
}
function safeArchivePath(name) {
  if (!name || name.startsWith('/') || name.includes('\\') || /^[a-z]:/i.test(name)) return false;
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  const parts = name.split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && !part.includes(':'));
}
function findEndRecord(buffer) {
  const minimum = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimum; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length) return offset;
    }
  }
  throw new Error('El archivo no parece ser un ZIP completo o está dañado.');
}

/** Parse only ordinary ZIP entries; never extracts to the filesystem. */
export function parsePreviewZip(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buffer.length > 32 * 1024 * 1024) throw new Error('El ZIP debe pesar como máximo 32 MB.');
  if (buffer.length < 22) throw new Error('El archivo no parece ser un ZIP completo o está dañado.');
  const end = findEndRecord(buffer);
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) throw new Error('No se admiten ZIP divididos en varios volúmenes.');
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (count > MAX_FILES) throw new Error('El ZIP supera el límite de 250 entradas.');
  if (centralOffset + centralSize > end || centralOffset + centralSize < centralOffset) throw new Error('El índice interno del ZIP está fuera de rango.');
  const files = [];
  const seen = new Set();
  let offset = centralOffset;
  let expandedTotal = 0;

  for (let entry = 0; entry < count; entry++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('El índice de archivos del ZIP está dañado.');
    const madeBy = buffer.readUInt16LE(offset + 4);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > end) throw new Error('Una entrada del ZIP está truncada.');
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = rawName.toString((flags & 0x0800) ? 'utf8' : 'latin1');
    offset = recordEnd;
    if (name.endsWith('/')) continue;
    if (!safeArchivePath(name)) throw new Error('El ZIP contiene una ruta peligrosa: ' + name.slice(0, 120));
    const ext = extensionOf(name);
    const unixMode = (madeBy >> 8) === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
    if ((unixMode & 0xf000) === 0xa000) throw new Error('El ZIP contiene enlaces simbólicos, que no se admiten.');
    if (seen.has(name)) throw new Error('El ZIP contiene rutas duplicadas: ' + name.slice(0, 120));
    seen.add(name);
    if (BLOCKED_EXTENSIONS.has(ext)) continue;
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;
    if ((flags & 1) !== 0) throw new Error('No se admiten entradas ZIP cifradas.');
    if (method !== 0 && method !== 8) throw new Error('El ZIP usa un método de compresión no compatible.');
    if (uncompressedSize > MAX_FILE_BYTES) throw new Error('Un archivo supera el límite de 8 MB: ' + name.slice(0, 120));
    expandedTotal += uncompressedSize;
    if (expandedTotal > MAX_EXPANDED_BYTES) throw new Error('El ZIP supera el límite de 32 MB descomprimidos.');
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Una entrada apunta a datos ZIP inválidos.');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart < localOffset || dataEnd > centralOffset || dataEnd < dataStart) throw new Error('Los datos de una entrada ZIP están fuera de rango.');
    const compressed = buffer.subarray(dataStart, dataEnd);
    let content;
    try {
      content = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_FILE_BYTES });
    } catch {
      throw new Error('No se pudo descomprimir el archivo: ' + name.slice(0, 120));
    }
    if (content.length !== uncompressedSize || crc32(content) !== expectedCrc) throw new Error('El tamaño o la suma de comprobación no coincide para: ' + name.slice(0, 120));
    files.push({ path: name, content, size: content.length, contentType: MIME_TYPES[ext] || 'application/octet-stream' });
  }
  let pages = files.filter(file => ['.html', '.htm'].includes(extensionOf(file.path)));
  if (!pages.length) {
    // A ZIP containing browser-native JavaScript can be launched with a generated HTML shell.
    // This intentionally does not attempt to execute server-side projects or install npm packages.
    const preferredEntrypoints = [
      'index.js', 'main.js', 'game.js', 'app.js', 'bundle.js', 'index.mjs', 'main.mjs', 'game.mjs', 'app.mjs',
      'dist/index.js', 'dist/main.js', 'dist/game.js', 'dist/app.js',
      'src/main.js', 'src/index.js', 'src/game.js', 'src/app.js',
      'js/main.js', 'js/game.js', 'js/app.js'
    ];
    const scripts = files.filter(file => ['.js', '.mjs'].includes(extensionOf(file.path)));
    const entry = preferredEntrypoints.map(candidate => scripts.find(file => file.path.toLowerCase() === candidate))
      .find(Boolean) || scripts.find(file => /(^|\/)(index|main|game|app)\.(mjs|js)$/i.test(file.path));
    if (entry) {
      const entryRef = '../' + entry.path.split('/').map(encodeURIComponent).join('/');
      const entryDirectory = entry.path.includes('/') ? entry.path.split('/').slice(0, -1).join('/') : '';
      const styles = files.filter(file => extensionOf(file.path) === '.css')
        .sort((a, b) => Number(b.path.startsWith(entryDirectory ? entryDirectory + '/' : '__never__')) - Number(a.path.startsWith(entryDirectory ? entryDirectory + '/' : '__never__')))
        .slice(0, 12)
        .map(file => '<link rel="stylesheet" href="../' + file.path.split('/').map(encodeURIComponent).join('/') + '">')
        .join('');
      const shell = '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark light"><title>Juego · Swarm ZIP Lab</title>' + styles + '</head><body style="margin:0;min-height:100vh"><script type="module" src="' + entryRef + '"></script></body></html>';
      files.push({ path: '__swarm_preview__/index.html', content: Buffer.from(shell), size: Buffer.byteLength(shell), contentType: MIME_TYPES['.html'], generated: true });
      pages = [files[files.length - 1]];
    } else {
      if (!files.length) throw new Error('El ZIP no contiene archivos web compatibles para previsualizar.');
      throw new Error('No encontramos index.html ni un punto de entrada JavaScript reconocido. Si es un proyecto Vite/React/Vue, subí el ZIP de la carpeta de compilación (dist/build) o incluí el HTML generado; no se instalan dependencias npm automáticamente.');
    }
  }
  files.forEach((file, index) => { file.index = index; });
  pages.sort((a, b) => Number(/(^|\/)index\.html?$/i.test(b.path)) - Number(/(^|\/)index\.html?$/i.test(a.path)));
  return { files, pages: pages.map(file => ({ index: file.index, path: file.path })), totalExpandedBytes: expandedTotal };
}

export function previewMimeType(filePath) {
  return MIME_TYPES[extensionOf(String(filePath || ''))] || 'text/plain; charset=utf-8';
}
