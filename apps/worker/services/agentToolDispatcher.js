const PERMISSIONS = {
  coordinador: ['workspace_list', 'workspace_read'],
  arquitecto: ['workspace_list', 'workspace_read'],
  esceptico: ['workspace_list', 'workspace_read'],
  auditor: ['workspace_list', 'workspace_read'],
  validador: ['workspace_list', 'workspace_read', 'runner_check', 'runner_job_status', 'runner_artifact'],
  desarrollador: ['workspace_list', 'workspace_read', 'workspace_write', 'runner_execute', 'runner_check', 'runner_job_status', 'runner_cancel', 'runner_artifact', 'runner_dependency']
};
const BLOCKED_DIRS = new Set(['.git', '.ssh', '.aws', '.azure', '.kube', '.docker', 'node_modules', '.venv', 'venv']);
const BLOCKED_FILES = new Set(['.npmrc', '.netrc', '.pypirc', '.git-credentials', 'credentials.json', 'service-account.json', 'id_rsa', 'id_ed25519', 'terraform.tfstate', 'terraform.tfvars', 'kubeconfig']);
const CREDENTIALS = /-----BEGIN (?:OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b|https?:\/\/[^/\s:@]+:[^/\s@]+@/i;
const BINARIES = new Set(['node', 'npm', 'npx', 'python3', 'pytest', 'php', 'composer', 'ruby', 'bundle', 'go', 'java', 'javac', 'mvn', 'cargo', 'rustc', 'gcc', 'g++', 'make', 'shellcheck', 'shfmt', 'sqlite3', 'godot', 'chromium', 'xvfb-run', 'tsc', 'tsx', 'eslint', 'prettier']);
const TOOL_TO_PERMISSION = {
  workspace_list: 'workspace_list', workspace_read: 'workspace_read', workspace_write: 'workspace_write',
  runner_execute: 'runner_execute', runner_check: 'runner_check', runner_job_status: 'runner_job_status',
  runner_cancel: 'runner_cancel', runner_artifact: 'runner_artifact', runner_dependency: 'runner_dependency'
};
const tool = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } }
});
export const AGENT_TOOL_DEFINITIONS = Object.freeze([
  tool('workspace_list', 'Lista archivos del workspace asignado.'),
  tool('workspace_read', 'Lee un archivo de texto.', { path: { type: 'string' } }, ['path']),
  tool('workspace_write', 'Crea o reemplaza un archivo de texto.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  tool('runner_execute', 'Ejecuta un binario permitido sin shell y sin red.', { command: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 } }, ['command']),
  tool('runner_check', 'Ejecuta las comprobaciones configuradas por el Worker.'),
  tool('runner_job_status', 'Consulta estado de un trabajo.', { jobId: { type: 'string' } }, ['jobId']),
  tool('runner_cancel', 'Cancela un trabajo.', { jobId: { type: 'string' } }, ['jobId']),
  tool('runner_artifact', 'Consulta un artefacto de una ejecución.', { jobId: { type: 'string' }, artifactId: { type: 'string' } }, ['jobId', 'artifactId']),
  tool('runner_dependency', 'Prepara dependencias mediante red restringida.', { manifest: { type: 'string', enum: ['package-lock.json', 'requirements.txt', 'pyproject.toml', 'composer.lock', 'Gemfile.lock', 'go.sum', 'Cargo.lock', 'pom.xml'] } }, ['manifest'])
]);
function error(message, code = 'AGENT_TOOL_INVALID_ARGUMENT') { const e = new Error(message); e.code = code; return e; }
function safePath(path) {
  if (typeof path !== 'string' || !path || path.length > 240 || path.includes('\\') || path.includes('\0') || /[\x00-\x1f\x7f]/.test(path) || path.startsWith('/') || /^[a-z]:/i.test(path)) throw error('Ruta inválida.');
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) throw error('Ruta con segmentos inválidos.');
  if (parts.some(p => BLOCKED_DIRS.has(p.toLowerCase()))) throw error('Directorio sensible bloqueado.');
  const base = parts.at(-1).toLowerCase();
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example') || BLOCKED_FILES.has(base)) throw error('Archivo sensible bloqueado.');
  return path;
}
function redactSensitiveOutput(value, depth = 0) {
  if (depth > 12) return '[nested output omitted]';
  if (typeof value === 'string') return value.replace(new RegExp(CREDENTIALS.source, 'gi'), '[REDACTED_CREDENTIAL]');
  if (Array.isArray(value)) return value.map(item => redactSensitiveOutput(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const normalizedKey = key.toLowerCase().replace(/[\\s-]/g, '_');
      if (/^(?:password|passwd|secret|client_secret|access_token|refresh_token|api_key|apikey|authorization|private_key|credentials)$/.test(normalizedKey)) {
        return [key, '[REDACTED]'];
      }
      return [key, redactSensitiveOutput(item, depth + 1)];
    }));
  }
  return value;
}

