import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { timingSafeEqual, createHmac, randomBytes } from 'node:crypto';
import { handleBrowserToolRequest } from './browser-control.js';

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
  if (requestUrl.pathname === '/internal/browser-tool') {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
      res.end('Method not allowed\\n');
      return;
    }
    const suppliedSecret = req.headers['x-swarm-desktop-secret'] || '';
    if (activitySecret.length < 32 || !equalSecret(String(suppliedSecret), activitySecret)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: 'No autorizado.' }));
      return;
    }
    await handleBrowserToolRequest(req, res);
    return;
  }
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
    res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
    res.end('Method not allowed\\n');
    return;
  }
  if (requestUrl.pathname === '/api/agent-activity') {
    if (!activityUrl || activitySecret.length < 32) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: 'Feed de actividad no configurado.' }));
      return;
    }
    try {
      const upstreamResponse = await fetch(activityUrl + '/internal/desktop-activity', {
        headers: { 'x-swarm-desktop-secret': activitySecret, accept: 'application/json' },
        signal: AbortSignal.timeout(5000)
      });
      const body = await upstreamResponse.text();
      res.writeHead(upstreamResponse.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(body.slice(0, 200000));
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: 'No se pudo recuperar la actividad del motor.' }));
    }
    return;
  }
  if (requestUrl.pathname === '/' || requestUrl.pathname === '/activity') {
    const page = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Swarm · Escritorio y actividad</title><style>
      *{box-sizing:border-box}body{margin:0;background:#0d1117;color:#e6edf3;font:14px system-ui,sans-serif}header{padding:14px 18px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}h1{font-size:17px;margin:0}small,.muted{color:#9da7b3}.layout{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(280px,1fr);gap:12px;padding:12px;height:calc(100vh - 62px)}section{min-width:0;min-height:0;background:#151b23;border:1px solid #30363d;border-radius:10px;overflow:hidden}.section-title{padding:12px 14px;border-bottom:1px solid #30363d;font-weight:650}.desktop{width:100%;height:calc(100% - 45px);border:0;background:#080b10}.feed{height:calc(100% - 45px);overflow:auto;padding:10px}.job{border:1px solid #30363d;border-radius:8px;padding:10px;margin-bottom:9px;background:#10151c}.jobhead{display:flex;justify-content:space-between;gap:8px}.jobtitle{font-weight:650;overflow-wrap:anywhere}.status{font-size:11px;padding:3px 7px;border-radius:99px;background:#30363d;white-space:nowrap}.running{background:#164e63}.completed{background:#14532d}.failed,.needs_review{background:#7f1d1d}.stage{margin:7px 0;color:#aab4c0}.event{font-size:12px;border-left:2px solid #465363;padding:5px 8px;margin:5px 0;white-space:pre-wrap;overflow-wrap:anywhere}.empty{padding:16px;color:#9da7b3}.actions{display:flex;gap:8px;align-items:center}a{color:#7dd3fc}@media(max-width:850px){.layout{height:auto;grid-template-columns:1fr}.desktop{height:55vh}.feed{height:45vh}header{align-items:flex-start}}
      </style></head><body><header><div><h1>SWARM / Escritorio virtual</h1><small>Sesión protegida · actividad real consultada al Bridge</small></div><div class="actions"><span id="updated" class="muted">Conectando…</span><a href="/vnc.html" target="_blank" rel="noopener">Abrir escritorio solo ↗</a></div></header><main class="layout"><section><div class="section-title">Chromium remoto · Xvfb / noVNC</div><iframe class="desktop" src="/vnc.html" title="Escritorio Chromium remoto" referrerpolicy="no-referrer"></iframe></section><section><div class="section-title">Actividad real de agentes · actualización cada 5 s</div><div id="feed" class="feed"><div class="empty">Cargando tareas del motor…</div></div></section></main><script>
      const feed=document.getElementById('feed'),updated=document.getElementById('updated');const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      async function refresh(){try{const r=await fetch('/api/agent-activity',{cache:'no-store'});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Feed no disponible');updated.textContent='Actualizado '+new Date(d.updatedAt||Date.now()).toLocaleTimeString();if(!d.jobs.length){feed.innerHTML='<div class="empty">El motor no informó tareas todavía.</div>';return}feed.innerHTML=d.jobs.map(j=>'<article class="job"><div class="jobhead"><div class="jobtitle">'+esc(j.title)+'</div><span class="status '+esc(j.status)+'">'+esc(j.status)+'</span></div><div class="stage">'+esc(j.stage)+' · '+esc(j.id)+'</div>'+((j.agents||[]).map(a=>'<div class="event"><b>'+esc(a.agent)+' · '+esc(a.type)+'</b> '+esc(a.at?new Date(a.at).toLocaleTimeString():'')+'<br>'+esc(a.summary)+'</div>').join('')||'<div class="muted">Sin eventos de conversación registrados.</div>')+'</article>').join('')}catch(e){updated.textContent='Feed sin conexión';feed.innerHTML='<div class="empty">'+esc(e.message)+'<br><small>Verificá la configuración segura de actividad en Bridge y visor.</small></div>'}}refresh();setInterval(refresh,5000);
      </script></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "frame-ancestors 'none'; default-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'" });
    res.end(page);
    return;
  }
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
