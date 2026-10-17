import { isIP } from 'node:net';

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 20000;
const MAX_TEXT_LENGTH = 12000;
const MAX_SCREENSHOT_BYTES = 2_000_000;

function send(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

export function safePublicUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { throw new Error('URL inválida.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Solo se permiten URLs HTTP y HTTPS.');
  if (url.username || url.password) throw new Error('No se permiten credenciales embebidas en la URL.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal') {
    throw new Error('La URL apunta a un host local o reservado y fue bloqueada.');
  }
  if (isIP(host)) {
    const parts = host.split('.').map(Number);
    const privateV4 = parts.length === 4 && (
      parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    );
    const privateV6 = host.includes(':') && !(
      host === '::1' || host === '::' ||
      host.startsWith('fc') || host.startsWith('fd') ||
      /^fe[89ab]/i.test(host)
    );
    if (privateV4 || (host.includes(':') && !privateV6)) throw new Error('Las direcciones IP privadas o especiales están bloqueadas.');
    if (host.includes(':') && privateV6) throw new Error('Las direcciones IP privadas o especiales están bloqueadas.');
  }
  return url.href;
}

async function getPageTarget() {
  const port = Number.parseInt(process.env.CHROMIUM_DEBUG_PORT || '9222', 10);
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error('Chromium DevTools no está disponible.');
  const targets = await response.json();
  const page = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!page) throw new Error('Chromium no tiene una pestaña disponible.');
  return page;
}

