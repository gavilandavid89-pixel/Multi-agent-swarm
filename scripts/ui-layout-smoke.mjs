import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const publicDir = path.join(root, 'apps/web/public');
const chrome = process.env.CHROME_BIN || 'chromium';
const appSource = readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const cSource = readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
if (!appSource.includes("document.body.classList.add('swarm-home-scroll')") ||
    !appSource.includes("document.body.classList.add('swarm-task-mode', 'swarm-chat-fullscreen', 'swarm-task-chat')")) {
  throw new Error('Home must keep global touch scrolling, while task chat opens as a full-screen surface.');
}
if (!appSource.includes("if (state.currentDetailId) {") ||
    !appSource.includes("Continuando la tarea abierta con su historial y archivos…") ||
    !appSource.includes("state.currentDetailId)}/reply")) {
  throw new Error('Sending from an open task must continue that same task instead of creating a new job.');
}
if (!cSource.includes('body.swarm-home-scroll') || !cSource.includes('overflow-y: auto !important') ||
    !cSource.includes('body.swarm-task-mode:not(.swarm-home-scroll) #detail-panel:not(.hidden)')) {
  throw new Error('Responsive layout must support global home scrolling and a full-screen task conversation.');
}
const menuClickHandlers = appSource.split("$('account-menu-toggle').addEventListener('click'").length - 1;
if (menuClickHandlers !== 1) throw new Error(`Expected exactly one account-menu click handler, found ${menuClickHandlers}.`);
const menuHandlerStart = appSource.indexOf("$('account-menu-toggle').addEventListener('click'");
const menuHandlerEnd = appSource.indexOf("\n$('account-menu-items').addEventListener('click'", menuHandlerStart);
const menuHandler = appSource.slice(menuHandlerStart, menuHandlerEnd);
if (!menuHandler.includes('event.stopPropagation()') || !menuHandler.includes("items.classList.toggle('hidden', !opening)") || !menuHandler.includes("setAttribute('aria-expanded', String(opening))")) {
  throw new Error('Account three-dot menu must stop bubbling, toggle its items, and update aria-expanded.');
}
if (!appSource.includes("event.key === 'Enter' && !event.shiftKey") || !appSource.includes('resizeObjectiveInput')) {
  throw new Error('Chat composer must support Enter-to-send and controlled automatic height.');
}
if (!appSource.includes("window.addEventListener('orientationchange'") || !appSource.includes('visualViewport?.addEventListener')) {
  throw new Error('Mobile viewport must resync after orientation and visual viewport changes.');
}
if (!appSource.includes("if (resetScroll && !document.body.classList.contains('auth-gate'))") ||
    !appSource.includes("window.addEventListener('orientationchange', () => scheduleViewportSync(true)") ||
    !appSource.includes("window.addEventListener('resize', () => scheduleViewportSync(),")) {
  throw new Error('Mobile keyboard/viewport resizing must not force scroll-to-top; only orientation changes may reset the page position.');
}
if (!appSource.includes("$('task-history-toggle').addEventListener('click'") || !appSource.includes("append(historyPanel)")) {
  throw new Error('Task history must be reachable only from the task workspace and moved to its drawer.');
}
if (appSource.includes("$('open-history-menu').addEventListener('click'")) {
  throw new Error('Task history must not be placed in the global three-dot menu.');
}
if (!appSource.includes('function showChatListView()') || !appSource.includes('function showChatConversationView()')) {
  throw new Error('Independent chats need distinct list and conversation views.');
}
if (!appSource.includes("const taskTitle = job.title") || !appSource.includes("job.title || `Tarea ${job.id.slice(0,8)}`")) {
  throw new Error('Task titles must appear automatically in the conversation and activity/history lists.');
}
if (!appSource.includes("$('jump-to-latest')?.addEventListener('click'") || !appSource.includes('conversation.scrollTop += anchor.getBoundingClientRect().top - anchorTop')) {
  throw new Error('Chat must preserve the reading position and provide a jump-to-latest control.');
}
if (!appSource.includes('file.version || file.updatedAt') || !appSource.includes('if (artifactsChanged) {')) {
  throw new Error('Artifact rows must update only when file content changes, avoiding preview/list flicker.');
}
if (!appSource.includes("['vos', 'usuario', 'user', 'tú'].includes(agent.toLocaleLowerCase('es'))")) {
  throw new Error('Messages from the user must render using the user-side chat bubble style.');
}
if (!appSource.includes("setProperty('--swarm-viewport-top'") || !appSource.includes("setProperty('--swarm-viewport-height'")) {
  throw new Error('Mobile keyboard and orientation handling must use the visual viewport dimensions.');
}
const styleSource = readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
if (!styleSource.includes('touch-action:pan-y') || !styleSource.includes('.agent-vos .message-body') || !styleSource.includes('.jump-to-latest')) {
  throw new Error('Drawers must be touch-scrollable, user messages right-aligned, and latest-message navigation visible.');
}

