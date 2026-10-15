import dns from 'node:dns';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

const blockedIPv4 = new BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blockedIPv4.addSubnet(subnet, prefix, 'ipv4');

const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');
const blockedIPv6 = new BlockList();
for (const [subnet, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ['::ffff:0:0', 96], ['::', 128], ['::1', 128], ['fc00::', 7],
  ['fe80::', 10], ['ff00::', 8]
]) blockedIPv6.addSubnet(subnet, prefix, 'ipv6');

export function isPublicProviderAddress(address) {
  const family = isIP(String(address || ''));
  if (family === 4) return !blockedIPv4.check(address, 'ipv4');
  if (family === 6) return globalIPv6.check(address, 'ipv6') && !blockedIPv6.check(address, 'ipv6');
  return false;
}

function validateTarget(input) {
  let url;
  try { url = new URL(input); }
  catch { throw new Error('La URL del proveedor personalizado no es válida.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (url.port && url.port !== '443') || isIP(host) ||
      !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/i.test(host) ||
      host.endsWith('.')) {
    throw new Error('La API personalizada debe usar un dominio público HTTPS, sin credenciales ni parámetros en la URL.');
  }
  return url;
}

function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses?.length || addresses.some(item => !isPublicProviderAddress(item.address))) {
      return callback(new Error('El host del proveedor personalizado no resuelve exclusivamente a direcciones IP públicas.'));
    }
    const lookupOptions = options && typeof options === 'object' ? options : { family: Number(options) || 0 };
    const candidates = lookupOptions.family
      ? addresses.filter(item => item.family === lookupOptions.family)
      : addresses;
    if (!candidates.length) return callback(new Error('El proveedor no tiene una dirección pública compatible con la conexión.'));
    if (lookupOptions.all) return callback(null, candidates);
    callback(null, candidates[0].address, candidates[0].family);
  });
}

/**
 * Fetch an OpenAI-compatible public HTTPS endpoint while pinning each DNS lookup
 * to validated public addresses. Redirects are not followed, preventing a
 * provider from forwarding credentials to a different host.
 */
export async function safeProviderFetch(input, options = {}) {
  const url = validateTarget(input);
  const method = String(options.method || 'GET').toUpperCase();
  const headers = options.headers || {};
  const signal = options.signal;
  const body = options.body;
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method,
      headers,
      signal,
      maxHeaderSize: 16 * 1024,
      lookup: publicLookup,
      servername: url.hostname
    }, response => {
      const chunks = [];
      let totalBytes = 0;
      let failed = false;
      response.on('data', chunk => {
        if (failed) return;
        totalBytes += chunk.length;
        if (totalBytes > 8 * 1024 * 1024) {
          failed = true;
          request.destroy(new Error('La respuesta del proveedor supera el límite de 8 MB.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (failed) return;
        const text = Buffer.concat(chunks).toString('utf8');
        const responseHeaders = {
          get(name) {
            const value = response.headers[String(name).toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : (value ?? null);
          }
        };
        const status = Number(response.statusCode) || 502;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: response.statusMessage || '',
          headers: responseHeaders,
          text: async () => text,
          json: async () => JSON.parse(text)
        });
      });
    });
    request.on('error', reject);
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}
