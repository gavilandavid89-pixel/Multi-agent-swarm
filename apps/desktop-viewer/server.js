import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';

const port = Number(process.env.PORT || 3300);
const username = process.env.VIEWER_ADMIN_USERNAME || '';
const password = process.env.VIEWER_ADMIN_PASSWORD || '';
const upstreamPort = Number(process.env.NOVNC_INTERNAL_PORT || 6080);
const display = process.env.DISPLAY || ':99';
const children = [];
const failedProcesses = new Set();
let stopping = false;

function log(event, details = {}) {
  console.info(JSON.stringify({ at: new Date().toISOString(), service: 'desktop-viewer', event, ...details }));
}

function start(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  children.push(child);
  child.stdout.on('data', data => log('process_stdout', { process: command, message: String(data).slice(0, 500) }));
  child.stderr.on('data', data => log('process_stderr', { process: command, message: String(data).slice(0, 500) }));
  child.on('error', error => {
    failedProcesses.add(command);
    log('process_error', { process: command, error: String(error.message).slice(0, 200) });
    if (!stopping) process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    log('process_exit', { process: command, code, signal });
    if (!stopping) {
      failedProcesses.add(command);
      process.exitCode = 1;
    }
  });
  return child;
}

function equalSecret(actual, expected) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req) {
  if (!username || password.length < 24) return false;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const split = decoded.indexOf(':');
  if (split < 0) return false;
  return equalSecret(decoded.slice(0, split), username) && equalSecret(decoded.slice(split + 1), password);
}

function challenge(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Swarm admin desktop", charset="UTF-8"',
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8'
  });
  res.end('Acceso exclusivo para el administrador.\n');
}

function startDesktop() {
  start('Xvfb', [display, '-screen', '0', '1440x900x24', '-nolisten', 'tcp', '-ac']);
  start('x11vnc', ['-display', display, '-localhost', '-forever', '-shared', '-rfbport', '5900', '-nopw']);
  start('websockify', ['--web', '/usr/share/novnc', '127.0.0.1:' + upstreamPort, '127.0.0.1:5900']);
  start('chromium', [
    '--no-first-run',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-sync',
    '--no-default-browser-check',
    '--user-data-dir=/tmp/swarm-viewer-chrome',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9222',
    '--window-size=1360,820',
    'about:blank'
  ], { env: { ...process.env, DISPLAY: display } });
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    const ok = failedProcesses.size === 0 && children.length === 4 && children.every(child => child.exitCode === null);
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok,
      viewer: 'live-desktop',
      authenticated: Boolean(username && password.length >= 24),
      failedProcesses: [...failedProcesses]
    }));
    return;
  }
  if (!authorized(req)) return challenge(res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
    res.end('Method not allowed\n');
    return;
  }
  const upstream = http.request({
    host: '127.0.0.1',
    port: upstreamPort,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: '127.0.0.1:' + upstreamPort, authorization: undefined }
  }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 502, {
      ...upstreamRes.headers,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "frame-ancestors 'none'"
    });
    upstreamRes.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Cache-Control': 'no-store' });
    res.end('Desktop viewer upstream unavailable\n');
  });
  req.pipe(upstream);
});

server.on('upgrade', (req, client, head) => {
  if (!authorized(req)) {
    client.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Swarm admin desktop"\r\nConnection: close\r\n\r\n');
    client.destroy();
    return;
  }
  if (!req.url?.startsWith('/websockify')) {
    client.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    client.destroy();
    return;
  }
  const upstream = net.connect(upstreamPort, '127.0.0.1', () => {
    const headers = Object.entries(req.headers)
      .filter(([key]) => key.toLowerCase() !== 'authorization' && key.toLowerCase() !== 'proxy-authorization')
      .map(([key, value]) => key + ': ' + value);
    upstream.write(req.method + ' ' + req.url + ' HTTP/' + (req.httpVersion || '1.1') + '\r\n' + headers.join('\r\n') + '\r\n\r\n');
    if (head?.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
});

function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => {
    for (const child of children) {
      try { if (child.exitCode === null) child.kill('SIGKILL'); } catch {}
    }
    process.exit(0);
  }, 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (!username || password.length < 24) {
  console.error('VIEWER_ADMIN_USERNAME and VIEWER_ADMIN_PASSWORD (at least 24 characters) are required; refusing to start.');
  process.exit(1);
}

startDesktop();
server.listen(port, '0.0.0.0', () => log('listening', { port, display, upstreamPort }));
