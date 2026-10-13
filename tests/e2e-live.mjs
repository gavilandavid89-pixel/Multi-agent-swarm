import { writeFile } from 'node:fs/promises';

const base = (process.env.SWARM_BRIDGE_URL || 'https://swarm-bridge.onrender.com').replace(/\/$/, '');
const key = process.env.SWARM_APP_ACCESS_KEY || '';
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
      ...(options.auth ? { authorization: 'Bearer ' + key } : {}),
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

  const access = await json(await request('/api/access-check', { auth: true }), 'Validación de acceso');
  if (access.ok !== true) fail('La validación de acceso no devolvió ok=true.');
  check('auth', 'La clave de acceso fue aceptada; no se registra ni se muestra.');

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
