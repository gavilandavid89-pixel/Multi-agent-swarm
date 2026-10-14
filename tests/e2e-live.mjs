import { writeFile } from 'node:fs/promises';
import { createZip } from '../apps/bridge/services/zipBundle.js';

const base = (process.env.SWARM_BRIDGE_URL || 'https://swarm-bridge.onrender.com').replace(/\/$/, '');
const key = process.env.SWARM_APP_ACCESS_KEY || '';
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
      ...(options.auth && sessionToken ? { authorization: 'Bearer ' + sessionToken } : {}),
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
  if (!key || key.length < 16) fail('Falta el secreto SWARM_APP_ACCESS_KEY o es inválido; no se imprime su valor.');
  const bridgeHealth = await fetch(base + '/healthz', { signal: AbortSignal.timeout(20000) });
  const healthData = await json(bridgeHealth, 'Salud del puente');
  if (healthData.ok !== true || healthData.role !== 'bridge') fail('El endpoint de salud no identifica un bridge operativo.');
  check('bridge-health', 'El puente responde /healthz.');
  if (!healthData.workerConfigured) fail('El puente no confirma la configuración del worker.');

  const landing = await fetch(base + '/', { signal: AbortSignal.timeout(20000) });
  const landingHtml = await landing.text();
  const csp = landing.headers.get('content-security-policy') || '';
  if (!landing.ok || !/text\/html/i.test(landing.headers.get('content-type') || '')) fail('La página principal no devuelve HTML correctamente.');
  if (!csp.includes("script-src 'self'") || !csp.includes("object-src 'none'") || !csp.includes("frame-ancestors 'none'")) {
    fail('La página principal no aplica la política CSP esperada.');
  }
  if (landing.headers.get('x-content-type-options') !== 'nosniff' || landing.headers.get('referrer-policy') !== 'no-referrer') {
    fail('Faltan cabeceras HTTP básicas de protección.');
  }
  check('main-security-headers', 'La página principal aplica CSP, nosniff y no-referrer.');

  const anonymousAccess = await request('/api/access-check');
  if (anonymousAccess.status !== 401) fail('Una solicitud sin sesión debe recibir HTTP 401.');
  const rawPasswordAccess = await request('/api/access-check', {
    headers: { authorization: 'Bearer ' + key }
  });
  if (rawPasswordAccess.status !== 401) fail('La contraseña de bootstrap no debe servir como token Bearer.');
  check('session-required', 'Rutas privadas rechazan tanto solicitudes anónimas como la contraseña usada directamente como token.');

  const login = await json(await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: key })
  }), 'Inicio de sesión de administrador');
  if (!login.token || login.user?.role !== 'admin') fail('El inicio de sesión no devolvió una sesión de administrador válida.');
  sessionToken = login.token;
  check('auth-session', 'Inicio de sesión correcto; la contraseña compartida no se usa como token de API.');

  const access = await json(await request('/api/access-check', { auth: true }), 'Validación de sesión');
  if (access.ok !== true || access.user?.role !== 'admin') fail('La sesión no obtuvo acceso administrativo.');
  check('auth-protected-routes', 'Las rutas privadas aceptan la sesión y no la clave de bootstrap directamente.');

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
    { path: 'assets/untrusted.html', content: "<script>parent.document.body.dataset.pwned = 'yes';</script>" },
    { path: 'assets/untrusted.svg', content: "<svg xmlns='http://www.w3.org/2000/svg'><script>parent.document.body.dataset.pwned='yes'</script></svg>" },
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
  const htmlAssetResponse = await fetch(base + '/preview/' + token + '/assets/assets/untrusted.html', { signal: AbortSignal.timeout(20000) });
  const htmlAssetType = htmlAssetResponse.headers.get('content-type') || '';
  const htmlAssetCsp = htmlAssetResponse.headers.get('content-security-policy') || '';
  if (!htmlAssetResponse.ok || !/^text\/plain/i.test(htmlAssetType) || !htmlAssetCsp.includes('sandbox') || !htmlAssetCsp.includes("script-src 'none'")) {
    fail('Un HTML incluido como recurso debe servirse como texto y con CSP aislada.');
  }
  const svgAssetResponse = await fetch(base + '/preview/' + token + '/assets/assets/untrusted.svg', { signal: AbortSignal.timeout(20000) });
  const svgAssetCsp = svgAssetResponse.headers.get('content-security-policy') || '';
  if (!svgAssetResponse.ok || !svgAssetCsp.includes('sandbox') || !svgAssetCsp.includes("script-src 'none'")) {
    fail('Un SVG abierto como recurso no debe ejecutarse con el origen privilegiado de la aplicación.');
  }
  check('preview-resource-sandbox', 'Los HTML/SVG auxiliares se aíslan para evitar XSS del origen de la aplicación.');
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

  const adminToken = sessionToken;
  const invitation = await json(await request('/api/admin/invites', {
    method: 'POST', auth: true, body: JSON.stringify({ hours: 1 })
  }), 'Creación de invitación de prueba');
  if (!invitation.code) fail('No se generó el código de invitación para la prueba de aislamiento.');
  const suffix = Date.now().toString(36);
  const secondaryUsername = 'e2e-' + suffix;
  const secondaryPassword = 'E2E-' + suffix + '-SecurePass42!';
  const secondary = await json(await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ invite: invitation.code, username: secondaryUsername, password: secondaryPassword })
  }), 'Registro de cuenta aislada');
  if (!secondary.token || secondary.user?.role !== 'user') fail('El registro mediante invitación no creó una cuenta estándar.');
  sessionToken = secondary.token;

  const secondaryJobs = await json(await request('/api/jobs?status=all&limit=100', { auth: true }), 'Tareas de la segunda cuenta');
  if ((secondaryJobs.total || 0) !== 0) fail('La cuenta recién creada no debería ver las tareas de la cuenta administradora.');
  const crossAccountResponse = await request('/api/jobs/' + encodeURIComponent(report.taskId) + '/history', { auth: true });
  if (crossAccountResponse.status !== 404) fail('La segunda cuenta debe recibir HTTP 404 al consultar la tarea del administrador.');
  check('account-task-isolation', 'La segunda cuenta no lista ni abre la tarea del administrador.');

  const reusedInvite = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      invite: invitation.code,
      username: 'e2ereuse-' + suffix,
      password: 'Reuse-' + suffix + '-SecurePass42!'
    })
  });
  if (reusedInvite.status !== 400) fail('Una invitación ya consumida debe rechazarse con HTTP 400.');
  check('invite-single-use', 'Una invitación consumida no permite crear otra cuenta.');

  const logoutResult = await json(await request('/api/auth/logout', { method: 'POST', auth: true, body: '{}' }), 'Cierre de sesión de cuenta de prueba');
  if (logoutResult.ok !== true) fail('El cierre de sesión no confirmó la revocación de sesión.');
  const revokedSession = await request('/api/account', { auth: true });
  if (revokedSession.status !== 401) fail('La sesión de prueba siguió siendo válida después del cierre.');
  check('session-revocation', 'Cerrar sesión invalida el token inmediatamente.');
  sessionToken = adminToken;

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
