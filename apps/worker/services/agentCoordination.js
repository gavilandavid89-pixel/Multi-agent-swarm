import { createHash } from 'node:crypto';

const MAX_FINDINGS = 100;
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const CATEGORIES = new Set(['bug', 'security', 'test', 'architecture', 'performance', 'quality', 'product', 'other']);
const ROUTES = Object.freeze({
  bug: ['desarrollador', 'validador', 'coordinador'],
  security: ['auditor', 'desarrollador', 'coordinador'],
  test: ['validador', 'desarrollador', 'coordinador'],
  architecture: ['arquitecto', 'coordinador'],
  performance: ['desarrollador', 'arquitecto', 'coordinador'],
  quality: ['auditor', 'validador', 'coordinador'],
  product: ['coordinador', 'arquitecto'],
  other: ['coordinador']
});
const normalizeRole = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const SENSITIVE_TEXT = /-----BEGIN (?:OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b|https?:\/\/[^/\s:@]+:[^/\s@]+@/gi;
const boundedText = (value, max) => typeof value === 'string'
  ? value.trim().replace(SENSITIVE_TEXT, '[REDACTED_CREDENTIAL]').slice(0, max)
  : '';

function findingFingerprint(finding) {
  return createHash('sha256')
    .update([finding.category, finding.title.toLowerCase().replace(/\s+/g, ' '), finding.summary.toLowerCase().replace(/\s+/g, ' ')].join('\n'))
    .digest('hex').slice(0, 24);
}

export function validateAgentFinding(input, sourceRole) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('El hallazgo debe ser un objeto.');
  const allowed = new Set(['category', 'severity', 'title', 'summary', 'evidence', 'filePath']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('El hallazgo contiene campos no permitidos.');
  const category = String(input.category || '').toLowerCase();
  const severity = String(input.severity || '').toLowerCase();
  const title = boundedText(input.title, 160);
  const summary = boundedText(input.summary, 2000);
  const evidence = boundedText(input.evidence, 3000);
  const filePath = boundedText(input.filePath, 240);
  if (!CATEGORIES.has(category)) throw new Error('Categoría de hallazgo inválida.');
  if (!SEVERITIES.has(severity)) throw new Error('Severidad inválida.');
  if (!title || !summary) throw new Error('El hallazgo requiere título y resumen.');
  if (filePath && (filePath.startsWith('/') || filePath.includes('\\') || filePath.split('/').some(part => !part || part === '.' || part === '..'))) {
    throw new Error('Ruta de evidencia inválida.');
  }
  const role = normalizeRole(sourceRole);
  const finding = { category, severity, title, summary, evidence, filePath, sourceRole: role, targetRoles: ROUTES[category].filter(target => target !== role), status: 'open' };
  finding.id = findingFingerprint(finding);
  return finding;
}

export function recordAgentFinding(payload, input, sourceRole, at = new Date().toISOString()) {
  const finding = validateAgentFinding(input, sourceRole);
  const current = Array.isArray(payload?.agentFindings) ? payload.agentFindings : [];
  const existing = current.find(item => item?.id === finding.id);
  if (existing) {
    const updated = { ...existing, occurrences: Math.min(999, (Number(existing.occurrences) || 1) + 1), lastSeenAt: at };
    return {
      findings: current.map(item => item?.id === finding.id ? updated : item),
      finding: updated, created: false,
      notifications: []
    };
  }
  const stored = { ...finding, occurrences: 1, createdAt: at, lastSeenAt: at, notifiedRoles: finding.targetRoles };
  return {
    findings: [...current, stored].slice(-MAX_FINDINGS),
    finding: stored, created: true,
    notifications: finding.targetRoles.map(role => ({
      at, agent: 'sistema', type: 'agent_finding',
      content: '[Hallazgo para ' + role + '] ' + finding.severity.toUpperCase() + ' · ' + finding.category + ': ' + finding.title + ' — ' + finding.summary
    }))
  };
}

export function listAgentFindings(payload, role) {
  const normalized = normalizeRole(role);
  return (Array.isArray(payload?.agentFindings) ? payload.agentFindings : [])
    .filter(item => item && (item.status === 'open' || item.status === 'in_progress')
      && (item.sourceRole === normalized || (Array.isArray(item.targetRoles) && item.targetRoles.includes(normalized))))
    .slice(-MAX_FINDINGS)
    .map(item => ({ ...item }));
}


const MAX_FEED_POSTS = 200;
const MAX_AGENT_TASKS = 100;
const POST_TYPES = new Set(['progress', 'decision', 'question', 'blocker', 'result', 'handoff']);
const TASK_STATUSES = new Set(['pending', 'in_progress', 'blocked', 'in_review', 'done']);
const TASK_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const AGENT_ROLES = new Set(['coordinador', 'arquitecto', 'esceptico', 'auditor', 'validador', 'desarrollador']);

function boundedListText(value, max, required = false) {
  const text = boundedText(value, max);
  if (required && !text) throw new Error('Falta un campo de texto obligatorio.');
  return text;
}

export function validateAgentPost(input, sourceRole) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('La publicación debe ser un objeto.');
  const allowed = new Set(['type', 'title', 'body', 'taskId']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('La publicación contiene campos no permitidos.');
  const type = String(input.type || '').toLowerCase();
  const title = boundedListText(input.title, 160, true);
  const body = boundedListText(input.body, 2000, true);
  const taskId = boundedListText(input.taskId, 64);
  const role = normalizeRole(sourceRole);
  if (!POST_TYPES.has(type)) throw new Error('Tipo de publicación inválido.');
  if (!AGENT_ROLES.has(role)) throw new Error('Rol de agente inválido.');
  if (taskId && !/^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(taskId)) throw new Error('Identificador de tarea inválido.');
  return { type, title, body, taskId: taskId || null, role };
}

export function recordAgentPost(payload, input, sourceRole, at = new Date().toISOString()) {
  const post = validateAgentPost(input, sourceRole);
  const current = Array.isArray(payload?.agentFeed) ? payload.agentFeed : [];
  const stored = { ...post, id: createHash('sha256').update([at, post.role, post.type, post.title, post.body].join('\n')).digest('hex').slice(0, 24), createdAt: at };
  return { posts: [...current, stored].slice(-MAX_FEED_POSTS), post: stored };
}

export function listAgentPosts(payload, { role, taskId, limit = 50 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 50));
  return (Array.isArray(payload?.agentFeed) ? payload.agentFeed : [])
    .filter(post => post && (!role || post.role === normalizeRole(role)) && (!taskId || post.taskId === taskId))
    .slice(-safeLimit).map(post => ({ ...post }));
}

