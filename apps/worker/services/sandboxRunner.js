const MAX_FILES = 40;
const MAX_FILE_BYTES = 256_000;
const MAX_TOTAL_BYTES = 1_500_000;

function extractFiles(delivery) {
  const source = String(delivery || '');
  const files = [];
  const seen = new Set();
  const re = /(?:^|\n)#{1,6}\s+(?:Archivo|File|Ruta)\s*:\s*([^\n]+)\s*\n\s*```([^\n]*)\n([\s\S]*?)\n```/gim;
  let match;
  while ((match = re.exec(source))) {
    const filePath = String(match[1] || '').trim().replace(/^[`"]|[`"]$/g, '').replace(/^\.\//, '');
    if (!filePath || filePath.startsWith('/') || filePath.includes('\\') || filePath.split('/').some(part => !part || part === '.' || part === '..') || !/^[a-zA-Z0-9._@+/-]+$/.test(filePath)) continue;
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    files.push({ path: filePath, content: match[3] });
    if (files.length > MAX_FILES) return { files: [], error: 'La entrega supera el límite de archivos para la ejecución aislada.' };
  }
  let total = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.content, 'utf8');
    if (size > MAX_FILE_BYTES) return { files: [], error: 'Un archivo supera el límite de tamaño para la ejecución aislada.' };
    total += size;
    if (total > MAX_TOTAL_BYTES) return { files: [], error: 'La entrega supera el tamaño total para la ejecución aislada.' };
  }
  return { files, error: null };
}

export async function runSandboxTests(delivery, objective = '') {
  const required = String(process.env.SANDBOX_RUNNER_REQUIRED || '').toLowerCase() === 'true';
  const baseUrl = String(process.env.SANDBOX_RUNNER_URL || '').trim().replace(/\/+$/, '');
  const extracted = extractFiles(delivery);
  if (extracted.error) return { status: 'rejected', reason: extracted.error, required, mode: 'auto' };
  if (!extracted.files.length) return { status: 'skipped', reason: 'No se detectaron archivos con encabezados verificables para ejecutar.', required, mode: 'auto' };
  if (!baseUrl) return {
    status: required ? 'blocked' : 'skipped',
    reason: required ? 'SANDBOX_RUNNER_REQUIRED está activado, pero SANDBOX_RUNNER_URL no está configurada.' : 'El ejecutor aislado todavía no está configurado.',
    required, mode: 'auto'
  };
  const secret = String(process.env.SANDBOX_RUNNER_SECRET || '');
  if (secret.length < 32) return { status: 'blocked', reason: 'SANDBOX_RUNNER_SECRET no está configurado de forma segura.', required, mode: 'auto' };
  let url;
  try { url = new URL('/v1/run', baseUrl); }
  catch { return { status: 'blocked', reason: 'SANDBOX_RUNNER_URL no es válida.', required, mode: 'auto' }; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return { status: 'blocked', reason: 'El protocolo del ejecutor no es compatible.', required, mode: 'auto' };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-swarm-runner-secret': secret },
      body: JSON.stringify({ mode: 'auto', objective: String(objective || '').slice(0, 6000), files: extracted.files }),
      signal: AbortSignal.timeout(65000),
      redirect: 'error'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { status: 'blocked', reason: String(data.error || 'El ejecutor aislado rechazó la solicitud.').slice(0, 1000), required, mode: 'auto', httpStatus: response.status };
    return {
      status: ['passed', 'failed', 'timeout', 'blocked', 'rejected', 'skipped'].includes(data.status) ? data.status : 'blocked',
      reason: String(data.reason || data.error || 'El ejecutor no devolvió un resultado verificable.').slice(0, 1200),
      required, mode: data.mode || 'auto', exitCode: Number.isInteger(data.exitCode) ? data.exitCode : null,
      durationMs: Number.isFinite(data.durationMs) ? data.durationMs : null,
      filesReceived: Number(data.filesReceived) || extracted.files.length,
      stdout: String(data.stdout || '').slice(0, 6000),
      stderr: String(data.stderr || '').slice(0, 6000),
      sandbox: String(data.sandbox || 'unknown'),
      network: String(data.network || 'unknown'),
      httpStatus: response.status
    };
  } catch (error) {
    return { status: required ? 'blocked' : 'skipped', reason: 'No se pudo contactar el ejecutor aislado: ' + String(error?.message || error).slice(0, 500), required, mode: 'auto' };
  }
}
