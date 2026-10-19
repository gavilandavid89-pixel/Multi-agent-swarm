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
const boundedText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

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