const sourceHtml = readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace(/<script src="\/app\.js[^"]*" defer><\/script>\s*/g, '')
  .replace(/<script src="\/invite-gate\.js[^"]*" defer><\/script>\s*/g, '');
if (!sourceHtml.includes('id="task-history-toggle"') || sourceHtml.includes('id="open-history-menu"') || !sourceHtml.includes('id="history-drawer"')) {
  throw new Error('Task history must have a task-only entry and matching drawer, not a global menu entry.');
}
if (!sourceHtml.includes('id="new-chat-button"') || !sourceHtml.includes('id="chat-thread-view" class="chat-thread hidden"')) {
  throw new Error('The home screen must list conversations without exposing the message composer until a conversation is opened.');
}
const injected = `
<pre id="layout-result" hidden></pre>
<script>
  document.body.classList.remove('auth-gate');
  document.getElementById('access-panel').classList.add('hidden');
  document.getElementById('api-settings-panel').classList.add('hidden');
  document.getElementById('app-content').classList.remove('hidden');
  document.getElementById('files-menu-toggle').classList.remove('hidden');
  document.getElementById('task-history-toggle').classList.remove('hidden');
  document.getElementById('account-menu').classList.remove('hidden');
  document.getElementById('account-menu-items').classList.remove('hidden');
  document.getElementById('welcome-chat').classList.add('hidden');
  document.getElementById('detail-panel').classList.remove('hidden');
  const conversation = document.getElementById('conversation');
  conversation.innerHTML = Array.from({length: 36}, (_, i) =>
    '<article class="chat-message"><div class="agent-avatar">A</div><div class="message-body"><div class="message-heading"><strong>Agent ' + (i % 6 + 1) + '</strong><span>Working</span></div><div class="message-text">A long sample message checks that history scrolls inside the chat without moving the whole page. Message ' + i + '.</div></div></article>'
  ).join('');
  window.__measureSwarmLayout = () => {
    const conversation = document.getElementById('conversation');
    const composer = document.querySelector('#app-content > .composer');
    const composerRect = composer.getBoundingClientRect();
    const report = {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollY: window.scrollY,
      shellTop: Math.round(document.querySelector('.shell').getBoundingClientRect().top),
      topbarTop: Math.round(document.querySelector('.topbar').getBoundingClientRect().top),
      topbarBottom: Math.round(document.querySelector('.topbar').getBoundingClientRect().bottom),
      accountToggleTop: Math.round(document.getElementById('account-menu-toggle').getBoundingClientRect().top),
      accountToggleBottom: Math.round(document.getElementById('account-menu-toggle').getBoundingClientRect().bottom),
      filesButtonTop: Math.round(document.getElementById('files-menu-toggle').getBoundingClientRect().top),
      filesButtonBottom: Math.round(document.getElementById('files-menu-toggle').getBoundingClientRect().bottom),
      historyMenuPresent: Boolean(document.getElementById('task-history-toggle')),
      historyButtonTop: Math.round(document.getElementById('task-history-toggle').getBoundingClientRect().top),
      historyButtonBottom: Math.round(document.getElementById('task-history-toggle').getBoundingClientRect().bottom),
      historyInsideAccountMenu: Boolean(document.getElementById('account-menu-items').contains(document.getElementById('task-history-toggle'))),
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      rootScrollHeight: document.documentElement.scrollHeight,
      bodyScrollHeight: document.body.scrollHeight,
      conversationOverflowY: getComputedStyle(conversation).overflowY,
      conversationHeight: conversation.clientHeight,
      conversationScrollable: conversation.scrollHeight > conversation.clientHeight,
      composerTop: Math.round(composerRect.top),
      composerBottom: Math.round(composerRect.bottom),
      composerPosition: getComputedStyle(composer).position,
      objectiveResize: getComputedStyle(document.getElementById('objective')).resize,
      objectiveHeight: Math.round(document.getElementById('objective').getBoundingClientRect().height),
      menuTogglePresent: Boolean(document.getElementById('account-menu-toggle')),
      menuItemsPresent: Boolean(document.getElementById('account-menu-items')),
      filesButtonPosition: getComputedStyle(document.getElementById('files-menu-toggle')).position,
      filesDrawerPosition: getComputedStyle(document.getElementById('files-drawer')).position,
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
    return report;
  };
  window.addEventListener('load', () => requestAnimationFrame(() => requestAnimationFrame(() => window.__measureSwarmLayout())));
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
    ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let settled = false;
    const inspectOutput = chunk => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ child, websocketUrl: match[1] });
      }
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      reject(new Error('Timed out waiting for Chromium DevTools. Output: ' + output.slice(-1600)));
    }, 30000);
    child.stdout.setEncoding('utf8').on('data', inspectOutput);
    child.stderr.setEncoding('utf8').on('data', inspectOutput);
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
      reject(new Error(`Chromium exited ${code} before DevTools was ready: ${output.slice(-1600)}`));
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
    if (report.shellTop < -1 || report.topbarTop < 0 || report.topbarBottom > height + 2) issues.push(`top bar is outside viewport (${report.topbarTop}–${report.topbarBottom}px)`);
    if (report.accountToggleTop < 0 || report.accountToggleBottom > height + 2) issues.push(`three-dot menu is outside viewport (${report.accountToggleTop}–${report.accountToggleBottom}px)`);
    if (report.filesButtonTop < 0 || report.filesButtonBottom > height + 2) issues.push(`files button is outside viewport (${report.filesButtonTop}–${report.filesButtonBottom}px)`);
    if (!report.historyMenuPresent) issues.push('task workspace has no history control');
    if (report.historyInsideAccountMenu) issues.push('task history must not be inside the global three-dot menu');
    if (report.historyButtonTop < 0 || report.historyButtonBottom > height + 2) issues.push(`task history control is outside viewport (${report.historyButtonTop}–${report.historyButtonBottom}px)`);
    if (report.bodyOverflowY !== 'hidden') issues.push(`body overflow-y is ${report.bodyOverflowY}`);
    if (report.rootScrollHeight > height + 2) issues.push(`document scroll height ${report.rootScrollHeight} > viewport ${height}`);
    if (report.bodyScrollHeight > height + 2) issues.push(`body scroll height ${report.bodyScrollHeight} > viewport ${height}`);
    if (report.conversationOverflowY !== 'auto') issues.push(`conversation overflow-y is ${report.conversationOverflowY}`);
    if (report.conversationHeight < 80) issues.push(`conversation is too short: ${report.conversationHeight}px`);
    if (!report.conversationScrollable) issues.push('conversation did not become its own scroll region');
    if (!report.composerVisible) issues.push(`composer is outside viewport (${report.composerTop}–${report.composerBottom}px)`);
    if (report.composerPosition === 'fixed' || report.composerPosition === 'sticky') issues.push(`composer must stay in normal flow, got position ${report.composerPosition}`);
    if (report.objectiveResize !== 'none') issues.push(`message input must not be manually resizable, got resize ${report.objectiveResize}`);
    if (report.objectiveHeight > 125) issues.push(`message input is too tall at rest: ${report.objectiveHeight}px`);
    if (!report.menuTogglePresent || !report.menuItemsPresent) issues.push('account three-dot menu controls are missing');
    if (report.filesButtonPosition === 'fixed') issues.push('files button must not float over the conversation');
    if (report.filesDrawerPosition === 'fixed') issues.push('files drawer must be anchored to the app shell, not the viewport');
    if (issues.length) throw new Error(`${orientation} layout failed: ${issues.join('; ')}. Report: ${JSON.stringify(report)}`);
    console.log(`PASS ${orientation}: ${width}x${height}; page locked, conversation scrolls independently, composer visible.`);
    const rotationSizes = [[width, height], [height, width], [width, height], [height, width], [width, height]];
    for (let cycle = 0; cycle < rotationSizes.length; cycle++) {
      const [cycleWidth, cycleHeight] = rotationSizes[cycle];
      await devtools.send('Emulation.setDeviceMetricsOverride', {
        width: cycleWidth, height: cycleHeight, deviceScaleFactor: 1, mobile: true,
        screenWidth: cycleWidth, screenHeight: cycleHeight
      }, sessionId);
      await delay(180);
      await devtools.send('Runtime.evaluate', { expression: "window.__measureSwarmLayout?.()", returnByValue: true }, sessionId);
      const measured = await devtools.send('Runtime.evaluate', {
        expression: "document.getElementById('layout-result')?.textContent || ''", returnByValue: true
      }, sessionId);
      const encodedAfterRotation = measured.result?.value || '';
      if (!encodedAfterRotation) throw new Error(`Missing layout report after rotation ${cycle + 1} (${cycleWidth}x${cycleHeight}).`);
      const rotated = JSON.parse(Buffer.from(encodedAfterRotation, 'base64').toString('utf8'));
      const rotationIssues = [];
      if (rotated.width !== cycleWidth || rotated.height !== cycleHeight) rotationIssues.push(`viewport is ${rotated.width}x${rotated.height}, expected ${cycleWidth}x${cycleHeight}`);
      if (rotated.rootScrollHeight > cycleHeight + 2) rotationIssues.push(`document scroll height ${rotated.rootScrollHeight} > viewport ${cycleHeight}`);
      if (!rotated.composerVisible) rotationIssues.push(`composer shifted outside viewport to ${rotated.composerTop}–${rotated.composerBottom}px`);
      if (rotated.topbarTop < 0 || rotated.topbarBottom > cycleHeight + 2) rotationIssues.push('top bar shifted outside viewport');
      if (rotated.accountToggleTop < 0 || rotated.accountToggleBottom > cycleHeight + 2) rotationIssues.push('three-dot menu became unreachable');
      if (rotated.filesButtonTop < 0 || rotated.filesButtonBottom > cycleHeight + 2) rotationIssues.push('files button became unreachable');
      if (rotated.scrollY !== 0) rotationIssues.push(`page retained scrollY=${rotated.scrollY}`);
      if (rotationIssues.length) throw new Error(`Rotation ${cycle + 1} failed: ${rotationIssues.join('; ')}. Report: ${JSON.stringify(rotated)}`);
    }
    console.log(`PASS rotation cycle ${orientation}: ${rotationSizes.length} viewport changes; three-dot menu and files remain visible.`);
  } finally {
    try { devtools?.socket.close(); } catch {}
    if (child.exitCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve));
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      await Promise.race([closed, delay(1500)]);
      if (child.exitCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        await Promise.race([closed, delay(1000)]);
      }
    }
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
