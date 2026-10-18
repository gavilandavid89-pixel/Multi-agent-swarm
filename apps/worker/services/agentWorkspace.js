import { createHash } from 'node:crypto';

const BLOCKED_DIRS = new Set([
  '.git', '.godot', '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.docker',
  'node_modules', '.venv', 'venv', '.swarm-go-modcache', '.swarm-cargo-home',
  '.swarm-m2', '.swarm-gradle', '.swarm-bundle', '.bundle'
]);
const BLOCKED_FILES = new Set([
  '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.gitconfig', '.envrc',
  '.dockerconfigjson', 'pip.conf', 'pip.ini', 'nuget.config', 'auth.json',
  'settings.xml', 'gradle.properties', 'local.properties', 'terraform.tfvars',
  'terraform.tfstate', 'secrets.yaml', 'secrets.yml', 'id_rsa', 'id_ed25519',
  'id_ecdsa', 'credentials.json', 'service-account.json', 'kubeconfig'
]);
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY-----/i,
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i
];

function safeAgentKey(value, label) {
  const key = String(value ?? '');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(key)) {
    throw new TypeError(label + ' debe ser un identificador corto con letras, números, punto, guion o guion bajo.');
  }
  return key.toLowerCase();
}

/** Deterministic, UUID-shaped workspace namespace for one task/agent/purpose. */
export function deriveAgentWorkspaceId(taskId, agentId, purpose = 'working') {
  const task = String(taskId ?? '');
  if (!task || task.length > 256 || /[\x00-\x1f\x7f]/.test(task)) {
    throw new TypeError('taskId debe ser un identificador no vacío y acotado.');
  }
  const agent = safeAgentKey(agentId, 'agentId');
  const scope = safeAgentKey(purpose, 'purpose');
  const bytes = createHash('sha256').update('swarm-agent-workspace-v1\0' + task + '\0' + agent + '\0' + scope).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

function assertSafeFilePath(input) {
  if (typeof input !== 'string' || !input || input.length > 240 || input.startsWith('/')
    || input.includes('\\') || input.includes('\0') || /^[a-z]:/i.test(input)
    || /[\x00-\x1f\x7f]/.test(input)) {
    throw new TypeError('La ruta del archivo debe ser relativa y segura.');
  }
  const parts = input.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || BLOCKED_DIRS.has(part.toLowerCase()))) {
    throw new TypeError('La ruta del archivo contiene un segmento no permitido.');
  }
  const base = parts.at(-1).toLowerCase();
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example') || BLOCKED_FILES.has(base)) {
    throw new TypeError('No se permiten rutas de archivos sensibles en un workspace de agente.');
  }
  return input;
}

function normalizeFiles(files, label, allowDelete = false) {
  if (!Array.isArray(files)) throw new TypeError(label + ' debe ser un arreglo de archivos.');
  const result = new Map();
  for (const file of files) {
    const path = assertSafeFilePath(file?.path);
    const content = file?.content;
    if (!(typeof content === 'string' || (allowDelete && content === null))) {
      throw new TypeError(label + ': content debe ser texto' + (allowDelete ? ' o null para borrar' : '') + '.');
    }
    if (typeof content === 'string' && CREDENTIAL_PATTERNS.some(pattern => pattern.test(content))) {
      throw new TypeError(label + ': se detectaron credenciales en ' + path + '.');
    }
    if (result.has(path)) throw new TypeError(label + ': ruta duplicada ' + path + '.');
    result.set(path, content);
  }
  return result;
}

/**
 * Three-way merge of independent agent proposals against the same immutable base.
 * Conflicting edits are reported and no partial merge is returned.
 */
export function mergeAgentWorkspaceChanges({ baseFiles = [], agentChanges = [] } = {}) {
  const base = normalizeFiles(baseFiles, 'baseFiles');
  if (!Array.isArray(agentChanges)) throw new TypeError('agentChanges debe ser un arreglo.');
  const byPath = new Map();

  for (const proposal of agentChanges) {
    const agentId = safeAgentKey(proposal?.agentId, 'agentId');
    const changes = normalizeFiles(proposal?.files, 'cambios de ' + agentId, true);
    for (const [path, content] of changes) {
      if (!byPath.has(path)) byPath.set(path, []);
      byPath.get(path).push({ agentId, content });
    }
  }

  const merged = new Map(base);
  const conflicts = [];
  const changedPaths = [];
  for (const path of [...byPath.keys()].sort()) {
    const baseContent = base.has(path) ? base.get(path) : null;
    const effective = byPath.get(path)
      .filter(change => change.content !== baseContent)
      .reduce((unique, change) => {
        if (!unique.some(item => item.content === change.content)) unique.push(change);
        return unique;
      }, []);
    if (!effective.length) continue;
    if (effective.length > 1) {
      conflicts.push({ path, agents: [...new Set(byPath.get(path).filter(change => change.content !== baseContent).map(change => change.agentId))].sort() });
      continue;
    }
    const change = effective[0];
    if (change.content === null) merged.delete(path);
    else merged.set(path, change.content);
    changedPaths.push(path);
  }

  if (conflicts.length) return { ok: false, files: null, changedPaths: [], conflicts };
  return {
    ok: true,
    files: [...merged.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => ({ path, content })),
    changedPaths,
    conflicts: []
  };
}
