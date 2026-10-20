import { createHash, randomUUID } from 'node:crypto';

const PERMISSIONS = {
  coordinador: ['workspace_list', 'workspace_read', 'agent_findings_list', 'agent_finding_report', 'agent_feed_publish', 'agent_feed_list', 'agent_task_upsert', 'agent_tasks_list'],


  arbitro: ['workspace_list', 'workspace_read', 'agent_findings_list', 'agent_finding_report', 'agent_feed_publish', 'agent_feed_list', 'agent_task_upsert', 'agent_tasks_list'],

  arquitecto: ['workspace_list', 'workspace_read', 'agent_findings_list', 'agent_finding_report', 'agent_feed_publish', 'agent_feed_list', 'agent_task_upsert', 'agent_tasks_list'],

  esceptico: ['workspace_list', 'workspace_read', 'agent_findings_list', 'agent_finding_report', 'agent_feed_publish', 'agent_feed_list', 'agent_task_upsert', 'agent_tasks_list'],

  auditor: ['workspace_list', 'workspace_read', 'agent_findings_list', 'agent_finding_report', 'agent_feed_publish', 'agent_feed_list', 'agent_task_upsert', 'agent_tasks_list'],

  validador: ['workspace_list', 'workspace_read', 'runner_check', 'runner_job_status', 'runner_artifact', 'agent_findings_list', 'agent_finding_report', 'agent_feed_publish', 'agent_feed_list', 'agent_task_upsert', 'agent_tasks_list'],

  desarrollador: ['workspace_list', 'workspace_read', 'workspace_write', 'runner_execute', 'runner_check', 'runner_job_status', 'runner_cancel', 'runner_artifact', 'runner_dependency', 'agent_findings_list', 'agent_finding_report', 'agent_feed_publish', 'agent_feed_list', 'agent_task_upsert', 'agent_tasks_list']
};
const BLOCKED_DIRS = new Set(['.git', '.ssh', '.aws', '.azure', '.kube', '.docker', 'node_modules', '.venv', 'venv']);
const BLOCKED_FILES = new Set(['.npmrc', '.netrc', '.pypirc', '.git-credentials', 'credentials.json', 'service-account.json', 'id_rsa', 'id_ed25519', 'terraform.tfstate', 'terraform.tfvars', 'kubeconfig']);
const CREDENTIALS = /-----BEGIN (?:OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b|https?:\/\/[^/\s:@]+:[^/\s@]+@/i;
const BINARIES = new Set(['node', 'npm', 'npx', 'python3', 'pytest', 'php', 'composer', 'ruby', 'bundle', 'go', 'java', 'javac', 'mvn', 'cargo', 'rustc', 'gcc', 'g++', 'make', 'pkg-config', 'shellcheck', 'shfmt', 'sqlite3', 'jq', 'file', 'tree', 'rg', 'fdfind', 'black', 'flake8', 'mypy', 'godot', 'chromium', 'xvfb-run', 'tsc', 'tsx', 'eslint', 'prettier']);
const TOOL_TO_PERMISSION = {
  workspace_list: 'workspace_list', workspace_read: 'workspace_read', workspace_write: 'workspace_write',
  runner_execute: 'runner_execute', runner_check: 'runner_check', runner_job_status: 'runner_job_status',
  agent_findings_list: 'agent_findings_list', agent_finding_report: 'agent_finding_report',
  agent_feed_publish: 'agent_feed_publish', agent_feed_list: 'agent_feed_list',
  agent_task_upsert: 'agent_task_upsert', agent_tasks_list: 'agent_tasks_list',
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
  tool('runner_execute', 'Ejecuta un binario permitido sin shell y sin red; stdin acotado solo para Python PDB.', { command: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 }, stdin: { type: 'string', maxLength: 16384 } }, ['command']),
  tool('runner_check', 'Ejecuta las comprobaciones configuradas por el Worker.'),
  tool('runner_job_status', 'Consulta estado de un trabajo.', { jobId: { type: 'string' } }, ['jobId']),
  tool('runner_cancel', 'Cancela un trabajo.', { jobId: { type: 'string' } }, ['jobId']),
  tool('runner_artifact', 'Consulta un artefacto de una ejecución.', { jobId: { type: 'string' }, artifactId: { type: 'string' } }, ['jobId', 'artifactId']),
  tool('runner_dependency', 'Prepara dependencias mediante red restringida.', { manifest: { type: 'string', enum: ['package-lock.json', 'requirements.txt', 'pyproject.toml', 'composer.lock', 'Gemfile.lock', 'go.sum', 'Cargo.lock', 'pom.xml'] } }, ['manifest']),
  tool('agent_findings_list', 'Consulta hallazgos abiertos relevantes para tu rol, informados por otros agentes.', {}, []),
  tool('agent_feed_publish', 'Publica un avance, decisión, pregunta, bloqueo, resultado o traspaso visible para los demás agentes.', {
    type: { type: 'string', enum: ['progress', 'decision', 'question', 'blocker', 'result', 'handoff'] },
    title: { type: 'string', maxLength: 160 }, body: { type: 'string', maxLength: 3000 },
    taskId: { type: 'string', maxLength: 64 }
  }, ['type', 'title', 'body']),
  tool('agent_feed_list', 'Consulta publicaciones recientes de la red interna de agentes.', {
    taskId: { type: 'string', maxLength: 64 }, limit: { type: 'integer', minimum: 1, maximum: 100 }
  }),
  tool('agent_task_upsert', 'Crea una tarea compartida o clasifica/actualiza el estado de una tarea asignada a tu rol. El agente responsable decide pending, in_progress, blocked, in_review o done; el coordinador solo puede cambiar el responsable y no puede sobrescribir el estado ni la clasificación del agente.', {
    taskId: { type: 'string', maxLength: 64 }, title: { type: 'string', maxLength: 160 },
    summary: { type: 'string', maxLength: 2000 }, status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'in_review', 'done'] },
    priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }, nextStep: { type: 'string', maxLength: 1000 },
    assignedRole: { type: 'string', enum: ['coordinador', 'arquitecto', 'esceptico', 'arbitro', 'auditor', 'validador', 'desarrollador'] },
    dependsOn: { type: 'array', items: { type: 'string', maxLength: 64 }, maxItems: 20 }, evidence: { type: 'string', maxLength: 2000 }
  }, ['summary']),
  tool('agent_tasks_list', 'Consulta el tablero compartido de tareas, opcionalmente filtrado por responsable o estado.', {
    assignedRole: { type: 'string', enum: ['coordinador', 'arquitecto', 'esceptico', 'arbitro', 'auditor', 'validador', 'desarrollador'] },
    status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'in_review', 'done'] },
    limit: { type: 'integer', minimum: 1, maximum: 100 }
  }),
  tool('agent_finding_report', 'Registra un bug, riesgo, fallo de prueba o mejora que debe revisar otro agente. No realices cambios fuera de tu rol: informa evidencia y ruta.', {
    category: { type: 'string', enum: ['bug', 'security', 'test', 'architecture', 'performance', 'quality', 'product', 'other'] },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    title: { type: 'string', maxLength: 160 }, summary: { type: 'string', maxLength: 2000 },
    evidence: { type: 'string', maxLength: 3000 }, filePath: { type: 'string', maxLength: 240 }
  }, ['category', 'severity', 'title', 'summary'])
]);
export function getAgentToolDefinitions(role) {
  const normalizedRole = String(role || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const allowed = PERMISSIONS[normalizedRole];
  if (!allowed) throw error('Rol desconocido; herramientas denegadas.', 'AGENT_TOOL_ROLE_DENIED');
  return AGENT_TOOL_DEFINITIONS.filter(definition => allowed.includes(TOOL_TO_PERMISSION[definition.function.name]));
}
function error(message, code = 'AGENT_TOOL_INVALID_ARGUMENT') { const e = new Error(message); e.code = code; return e; }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
const JOURNALED_TOOLS = new Set(['runner_execute', 'runner_check', 'runner_dependency']);
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
      const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[\s-]+/g, '_');
      if (/^(?:password|passwd|secret|secret_key|client_secret|access_token|refresh_token|auth_token|session_token|token|api_key|apikey|authorization|private_key|signing_key|credentials|cookie|set_cookie)$/.test(normalizedKey)) {
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
export function createAgentToolDispatcher({ role, workspace, runner, jobId, round = 0, maxCalls = 40, reportFinding, listFindings, publishPost, listPosts, updateTask, listTasks, getInvocation, saveInvocation } = {}) {
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
    const journaled = JOURNALED_TOOLS.has(name) && typeof getInvocation === 'function' && typeof saveInvocation === 'function';
    let invocation = null;
    if (journaled) {
      const argsHash = digest(canonical(args));
      const files = await workspace.list();
      const workspaceHash = digest(canonical((Array.isArray(files) ? files : []).map(file => ({ path: file.path, content: file.content })).sort((a, b) => String(a.path).localeCompare(String(b.path)))));
      invocation = await getInvocation({ name, argsHash, workspaceHash, role: normalizedRole, round });
      if (invocation?.status === 'completed' && invocation.workspaceHash === workspaceHash && Object.hasOwn(invocation, 'result')) {
        rememberRunnerJobs(invocation.result);
        return { ok: true, result: bounded(redactSensitiveOutput(invocation.result)), replayed: true };
      }
      if (!invocation || invocation.status !== 'started') {
        invocation = {
          name, argsHash, workspaceHash, role: normalizedRole, round, status: 'started',
          idempotencyKey: 'swarm-tool-' + digest([jobId, normalizedRole, round, name, argsHash, workspaceHash].join(':')).slice(0, 48),
          startedAt: new Date().toISOString()
        };
      }
      // Persist before any remote side effect. If this write fails, do not send the job.
      await saveInvocation(invocation);
    }
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
        if (Object.keys(args).some(k => !['command', 'timeoutMs', 'stdin'].includes(k))) throw error('Argumentos extra no permitidos para runner_execute; la política de red no es elegible por el modelo.');
        if (typeof runner?.execute !== 'function') throw error('Runner execute no disponible.');
        if (!Array.isArray(args.command) || !args.command.length || args.command.length > 32 || args.command.some(v => typeof v !== 'string' || v.length > 4096 || v.includes('\0'))) throw error('command inválido.');
        if (!BINARIES.has(args.command[0])) throw error('Binario no permitido.');
        if (args.command.some(v => /(?:^|[;&|\n])\s*(?:sh|bash|cmd|powershell)\b|\$\(/.test(v))) throw error('Shell o encadenamiento no permitido.');
        if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000 || args.timeoutMs > 120000)) throw error('Timeout fuera de límites.');
        if (args.stdin !== undefined) {
          if (typeof args.stdin !== 'string' || Buffer.byteLength(args.stdin, 'utf8') > 16 * 1024) throw error('stdin debe ser texto de hasta 16 KiB.');
          if (args.command[0] !== 'python3' || args.command[1] !== '-m' || args.command[2] !== 'pdb' || args.command.length < 4) throw error('stdin solo se permite para sesiones por lotes de Python PDB.');
        }
        result = rememberRunnerJobs(await runner.execute({ jobId, round, workspace, command: args.command, network: 'none', timeoutMs: args.timeoutMs || 60000, stdin: args.stdin, idempotencyKey: invocation?.idempotencyKey })); break;
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
      case 'agent_feed_publish': {
        if (Object.keys(args).some(k => !['type', 'title', 'body', 'taskId'].includes(k))) throw error('Campos extra no permitidos en la publicación.');
        if (typeof publishPost !== 'function') throw error('El feed de agentes no está disponible.');
        result = await publishPost(args, normalizedRole); break;
      }
      case 'agent_feed_list':
        if (Object.keys(args).some(k => !['taskId', 'limit'].includes(k))) throw error('Argumentos extra no permitidos para agent_feed_list.');
        if (args.taskId !== undefined && (typeof args.taskId !== 'string' || args.taskId.length > 64)) throw error('taskId inválido.');
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw error('limit inválido.');
        if (typeof listPosts !== 'function') throw error('El feed de agentes no está disponible.');
        result = await listPosts({ taskId: args.taskId, limit: args.limit }); break;
      case 'agent_task_upsert':
        if (Object.keys(args).some(k => !['taskId', 'title', 'summary', 'status', 'priority', 'nextStep', 'assignedRole', 'dependsOn', 'evidence'].includes(k))) throw error('Campos extra no permitidos en la tarea.');
        if (typeof updateTask !== 'function') throw error('El tablero de tareas no está disponible.');
        result = await updateTask(args, normalizedRole); break;
      case 'agent_tasks_list':
        if (Object.keys(args).some(k => !['assignedRole', 'status', 'limit'].includes(k))) throw error('Argumentos extra no permitidos para agent_tasks_list.');
        if (args.assignedRole !== undefined && !['coordinador', 'arquitecto', 'esceptico', 'arbitro', 'auditor', 'validador', 'desarrollador'].includes(args.assignedRole)) throw error('assignedRole inválido.');
        if (args.status !== undefined && !['pending', 'in_progress', 'blocked', 'in_review', 'done'].includes(args.status)) throw error('status inválido.');
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw error('limit inválido.');
        if (typeof listTasks !== 'function') throw error('El tablero de tareas no está disponible.');
        result = await listTasks({ role: args.assignedRole, status: args.status, limit: args.limit }); break;
      case 'agent_findings_list':
        if (Object.keys(args).length) throw error('agent_findings_list no acepta argumentos.');
        if (typeof listFindings !== 'function') throw error('La bandeja de hallazgos no está disponible.');
        result = await listFindings(normalizedRole); break;
      case 'agent_finding_report': {
        if (Object.keys(args).some(k => !['category', 'severity', 'title', 'summary', 'evidence', 'filePath'].includes(k))) throw error('Campos extra no permitidos en el hallazgo.');
        if (typeof reportFinding !== 'function') throw error('El registro de hallazgos no está disponible.');
        result = await reportFinding(args, normalizedRole); break;
      }
      case 'runner_dependency':
        if (Object.keys(args).some(k => k !== 'manifest')) throw error('Argumentos extra no permitidos para runner_dependency.');
        if (!['package-lock.json', 'requirements.txt', 'pyproject.toml', 'composer.lock', 'Gemfile.lock', 'go.sum', 'Cargo.lock', 'pom.xml'].includes(args.manifest)) throw error('Manifest no permitido.');
        result = rememberRunnerJobs(await runner.dependency({ jobId, round, workspace, manifest: args.manifest, idempotencyKey: invocation?.idempotencyKey })); break;
      default: throw error('Herramienta desconocida.');
    }
    const retryableInfrastructureFailure = Boolean(result && typeof result === 'object' && result.infraError === true);
    const retryableTerminalInfrastructureFailure = Boolean(result && typeof result === 'object' && result.retryableTerminalInfrastructureFailure === true);
    const publicResult = result && typeof result === 'object' && !Array.isArray(result)
      ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'retryableTerminalInfrastructureFailure'))
      : result;
    const safeResult = bounded(redactSensitiveOutput(publicResult));
    if (invocation && journaled) {
      await saveInvocation(retryableInfrastructureFailure
        ? {
            ...invocation,
            ...(retryableTerminalInfrastructureFailure ? { idempotencyKey: 'swarm-tool-retry-' + randomUUID() } : {}),
            status: 'started', lastErrorAt: new Date().toISOString()
          }
        : { ...invocation, status: 'completed', result: safeResult, completedAt: new Date().toISOString() });
    }
    return { ok: true, result: safeResult };
  }
  return Object.freeze({ role: normalizedRole, permissions: [...allowed], invoke, get callCount() { return calls; } });
}
