const MAX_RESPONSE_BYTES = 250_000;
const REQUEST_TIMEOUT_MS = Math.max(1000, Math.min(70_000, Number(process.env.RUNNER_REQUEST_TIMEOUT_MS || 65_000)));

function extractRunnerFiles(delivery) {
  const source = String(delivery || '');
  const files = new Map();
  const re = /(?:^|\n)(?:#{1,6}\s+([^\n]+)|\*\*([^*\n]+)\*\*|(?:Archivo|File|Ruta)\s*:\s*([^\n]+))\s*\n\s*`{3}([^\n]*)\n([\s\S]*?)\n`{3}/g;
  let match;
  while ((match = re.exec(source))) {
    const name = String(match[1] || match[2] || match[3] || '').replace(/^(?:Archivo|File|Ruta)\s*:\s*/i, '').trim().replace(/^`|`$/g, '').replace(/^\.\//, '');
    if (!name || name.includes('..') || name.startsWith('/') || /[\\\\\0]/.test(name) || /^[a-z]:/i.test(name) || name.length > 180) continue;
    files.set(name, match[5]);
  }
  return [...files].map(([path, content]) => ({ path, content }));
}

export async function runPrivateAgentChecks(delivery) {
  const base = String(process.env.AGENT_RUNNER_URL || '').trim().replace(/\/+$/, '');
  const secret = process.env.AGENT_RUNNER_SHARED_SECRET || '';
  if (!base && !secret) return { configured: false, checked: false, ok: true, message: 'Runner privado no configurado; comprobaciones locales utilizadas.' };
  if (!base || secret.length < 32) return { configured: true, checked: false, ok: false, message: 'Configuración incompleta del runner: AGENT_RUNNER_URL y AGENT_RUNNER_SHARED_SECRET son obligatorios.' };
  let parsed;
  try { parsed = new URL(base); } catch { return { configured: true, checked: false, ok: false, message: 'AGENT_RUNNER_URL no es una URL válida.' }; }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    return { configured: true, checked: false, ok: false, message: 'El runner remoto debe usar HTTPS.' };
  }
  const files = extractRunnerFiles(delivery);
  if (!files.length) return { configured: true, checked: false, ok: true, message: 'No hay archivos en formato reconocible para el runner.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(base + '/v1/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-swarm-runner-secret': secret },
      body: JSON.stringify({ files }),
      signal: controller.signal,
      redirect: 'error'
    });
    const raw = await response.text();
    if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) return { configured: true, checked: false, ok: false, message: 'El runner devolvió una respuesta mayor que el límite permitido.' };
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }
    if (!response.ok || !data) return { configured: true, checked: true, ok: false, message: 'El runner respondió HTTP ' + response.status + ': ' + String(data?.error || raw || 'respuesta inválida').slice(0, 1000) };
    return { configured: true, checked: true, ok: data.ok === true, message: 'Runner privado: ' + (data.ok ? 'comprobaciones superadas.' : 'se detectaron fallos.') + ' Archivos: ' + Number(data.filesChecked || 0) + '. Sintaxis: ' + (data.syntax || []).filter(item => !item.ok).map(item => item.path + ': ' + item.stderr).join('; ') + ' Navegador: ' + String(data.browser?.message || 'sin resultado').slice(0, 1200), result: data };
  } catch (error) {
    return { configured: true, checked: true, ok: false, message: 'No se pudo validar con el runner privado: ' + (error?.name === 'AbortError' ? 'tiempo de espera agotado.' : String(error?.message || error).slice(0, 800)) };
  } finally { clearTimeout(timer); }
}