function bounded(value) {
  let out;
  try { out = JSON.stringify(value ?? null); }
  catch { return { ok: false, error: 'Resultado no serializable' }; }
  if (out.length <= 12000) return value ?? null;
  // Preserve a valid tool-result envelope and essential job metadata instead of
  // truncating JSON mid-token (which would also hide the ID needed for follow-up tools).
  const summary = { truncated: true, serializedChars: out.length, preview: out.slice(0, 11500) + '[recortado]' };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['jobId', 'status', 'exitCode', 'timedOut', 'durationMs', 'ok', 'available', 'checked', 'infraError', 'message']) {
      if (!Object.hasOwn(value, key)) continue;
      const item = value[key];
      summary[key] = typeof item === 'string' ? item.slice(0, 1000) : item;
    }
  }
  return summary;
}

function collectRunnerJobIds(value, ids = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return ids;
  if (!Array.isArray(value) && typeof value.jobId === 'string' && /^[0-9a-f-]{36}$/i.test(value.jobId)) ids.add(value.jobId);
  const children = Array.isArray(value) ? value.slice(0, 200) : Object.values(value).slice(0, 200);
  for (const child of children) collectRunnerJobIds(child, ids, depth + 1);
  return ids;
}
export function createAgentToolDispatcher({ role, workspace, runner, jobId, round = 0, maxCalls = 40 } = {}) {
  const normalizedRole = String(role || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const allowed = PERMISSIONS[normalizedRole];
  if (!allowed) throw error('Rol desconocido; herramientas denegadas.', 'AGENT_TOOL_ROLE_DENIED');
  if (!workspace || !['list', 'read', 'write'].every(k => typeof workspace[k] === 'function')) throw error('Falta el adaptador seguro de workspace.');
  let calls = 0;
  // A model may only inspect/cancel artifacts from jobs returned by this dispatcher.
  // UUID-shaped IDs alone are not proof of ownership across tasks or agents.
  const ownedRunnerJobs = new Set();
  const rememberRunnerJobs = result => {
    for (const id of collectRunnerJobIds(result)) ownedRunnerJobs.add(id);
    return result;
  };
  const requireOwnedRunnerJob = id => {
    if (typeof id !== 'string' || !ownedRunnerJobs.has(id)) {
      throw error('El jobId no pertenece a esta sesión de herramientas.', 'AGENT_TOOL_JOB_NOT_OWNED');
    }
  };
  async function invoke({ name, arguments: args = {} } = {}) {
    calls++;
    if (calls > Math.min(100, Math.max(1, Number(maxCalls) || 40))) throw error('Límite de llamadas excedido.', 'AGENT_TOOL_CALL_LIMIT');
    if (!TOOL_TO_PERMISSION[name] || !allowed.includes(TOOL_TO_PERMISSION[name])) throw error('Permiso denegado para ' + String(name), 'AGENT_TOOL_ROLE_DENIED');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw error('Argumentos deben ser un objeto.');
    let result;
    switch (name) {
      case 'workspace_list': {
        if (Object.keys(args).length) throw error('No se aceptan argumentos.');
        const files = await workspace.list();
        result = (Array.isArray(files) ? files : []).flatMap(file => {
          try {
            const path = safePath(file?.path);
            return [{ path, bytes: Buffer.byteLength(String(file?.content || ''), 'utf8') }];
          } catch { return []; }
        });
        break;
      }
      case 'workspace_read':
        if (Object.keys(args).some(k => k !== 'path')) throw error('Argumentos extra no permitidos.');
        result = await workspace.read(safePath(args.path));
        if (result == null) throw error('Archivo no encontrado.');
        if (typeof result !== 'string') throw error('El archivo no es texto legible.');
        if (Buffer.byteLength(result, 'utf8') > 256 * 1024) throw error('Archivo supera el límite de lectura de 256 KiB.');
        if (CREDENTIALS.test(result)) throw error('Lectura bloqueada: el archivo contiene posibles credenciales.');
        break;
      case 'workspace_write': {
        if (Object.keys(args).some(k => !['path', 'content'].includes(k))) throw error('Argumentos extra no permitidos.');
        const path = safePath(args.path);
        if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 256 * 1024) throw error('Contenido debe ser texto de hasta 256 KiB.');
        if (CREDENTIALS.test(args.content)) throw error('Contenido con posibles credenciales rechazado.');
        const files = await workspace.list();
        const old = await workspace.read(path);
        const size = (Array.isArray(files) ? files : []).reduce((sum, f) => sum + Buffer.byteLength(String(f.content || '')), 0) - Buffer.byteLength(String(old || '')) + Buffer.byteLength(args.content);
        if (size > 2 * 1024 * 1024) throw error('Workspace excedería 2 MiB.');
        result = await workspace.write(path, args.content); break;
      }
      case 'runner_execute': {
        if (Object.keys(args).some(k => !['command', 'timeoutMs'].includes(k))) throw error('Argumentos extra no permitidos para runner_execute; la política de red no es elegible por el modelo.');
        if (typeof runner?.execute !== 'function') throw error('Runner execute no disponible.');
        if (!Array.isArray(args.command) || !args.command.length || args.command.length > 32 || args.command.some(v => typeof v !== 'string' || v.length > 4096 || v.includes('\0'))) throw error('command inválido.');
        if (!BINARIES.has(args.command[0])) throw error('Binario no permitido.');
        if (args.command.some(v => /(?:^|[;&|\n])\s*(?:sh|bash|cmd|powershell)\b|\$\(/.test(v))) throw error('Shell o encadenamiento no permitido.');
        if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000 || args.timeoutMs > 120000)) throw error('Timeout fuera de límites.');
        result = rememberRunnerJobs(await runner.execute({ jobId, round, workspace, command: args.command, network: 'none', timeoutMs: args.timeoutMs || 60000 })); break;
      }
      case 'runner_check':
        if (Object.keys(args).length) throw error('runner_check no acepta argumentos.');
        if (typeof runner?.check !== 'function') throw error('Runner check no disponible.');
        result = rememberRunnerJobs(await runner.check({ jobId, round, workspace })); break;
      case 'runner_job_status':
        if (Object.keys(args).some(k => k !== 'jobId') || typeof args.jobId !== 'string' || !args.jobId) throw error('jobId inválido.');
        requireOwnedRunnerJob(args.jobId);
        result = await runner.jobStatus({ jobId: args.jobId }); break;
      case 'runner_cancel':
        if (Object.keys(args).some(k => k !== 'jobId') || typeof args.jobId !== 'string' || !args.jobId) throw error('jobId inválido.');
        requireOwnedRunnerJob(args.jobId);
        result = await runner.cancel({ jobId: args.jobId }); break;
      case 'runner_artifact':
        if (Object.keys(args).some(k => !['jobId', 'artifactId'].includes(k)) || typeof args.jobId !== 'string' || typeof args.artifactId !== 'string') throw error('Identificadores de artefacto inválidos.');
        requireOwnedRunnerJob(args.jobId);
        result = await runner.artifact({ jobId: args.jobId, artifactId: args.artifactId }); break;
      case 'runner_dependency':
        if (Object.keys(args).some(k => k !== 'manifest')) throw error('Argumentos extra no permitidos para runner_dependency.');
        if (!['package-lock.json', 'requirements.txt', 'pyproject.toml', 'composer.lock', 'Gemfile.lock', 'go.sum', 'Cargo.lock', 'pom.xml'].includes(args.manifest)) throw error('Manifest no permitido.');
        result = rememberRunnerJobs(await runner.dependency({ jobId, round, workspace, manifest: args.manifest })); break;
      default: throw error('Herramienta desconocida.');
    }
    return { ok: true, result: bounded(redactSensitiveOutput(result)) };
  }
  return Object.freeze({ role: normalizedRole, permissions: [...allowed], invoke, get callCount() { return calls; } });
}
