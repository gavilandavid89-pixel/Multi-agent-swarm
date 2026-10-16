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
    '<article class="chat-message"><div class="agent-avatar">A</div><div class="message-body"><div class="message-heading"><strong>Agente ' + (i % 6 + 1) + '</strong><span>Trabajando</span></div><div class="message-text">Prueba de mensaje largo para verificar que el historial se desplaza dentro del chat y no mueve toda la página. Mensaje ' + i + '.</div></div></article>'
  ).join('');
  window.addEventListener('load', () => requestAnimationFrame(() => requestAnimationFrame(() => {
    const conversation = document.getElementById('conversation');
    const composer = document.querySelector('#app-content > .composer');
    const body = document.body;
    const root = document.documentElement;
    const composerRect = composer.getBoundingClientRect();
    const report = {
      width: window.innerWidth,
      height: window.innerHeight,
      bodyOverflowY: getComputedStyle(body).overflowY,
      rootScrollHeight: root.scrollHeight,
      bodyScrollHeight: body.scrollHeight,
      conversationOverflowY: getComputedStyle(conversation).overflowY,
      conversationHeight: conversation.clientHeight,
      conversationScrollable: conversation.scrollHeight > conversation.clientHeight,
      composerTop: Math.round(composerRect.top),
      composerBottom: Math.round(composerRect.bottom),
      composerVisible: composerRect.top >= 0 && composerRect.bottom <= window.innerHeight + 2
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

function runChrome(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Chromium exited ${code}: ${stderr.slice(-1800)}`));
      else resolve(stdout);
    });
  });
}

const profile = mkdtempSync(path.join(tmpdir(), 'swarm-layout-'));
try {
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/__layout-test`;
  for (const [width, height, orientation] of [[390, 844, 'portrait'], [844, 390, 'landscape']]) {
    const dom = await runChrome([
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--disable-extensions', '--no-first-run', '--hide-scrollbars',
      `--user-data-dir=${path.join(profile, orientation)}`,
      `--window-size=${width},${height}`, '--virtual-time-budget=1500', '--dump-dom', url
    ]);
    const encoded = dom.match(/<pre id="layout-result"[^>]*>([A-Za-z0-9+/=]*)<\/pre>/);
    if (!encoded?.[1]) throw new Error(`Chromium did not return a layout report for ${orientation}.`);
    const report = JSON.parse(Buffer.from(encoded[1], 'base64').toString('utf8'));
    const issues = [];
    if (report.bodyOverflowY !== 'hidden') issues.push(`body overflow-y is ${report.bodyOverflowY}`);
    if (report.rootScrollHeight > report.height + 2) issues.push(`document scroll height ${report.rootScrollHeight} > viewport ${report.height}`);
    if (report.bodyScrollHeight > report.height + 2) issues.push(`body scroll height ${report.bodyScrollHeight} > viewport ${report.height}`);
    if (report.conversationOverflowY !== 'auto') issues.push(`conversation overflow-y is ${report.conversationOverflowY}`);
    if (report.conversationHeight < 80) issues.push(`conversation is too short: ${report.conversationHeight}px`);
    if (!report.conversationScrollable) issues.push('conversation did not become its own scroll region');
    if (!report.composerVisible) issues.push(`composer is outside viewport (${report.composerTop}–${report.composerBottom}px)`);
    if (issues.length) throw new Error(`${orientation} layout failed: ${issues.join('; ')}. Report: ${JSON.stringify(report)}`);
    console.log(`PASS ${orientation}: ${report.width}x${report.height}; page locked, conversation scrolls independently, composer visible.`);
  }
} finally {
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
