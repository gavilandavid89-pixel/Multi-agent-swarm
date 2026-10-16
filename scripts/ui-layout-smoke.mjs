import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const publicDir = path.join(root, 'apps/web/public');
const chrome = process.env.CHROME_BIN || 'chromium';
const sourceHtml = readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace(/<script src="\/app\.js[^"]*" defer><\/script>\s*/g, '')
  .replace(/<script src="\/invite-gate\.js[^"]*" defer><\/script>\s*/g, '');
const injected = `
<pre id="layout-result" hidden></pre>
<script>
  document.body.classList.remove('auth-gate');
  document.getElementById('access-panel').classList.add('hidden');
  document.getElementById('api-settings-panel').classList.add('hidden');
  document.getElementById('app-content').classList.remove('hidden');
  document.getElementById('welcome-chat').classList.add('hidden');
  document.getElementById('detail-panel').classList.remove('hidden');
  const conversation = document.getElementById('conversation');
  conversation.innerHTML = Array.from({length: 36}, (_, i) =>
    '<article class="chat-message"><div class="agent-avatar">A</div><div class="message-body"><div class="message-heading"><strong>Agent ' + (i % 6 + 1) + '</strong><span>Working</span></div><div class="message-text">A long sample message checks that history scrolls inside the chat without moving the whole page. Message ' + i + '.</div></div></article>'
  ).join('');
  window.addEventListener('load', () => requestAnimationFrame(() => requestAnimationFrame(() => {
    const conversation = document.getElementById('conversation');
    const composer = document.querySelector('#app-content > .composer');
    const composerRect = composer.getBoundingClientRect();
    const report = {
      width: window.innerWidth,
      height: window.innerHeight,
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      rootScrollHeight: document.documentElement.scrollHeight,
      bodyScrollHeight: document.body.scrollHeight,
      conversationOverflowY: getComputedStyle(conversation).overflowY,
      conversationHeight: conversation.clientHeight,
      conversationScrollable: conversation.scrollHeight > conversation.clientHeight,
      composerTop: Math.round(composerRect.top),
      composerBottom: Math.round(composerRect.bottom),
      composerVisible: composerRect.top >= 0 && composerRect.bottom <= window.innerHeight + 2,
      detailHeight: Math.round(document.getElementById('detail-panel').getBoundingClientRect().height),
      detailChildren: Array.from(document.getElementById('detail-panel').children).map(element => ({
        id: element.id || element.className || element.tagName.toLowerCase(),
        height: Math.round(element.getBoundingClientRect().height),
        display: getComputedStyle(element).display,
        flex: getComputedStyle(element).flex
      }))
    };
    document.getElementById('layout-result').textContent = btoa(JSON.stringify(report));
  })));
</script>`;
const html = sourceHtml.replace('</body>', injected + '\n</body>');
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/__layout-test') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  } else if (url.pathname === '/styles.css') {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
    res.end(readFileSync(path.join(publicDir, 'styles.css')));
  } else {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function launchChrome(profile) {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--disable-extensions', '--no-first-run', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('Timed out waiting for Chromium DevTools.'));
    }, 15000);
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ child, websocketUrl: match[1] });
      }
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Chromium exited ${code} before DevTools was ready: ${stderr.slice(-1600)}`));
    });
  });
}

async function connectDevTools(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || 'DevTools command failed'));
    else waiter.resolve(message.result || {});
  });
  return {
    socket,
    send(method, params = {}, sessionId) {
      const id = ++nextId;
      const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify(payload));
      });
    }
  };
}

async function runViewport(url, profile, width, height, orientation) {
  const { child, websocketUrl } = await launchChrome(profile);
  let devtools;
  try {
    devtools = await connectDevTools(websocketUrl);
    const target = await devtools.send('Target.createTarget', { url: 'about:blank' });
    const attached = await devtools.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId;
    await devtools.send('Page.enable', {}, sessionId);
    await devtools.send('Runtime.enable', {}, sessionId);
    await devtools.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: height
    }, sessionId);
    await devtools.send('Page.navigate', { url }, sessionId);

    let encoded = '';
    for (let attempt = 0; attempt < 80; attempt++) {
      const result = await devtools.send('Runtime.evaluate', {
        expression: "document.getElementById('layout-result')?.textContent || ''",
        returnByValue: true
      }, sessionId);
      encoded = result.result?.value || '';
      if (encoded) break;
      await delay(50);
    }
    if (!encoded) throw new Error(`Chromium did not return a layout report for ${orientation}.`);
    const report = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    const issues = [];
    if (report.width !== width || report.height !== height) issues.push(`viewport is ${report.width}x${report.height}, expected ${width}x${height}`);
    if (report.bodyOverflowY !== 'hidden') issues.push(`body overflow-y is ${report.bodyOverflowY}`);
    if (report.rootScrollHeight > height + 2) issues.push(`document scroll height ${report.rootScrollHeight} > viewport ${height}`);
    if (report.bodyScrollHeight > height + 2) issues.push(`body scroll height ${report.bodyScrollHeight} > viewport ${height}`);
    if (report.conversationOverflowY !== 'auto') issues.push(`conversation overflow-y is ${report.conversationOverflowY}`);
    if (report.conversationHeight < 80) issues.push(`conversation is too short: ${report.conversationHeight}px`);
    if (!report.conversationScrollable) issues.push('conversation did not become its own scroll region');
    if (!report.composerVisible) issues.push(`composer is outside viewport (${report.composerTop}–${report.composerBottom}px)`);
    if (issues.length) throw new Error(`${orientation} layout failed: ${issues.join('; ')}. Report: ${JSON.stringify(report)}`);
    console.log(`PASS ${orientation}: ${width}x${height}; page locked, conversation scrolls independently, composer visible.`);
  } finally {
    try { devtools?.socket.close(); } catch {}
    child.kill('SIGTERM');
  }
}

const profile = mkdtempSync(path.join(tmpdir(), 'swarm-layout-'));
try {
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/__layout-test`;
  await runViewport(url, path.join(profile, 'portrait'), 390, 844, 'portrait');
  await runViewport(url, path.join(profile, 'landscape'), 844, 390, 'landscape');
} finally {
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
