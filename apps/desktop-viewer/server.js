import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { timingSafeEqual, createHmac, randomBytes } from 'node:crypto';

const port = Number(process.env.PORT || 3300);
const username = process.env.VIEWER_ADMIN_USERNAME || '';
const password = process.env.VIEWER_ADMIN_PASSWORD || '';
const ticketSecret = process.env.DESKTOP_VIEWER_TICKET_SECRET || '';
const activityUrl = (process.env.DESKTOP_ACTIVITY_URL || '').replace(/\/$/, '');
const activitySecret = process.env.DESKTOP_ACTIVITY_SHARED_SECRET || '';
const ticketSessions = new Map();
const upstreamPort = Number(process.env.NOVNC_INTERNAL_PORT || 6080);
const vncPort = Number(process.env.VNC_INTERNAL_PORT || 5900);
const chromiumDebugPort = Number(process.env.CHROMIUM_DEBUG_PORT || 9222);
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

function safeEqualText(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
function parseSigned(value) {
  if (!ticketSecret || ticketSecret.length < 32 || typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot); const signature = value.slice(dot + 1);
  const expected = createHmac('sha256', ticketSecret).update(payload).digest('base64url');
  if (!safeEqualText(signature, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.aud !== 'swarm-desktop-viewer' || data.role !== 'admin' || !Number.isFinite(data.exp) || data.exp <= Date.now()) return null;
    return data;
  } catch { return null; }
}
function authorized(req) {
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => {
    const index = part.indexOf('='); return index < 0 ? ['', ''] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter(([key]) => key));
  const session = parseSigned(cookies.swarm_admin_viewer);
  if (session) return true;
  if (ticketSecret.length >= 32) return false; // Once SSO is configured, Basic auth must not bypass the Bridge admin role.
  if (!username || password.length < 24) return false;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const split = decoded.indexOf(':');
  if (split < 0) return false;
  return equalSecret(decoded.slice(0, split), username) && equalSecret(decoded.slice(split + 1), password);
}
function signedSession(data) {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + 60 * 60 * 1000 })).toString('base64url');
  return payload + '.' + createHmac('sha256', ticketSecret).update(payload).digest('base64url');
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
  start('x11vnc', ['-display', display, '-localhost', '-forever', '-shared', '-rfbport', String(vncPort), '-nopw']);
  start('websockify', ['--web', '/usr/share/novnc', '127.0.0.1:' + upstreamPort, '127.0.0.1:' + vncPort]);
  start('chromium', [
    '--no-first-run',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-sync',
    '--no-default-browser-check',
    '--user-data-dir=/tmp/swarm-viewer-chrome',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${chromiumDebugPort}`,
    '--window-size=1360,820',
    'about:blank'
  ], { env: { ...process.env, DISPLAY: display } });
}

async function tcpReady(targetPort, timeoutMs = 350) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: targetPort });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function chromiumReady() {
  try {
    const response = await fetch(`http://127.0.0.1:${chromiumDebugPort}/json/version`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return false;
    const data = await response.json();
    return typeof data.Browser === 'string' && data.Browser.length > 0;
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', 'http://viewer.local');
  if (requestUrl.pathname === '/' && requestUrl.searchParams.has('ticket')) {
    const claims = parseSigned(requestUrl.searchParams.get('ticket'));
    const now = Date.now();
    for (const [jti, expiry] of ticketSessions) if (expiry <= now) ticketSessions.delete(jti);
    if (!claims || claims.aud !== 'swarm-desktop-viewer' || typeof claims.jti !== 'string' || !claims.jti || ticketSessions.has(claims.jti)) {
      res.writeHead(401, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('El enlace de administrador venció o no es válido. Volvé a abrir el escritorio desde Swarm.\\n');
      return;
    }
    // Consume each short-lived Bridge ticket once to prevent replay.
    ticketSessions.set(claims.jti, claims.exp);
    const cookie = signedSession({ sub: claims.sub, role: 'admin', aud: 'swarm-desktop-viewer' });
    res.writeHead(303, { Location: '/', 'Set-Cookie': `swarm_admin_viewer=${cookie}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
    return;
  }
  if (req.url === '/healthz') {
    const alive = failedProcesses.size === 0 && children.length === 4 && children.every(child => child.exitCode === null);
    const [vncReady, noVncReady, chromeReady] = await Promise.all([tcpReady(vncPort), tcpReady(upstreamPort), chromiumReady()]);
    const checks = { processes: alive, vnc: vncReady, noVnc: noVncReady, chromium: chromeReady };
    const ok = Object.values(checks).every(Boolean);
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok,
      viewer: 'live-desktop',
      authenticated: ticketSecret.length >= 32 || Boolean(username && password.length >= 24),
      checks,
      failedProcesses: [...failedProcesses]
    }));
    return;
  }
  if (!authorized(req)) return challenge(res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
  const upstream = http.request({
    host: '127.0.0.1',
    port: upstreamPort,
    method: req.method,
    path: req.url,
    headers: {
      ...Object.fromEntries(Object.entries(req.headers)
        .filter(([key]) => key.toLowerCase() !== 'authorization' && key.toLowerCase() !== 'proxy-authorization')),
      host: '127.0.0.1:' + upstreamPort
    }
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
    client.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Swarm admin desktop"\r\nConnection: close\r\n\r\n');
    return;
  }
  if (!req.url?.startsWith('/websockify')) {
    client.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
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

if ((!username || password.length < 24) && (!ticketSecret || ticketSecret.length < 32)) {
  console.error('Configure DESKTOP_VIEWER_TICKET_SECRET (32+ chars) for Bridge SSO, or VIEWER_ADMIN_USERNAME plus VIEWER_ADMIN_PASSWORD (24+ chars) for standalone mode.');
  process.exit(1);
}

startDesktop();
server.listen(port, '0.0.0.0', () => log('listening', { port, display, upstreamPort }));