async function withCdp(run) {
  const page = await getPageTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  const onMessage = event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(String(message.error.message || 'Error de Chromium DevTools')));
    else entry.resolve(message.result || {});
  };
  const onClose = () => {
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('La conexión con Chromium se cerró.')); }
    pending.clear();
  };
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', onClose);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tiempo agotado al conectar con Chromium.')), 2500);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('No se pudo conectar con Chromium DevTools.')); }, { once: true });
  });
  const sendCommand = (method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    if (closed || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('La conexión con Chromium no está abierta.'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Tiempo agotado en la acción ${method}.`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  try {
    await sendCommand('Page.enable');
    await sendCommand('Runtime.enable');
    return await run(sendCommand);
  } finally {
    ws.removeEventListener('message', onMessage);
    ws.removeEventListener('close', onClose);
    onClose();
    try { ws.close(); } catch {}
  }
}

async function evaluate(sendCommand, expression, returnByValue = true) {
  const result = await sendCommand('Runtime.evaluate', {
    expression,
    returnByValue,
    awaitPromise: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(String(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'La expresión del navegador falló.').slice(0, 500));
  }
  return result.result?.value;
}

function selectorExpression(selector, operation) {
  const encoded = JSON.stringify(String(selector || '').slice(0, 1000));
  return `(() => { const el = document.querySelector(${encoded}); if (!el) return {ok:false,error:'No se encontró ningún elemento para ese selector.'}; ${operation} })()`;
}

export async function browserToolAction(input = {}) {
  const action = String(input.action || '').toLowerCase();
  if (!['status','navigate','inspect','click','type','press','scroll','back','wait','screenshot'].includes(action)) {
    throw new Error('Acción desconocida. Acciones disponibles: status, navigate, inspect, click, type, press, scroll, back, wait, screenshot.');
  }
  if (action === 'navigate') {
    const url = safePublicUrl(input.url);
    return withCdp(async sendCommand => {
      await sendCommand('Page.navigate', { url }, MAX_TIMEOUT_MS);
      await new Promise(resolve => setTimeout(resolve, Math.min(2500, Math.max(300, Number(input.waitMs) || 800))));
      return evaluate(sendCommand, `({url:location.href,title:document.title,readyState:document.readyState})`);
    });
  }
  if (action === 'status' || action === 'inspect') {
    return withCdp(async sendCommand => {
      if (action === 'status') return evaluate(sendCommand, `({url:location.href,title:document.title,readyState:document.readyState,viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY},document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}})`);
      return evaluate(sendCommand, `(() => ({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,${MAX_TEXT_LENGTH}),links:[...document.querySelectorAll('a[href]')].slice(0,80).map(a=>({text:(a.innerText||a.getAttribute('aria-label')||'').trim().slice(0,180),href:a.href})),buttons:[...document.querySelectorAll('button,[role=button],input[type=submit]')].slice(0,80).map(e=>({text:(e.innerText||e.value||e.getAttribute('aria-label')||'').trim().slice(0,160),disabled:!!e.disabled})),inputs:[...document.querySelectorAll('input,textarea,select,[contenteditable=true]')].slice(0,60).map(e=>({tag:e.tagName,type:e.type||null,name:e.name||null,placeholder:e.placeholder||null,ariaLabel:e.getAttribute('aria-label'),valueLength:String(e.value||'').length}))}))()`);
    });
  }
  if (action === 'click') {
    const selector = String(input.selector || '').slice(0, 1000);
    if (!selector) throw new Error('La acción click requiere selector CSS.');
    return withCdp(async sendCommand => {
      const result = await evaluate(sendCommand, selectorExpression(selector, `el.scrollIntoView({block:'center',inline:'center'}); el.click(); return {ok:true,tag:el.tagName,text:(el.innerText||el.getAttribute('aria-label')||'').trim().slice(0,200)};`));
      if (result?.ok === false) throw new Error(result.error);
      return { clicked: true, element: result, page: await evaluate(sendCommand, '({url:location.href,title:document.title})') };
    });
  }
  if (action === 'type') {
    const selector = String(input.selector || '').slice(0, 1000);
    const value = String(input.text ?? '');
    if (!selector) throw new Error('La acción type requiere selector CSS.');
    if (value.length > 5000) throw new Error('El texto supera el límite de 5000 caracteres.');
    return withCdp(async sendCommand => {
      const result = await evaluate(sendCommand, selectorExpression(selector, `if (!('value' in el) && !el.isContentEditable) return {ok:false,error:'El elemento no admite texto.'}; el.focus(); if (el.isContentEditable) {el.textContent=${JSON.stringify(value)};} else {const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')?.set; if(setter) setter.call(el,${JSON.stringify(value)}); else el.value=${JSON.stringify(value)};} el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:null})); el.dispatchEvent(new Event('change',{bubbles:true})); return {ok:true,tag:el.tagName,chars:${value.length}};`));
      if (result?.ok === false) throw new Error(result.error);
      return result;
    });
  }
  if (action === 'press') {
    const key = String(input.key || '');
    const allowed = new Set(['Enter','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Backspace','Delete','Home','End','PageUp','PageDown','Space']);
    if (!allowed.has(key)) throw new Error('Tecla no permitida para esta herramienta.');
    return withCdp(async sendCommand => {
      await sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: key === 'Space' ? ' ' : key });
      await sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: key === 'Space' ? ' ' : key });
      return evaluate(sendCommand, '({url:location.href,title:document.title,activeTag:document.activeElement?.tagName})');
    });
  }
  if (action === 'scroll') {
    const direction = input.direction === 'up' ? -1 : 1;
    const amount = Math.min(1600, Math.max(100, Number(input.amount) || 600)) * direction;
    return withCdp(async sendCommand => {
      await evaluate(sendCommand, `window.scrollBy({top:${amount},behavior:'instant'})`);
      return evaluate(sendCommand, '({url:location.href,scrollY,scrollHeight:document.documentElement.scrollHeight,viewportHeight:innerHeight})');
    });
  }
  if (action === 'back') {
    return withCdp(async sendCommand => {
      await sendCommand('Page.navigateToHistoryEntry', { entryId: await evaluate(sendCommand, 'history.length > 1 ? -1 : -1') }).catch(() => {});
      await sendCommand('Runtime.evaluate', { expression: 'history.back()' });
      await new Promise(resolve => setTimeout(resolve, 500));
      return evaluate(sendCommand, '({url:location.href,title:document.title})');
    });
  }
  if (action === 'wait') {
    const ms = Math.min(5000, Math.max(100, Number(input.ms) || 1000));
    await new Promise(resolve => setTimeout(resolve, ms));
    return withCdp(sendCommand => evaluate(sendCommand, '({url:location.href,title:document.title,readyState:document.readyState})'));
  }
  if (action === 'screenshot') {
    return withCdp(async sendCommand => {
      const result = await sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 65, captureBeyondViewport: false });
      const data = String(result.data || '');
      if (Buffer.byteLength(data, 'base64') > MAX_SCREENSHOT_BYTES) throw new Error('La captura supera el límite permitido.');
      return { mimeType: 'image/jpeg', base64: data, bytes: Buffer.byteLength(data, 'base64') };
    });
  }
  throw new Error('Acción no implementada.');
}

export async function handleBrowserToolRequest(req, res) {
  let body = {};
  try {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > 12000) return send(res, 413, { ok: false, error: 'La solicitud supera 12 KB.' });
      chunks.push(chunk);
    }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return send(res, 400, { ok: false, error: 'JSON inválido.' });
  }
  try {
    const result = await browserToolAction(body);
    return send(res, 200, { ok: true, action: body.action, result });
  } catch (error) {
    return send(res, 400, { ok: false, action: body.action || null, error: String(error?.message || error).slice(0, 700) });
  }
}
