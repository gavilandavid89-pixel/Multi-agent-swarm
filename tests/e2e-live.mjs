import { writeFile } from 'node:fs/promises';
import { createZip } from '../apps/bridge/services/zipBundle.js';

const base = (process.env.SWARM_BRIDGE_URL || 'https://swarm-bridge.onrender.com').replace(/\/$/, '');
const adminPasswords = [...new Set([process.env.SWARM_ADMIN_PASSWORD, process.env.SWARM_APP_ACCESS_KEY].filter(value => typeof value === 'string' && value.length >= 12))];
let sessionToken = '';
const timeoutMs = Math.max(60000, Number(process.env.SWARM_E2E_TIMEOUT_MS) || 1500000);
const startedAt = new Date().toISOString();
const report = { startedAt, base, checks: [], taskId: null, finalStatus: null, errors: [] };

function check(name, detail) {
  report.checks.push({ name, ok: true, detail });
  console.log('PASS ' + name + ': ' + detail);
}
function fail(message) { throw new Error(message); }
async function request(route, options = {}) {
  const response = await fetch(base + route, {
    ...options,
    signal: AbortSignal.timeout(30000),
    headers: {
      ...(options.auth ? { authorization: 'Bearer ' + sessionToken } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  return response;
}
async function json(response, label) {
  const body = await response.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { fail(label + ' no devolvió JSON (HTTP ' + response.status + ').'); }
  if (!response.ok) fail(label + ' respondió HTTP ' + response.status + ': ' + String(parsed?.error || body).slice(0, 600));
  return parsed;
}

try {
  if (!adminPasswords.length) fail('Falta SWARM_ADMIN_PASSWORD (recomendado) o SWARM_APP_ACCESS_KEY como contraseña del administrador; no se imprime su valor.');
  const bridgeHealth = await fetch(base + '/healthz', { signal: AbortSignal.timeout(20000) });
  const healthData = await json(bridgeHealth, 'Salud del puente');
  if (healthData.ok !== true || healthData.role !== 'bridge') fail('El endpoint de salud no identifica un bridge operativo.');
  check('bridge-health', 'El puente responde /healthz.');
  if (!healthData.workerConfigured) fail('El puente no confirma la configuración del worker.');

  let login = null;
  for (const password of adminPasswords) {
    const response = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password }) });
    if (response.ok) {
      login = await json(response, 'Inicio de sesión del administrador');
      break;
    }
    if (response.status !== 401) await json(response, 'Inicio de sesión del administrador');
  }
  if (!login?.token || login.user?.role !== 'admin') fail('Ninguna de las contraseñas configuradas permitió iniciar sesión como administrador. Configurá SWARM_ADMIN_PASSWORD con la contraseña actual o SWARM_APP_ACCESS_KEY si sigue siendo la contraseña inicial.');
  sessionToken = login.token;
  check('login', 'El administrador inició sesión y se recibió un token de sesión; no se registra ni se muestra.');

  const access = await json(await request('/api/access-check', { auth: true }), 'Validación de acceso');
  if (access.ok !== true) fail('La validación de acceso no devolvió ok=true.');
  check('auth', 'El token de sesión fue aceptado por el puente.');

  const objective = [
    'PRUEBA AUTOMÁTICA E2E DE SWARM. Generá una entrega mínima, real y completa.',
    'Creá un único archivo index.html autocontenido con HTML, CSS y JavaScript inline.',
    'Debe mostrar el título "Swarm E2E", un contador que empieza en 0 y un botón funcional que lo incrementa.',
    'No uses bibliotecas, CDN, recursos externos, backend ni archivos adicionales.',
    'Incluí todo el código completo y validable. Esta es una prueba funcional automatizada.'
  ].join(' ');
  const created = await json(await request('/api/jobs', { method: 'POST', auth: true, body: JSON.stringify({ objective }) }), 'Creación de tarea');
  if (!created.id) fail('La API aceptó la orden pero no devolvió un identificador de tarea.');
  report.taskId = created.id;
  check('task-created', 'Tarea real creada: ' + created.id);

  const deadline = Date.now() + timeoutMs;
  let detail = null;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const response = await request('/api/jobs/' + encodeURIComponent(created.id) + '/history', { auth: true });
    detail = await json(response, 'Consulta de estado de tarea');
    const job = detail.job;
    if (!job) fail('La respuesta de estado no contiene job.');
    if (job.status !== lastStatus) {
      console.log('TASK ' + created.id + ' status=' + job.status + ' stage=' + String(job.stage || '').slice(0, 160));
      lastStatus = job.status;
    }
    if (['completed', 'failed', 'needs_review'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  if (!detail?.job || !['completed', 'failed', 'needs_review'].includes(detail.job.status)) {
    fail('La tarea no terminó dentro del tiempo de espera. Último estado: ' + (detail?.job?.status || 'desconocido') + '. La tarea puede seguir ejecutándose en Swarm.');
  }
  report.finalStatus = detail.job.status;
  if (detail.job.status !== 'completed') {
    fail('La tarea terminó con estado ' + detail.job.status + ': ' + String(detail.job.error || detail.job.stage || 'sin diagnóstico').slice(0, 700));
  }
  if (detail.validation?.verdict === 'NEEDS_CHANGES' || detail.syntax?.ok === false) {
    fail('La tarea figura como completada, pero la validación/sintaxis bloquea la entrega ZIP.');
  }
  check('task-completed', 'La tarea terminó y pasó las condiciones de validación.');

  const artifactsResponse = await request('/api/jobs/' + encodeURIComponent(created.id) + '/files', { auth: true });
  const artifactData = await json(artifactsResponse, 'Listado de archivos');
  const files = Array.isArray(artifactData.files) ? artifactData.files : [];
  if (!files.length) fail('La tarea terminó sin generar archivos.');
  const html = files.find(file => String(file.path || '').toLowerCase().endsWith('.html'));
  if (!html) fail('No se encontró ningún artefacto HTML para previsualizar.');
  check('html-artifact', 'Hay ' + files.length + ' archivo(s), incluido ' + html.path + '.');

  const bundleResponse = await request('/api/jobs/' + encodeURIComponent(created.id) + '/bundle', { auth: true });
  if (!bundleResponse.ok) fail('La descarga ZIP respondió HTTP ' + bundleResponse.status + ': ' + (await bundleResponse.text()).slice(0, 500));
  const bundle = Buffer.from(await bundleResponse.arrayBuffer());
  if (bundle.length < 22 || bundle[0] !== 0x50 || bundle[1] !== 0x4b) fail('La respuesta del ZIP no tiene una firma ZIP válida.');
  check('zip-download', 'El paquete ZIP se descargó (' + bundle.length + ' bytes).');

  const previewData = await json(await request('/api/jobs/' + encodeURIComponent(created.id) + '/preview-session', {
    method: 'POST', auth: true, body: JSON.stringify({ index: Number(html.index) })
  }), 'Creación de sesión de vista previa');
  if (!previewData.url || !previewData.url.startsWith('/preview/')) fail('La sesión de vista previa no devolvió una ruta local segura.');
  check('preview-session', 'Se creó una sesión temporal de vista previa.');
  const previewResponse = await fetch(base + previewData.url, { signal: AbortSignal.timeout(20000) });
  const previewHtml = await previewResponse.text();
  if (!previewResponse.ok || !/text\/html/i.test(previewResponse.headers.get('content-type') || '')) fail('La vista previa respondió HTTP ' + previewResponse.status + ' o no devolvió HTML.');
  if (!/Swarm E2E/i.test(previewHtml)) fail('La vista previa no contiene el HTML de prueba esperado.');
  if (!/sandbox/i.test(previewResponse.headers.get('content-security-policy') || '')) fail('La vista previa no aplica una política CSP sandbox.');
  check('html-preview', 'La vista previa devuelve HTML y aplica CSP sandbox.');

  const zipFixture = createZip([
    { path: 'index.html', content: '<!doctype html><html><head><link rel="stylesheet" href="site.css"></head><body><h1>ZIP PREVIEW E2E</h1><button id="go">Probar</button><script src="app.js"></script></body></html>' },
    { path: 'app.js', content: "document.getElementById('go').addEventListener('click', () => { document.body.dataset.clicked = 'yes'; });" },
    { path: 'site.css', content: 'body { color: rebeccapurple; }' },
    { path: 'game.wasm', content: 'WASMTEST' },
    { path: 'ignored.exe', content: 'not a real executable' }
  ]);
  const uploadedResponse = await request('/api/preview-zip', {
    method: 'POST', auth: true, body: zipFixture,
    headers: { 'content-type': 'application/zip' }
  });
  const uploaded = await json(uploadedResponse, 'Subida de ZIP para vista previa');
  if (!uploaded.url || !Array.isArray(uploaded.pages) || !uploaded.pages.some(page => page.path === 'index.html')) {
    fail('La vista previa ZIP no encontró la página HTML principal.');
  }
  if (uploaded.filesCount !== 4) fail('La vista previa ZIP no excluyó el ejecutable o no contó los recursos compatibles correctamente.');
  check('zip-upload-preview', 'ZIP procesado sin instalarlo; página HTML detectada y ejecutable excluido.');
  const uploadedHtmlResponse = await fetch(base + uploaded.url, { signal: AbortSignal.timeout(20000) });
  const uploadedHtml = await uploadedHtmlResponse.text();
  const uploadedCsp = uploadedHtmlResponse.headers.get('content-security-policy') || '';
  if (!uploadedHtmlResponse.ok || !uploadedHtml.includes('ZIP PREVIEW E2E')) fail('La vista previa del ZIP no devolvió el HTML esperado.');
  if (!uploadedCsp.includes('sandbox') || !uploadedCsp.includes('connect-src https://') || !uploadedCsp.includes("frame-src 'none'") || !uploadedCsp.includes('worker-src https://') || !uploadedCsp.includes('wasm-unsafe-eval')) {
    fail('La vista previa ZIP no aplicó todas las restricciones CSP esperadas.');
  }
  if (!uploadedHtml.includes('/preview/') || !uploadedHtml.includes('/assets/') || !uploadedHtml.includes('<base href=')) fail('Los recursos locales o la base de rutas relativas no fueron preparados para la sesión aislada.');
  check('zip-html-sandbox', 'HTML aislado con CSP restrictiva y recursos locales reescritos.');
  const assetMatch = uploadedHtml.match(/src="([^"]*app\.js[^"]*)"/i);
  if (!assetMatch) fail('No se encontró el script local reescrito en la vista previa ZIP.');
  const uploadedAssetResponse = await fetch(new URL(assetMatch[1], base), { signal: AbortSignal.timeout(20000) });
  const uploadedAsset = await uploadedAssetResponse.text();
  if (!uploadedAssetResponse.ok || !uploadedAsset.includes("dataset.clicked = 'yes'") || uploadedAssetResponse.headers.get('access-control-allow-origin') !== '*') fail('El JavaScript local del ZIP no se pudo cargar correctamente con CORS para módulos.');
  const token = uploaded.url.split('/')[2];
  const wasmResponse = await fetch(base + '/preview/' + token + '/assets/game.wasm', { signal: AbortSignal.timeout(20000) });
  if (!wasmResponse.ok || wasmResponse.headers.get('content-type') !== 'application/wasm' || wasmResponse.headers.get('access-control-allow-origin') !== '*') fail('El recurso WASM no se sirvió con MIME/CORS compatibles.');
  check('zip-local-assets', 'JavaScript y WASM locales disponibles con MIME/CORS para juegos web.');

  const jsOnlyFixture = createZip([
    { path: 'src/main.js', content: "document.body.innerHTML = '<main id=\\\"game\\\">JUEGO JS E2E</main>';" },
    { path: 'src/game.css', content: '#game { min-height: 100vh; }' },
    { path: 'assets/level.data', content: 'level-1' }
  ]);
  const jsOnlyResponse = await request('/api/preview-zip', {
    method: 'POST', auth: true, body: jsOnlyFixture,
    headers: { 'content-type': 'application/zip' }
  });
  const jsOnly = await json(jsOnlyResponse, 'ZIP de juego sin HTML');
  if (!Array.isArray(jsOnly.pages) || jsOnly.pages[0]?.path !== '__swarm_preview__/index.html') {
    fail('El ZIP de juego sin HTML no generó un lanzador para su entrypoint JavaScript.');
  }
  const jsOnlyHtmlResponse = await fetch(base + jsOnly.url, { signal: AbortSignal.timeout(20000) });
  const jsOnlyHtml = await jsOnlyHtmlResponse.text();
  if (!jsOnlyHtmlResponse.ok || !jsOnlyHtml.includes('type="module"') || !jsOnlyHtml.includes('/assets/src/main.js')) {
    fail('El lanzador automático no cargó el entrypoint JavaScript del juego.');
  }
  if (!/sandbox/i.test(jsOnlyHtmlResponse.headers.get('content-security-policy') || '')) {
    fail('El lanzador automático no se ejecuta dentro del sandbox CSP.');
  }
  check('zip-js-entrypoint', 'ZIP sin HTML detectado y lanzador aislado generado para src/main.js.');


  report.finishedAt = new Date().toISOString();
  report.result = 'passed';
  await writeFile('swarm-e2e-report.json', JSON.stringify(report, null, 2));
  await import('node:fs/promises').then(fs => fs.appendFile(process.env.GITHUB_STEP_SUMMARY || '/dev/null',
    '# Swarm E2E: PASS\n\n- Tarea: `' + report.taskId + '`\n- Estado: completed\n- Checks: ' + report.checks.length + '\n- ZIP: ' + bundle.length + ' bytes\n'));
  console.log('E2E PASS task=' + report.taskId);
} catch (error) {
  report.finishedAt = new Date().toISOString();
  report.result = 'failed';
  report.errors.push(String(error?.message || error));
  try { await writeFile('swarm-e2e-report.json', JSON.stringify(report, null, 2)); } catch {}
  try {
    const fs = await import('node:fs/promises');
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY || '/dev/null',
      '# Swarm E2E: FAIL\n\n- Tarea: ' + (report.taskId || 'no creada') + '\n- Último estado: ' + (report.finalStatus || 'no finalizado') + '\n- Error: ' + String(error?.message || error).replace(/[\r\n]/g, ' ').slice(0, 1000) + '\n');
  } catch {}
  console.error('E2E FAIL: ' + String(error?.message || error));
  process.exitCode = 1;
}