export function validateAgentTask(input, sourceRole) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('La tarea debe ser un objeto.');
  const allowed = new Set(['taskId', 'title', 'summary', 'status', 'priority', 'nextStep', 'assignedRole', 'dependsOn', 'evidence']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('La tarea contiene campos no permitidos.');
  const taskId = boundedListText(input.taskId, 64);
  const title = boundedListText(input.title, 160, true);
  const summary = boundedListText(input.summary, 2000, true);
  const status = String(input.status || 'pending').toLowerCase();
  const priority = String(input.priority || 'normal').toLowerCase();
  const assignedRole = normalizeRole(input.assignedRole || sourceRole);
  const nextStep = boundedListText(input.nextStep, 1000);
  const evidence = boundedListText(input.evidence, 2000);
  const dependsOn = input.dependsOn === undefined ? [] : input.dependsOn;
  if (taskId && !/^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(taskId)) throw new Error('Identificador de tarea inválido.');
  if (!TASK_STATUSES.has(status)) throw new Error('Estado de tarea inválido.');
  if (!TASK_PRIORITIES.has(priority)) throw new Error('Prioridad de tarea inválida.');
  if (!AGENT_ROLES.has(assignedRole)) throw new Error('Rol asignado inválido.');
  if (!Array.isArray(dependsOn) || dependsOn.length > 20 || dependsOn.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(id))) throw new Error('Dependencias inválidas.');
  if (taskId && dependsOn.includes(taskId)) throw new Error('Una tarea no puede depender de sí misma.');
  return { taskId: taskId || null, title, summary, status, priority, assignedRole, nextStep, evidence, dependsOn: [...new Set(dependsOn)] };
}

export function upsertAgentTask(payload, input, sourceRole, at = new Date().toISOString()) {
  const task = validateAgentTask(input, sourceRole);
  const current = Array.isArray(payload?.agentTasks) ? payload.agentTasks : [];
  const existing = task.taskId ? current.find(item => item?.taskId === task.taskId) : null;
  const role = normalizeRole(sourceRole);
  if (existing && existing.assignedRole !== role && role !== 'coordinador') {
    throw new Error('Solo el responsable asignado o el coordinador puede actualizar esta tarea.');
  }
  const id = task.taskId || 'task-' + createHash('sha256').update([at, role, task.title].join('\n')).digest('hex').slice(0, 16);
  if (current.some(item => item?.taskId === id) && !existing) throw new Error('El identificador de tarea ya existe.');
  const stored = {
    ...(existing || {}), ...task, taskId: id,
    createdAt: existing?.createdAt || at, updatedAt: at,
    history: [...(Array.isArray(existing?.history) ? existing.history : []), {
      at, by: role, fromStatus: existing?.status || null, toStatus: task.status,
      note: task.nextStep || task.summary
    }].slice(-20)
  };
  const tasks = existing ? current.map(item => item?.taskId === id ? stored : item) : [...current, stored];
  return { tasks: tasks.slice(-MAX_AGENT_TASKS), task: stored, created: !existing };
}

export function listAgentTasks(payload, { role, status, limit = 50 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 50));
  return (Array.isArray(payload?.agentTasks) ? payload.agentTasks : [])
    .filter(task => task && (!role || task.assignedRole === normalizeRole(role)) && (!status || task.status === status))
    .slice(-safeLimit).map(task => ({ ...task, history: Array.isArray(task.history) ? task.history.map(item => ({ ...item })) : [] }));
}
