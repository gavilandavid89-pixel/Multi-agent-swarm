import { createHash } from 'node:crypto';

const ROLES = new Set(['coordinador', 'arquitecto', 'esceptico', 'arbitro', 'auditor', 'validador', 'desarrollador']);
const MAX_ARTIFACTS = 200;
const MAX_REVIEWS = 500;
const MAX_CORRECTIONS = 200;
const clean = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const roleOf = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const hash = value => createHash('sha256').update(value).digest('hex');

function safeId(value, label = 'ID') {
  const id = clean(value, 96);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(id)) throw new Error(label + ' inválido.');
  return id;
}
function list(payload, key) { return Array.isArray(payload?.[key]) ? payload[key] : []; }

// Never evict work that has not reached a terminal state just to satisfy a
// history cap. Completed queue entries are the first candidates for trimming.
function boundCorrectionHistory(items) {
  if (items.length <= MAX_CORRECTIONS) return items;
  const active = items.filter(item => ['queued', 'in_progress', 'needs_revalidation'].includes(item?.status));
  const completed = items.filter(item => !['queued', 'in_progress', 'needs_revalidation'].includes(item?.status));
  const room = Math.max(0, MAX_CORRECTIONS - active.length);
  return [...completed.slice(-room), ...active].sort((a, b) => Number(a.queueSequence) - Number(b.queueSequence));
}

function boundArtifactHistory(items, heads) {
  if (items.length <= MAX_ARTIFACTS) return items;
  // Current heads are live pointers and must never be trimmed away. The cap
  // applies to historical versions first; it may be exceeded if there are
  // more live artifacts than the nominal history budget.
  const headIds = new Set(Object.values(heads || {}));
  const current = items.filter(item => headIds.has(item?.versionId));
  const history = items.filter(item => !headIds.has(item?.versionId));
  const room = Math.max(0, MAX_ARTIFACTS - current.length);
  return [...history.slice(-room), ...current].sort((a, b) =>
    String(a.taskId).localeCompare(String(b.taskId)) ||
    String(a.artifactId).localeCompare(String(b.artifactId)) ||
    Number(a.version) - Number(b.version)
  );
}

/**
 * Adds an immutable artifact version. Only metadata is changed on previous
 * versions; their content and hash are never overwritten.
 */
export function submitArtifactVersion(payload = {}, input, sourceRole, at = new Date().toISOString()) {
  const role = roleOf(sourceRole);
  if (!ROLES.has(role)) throw new Error('Rol de agente inválido.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Entrega inválida.');
  const taskId = safeId(input.taskId, 'taskId');
  const artifactId = safeId(input.artifactId, 'artifactId');
  const title = clean(input.title, 160);
  const content = typeof input.content === 'string' ? input.content : '';
  if (!title || !content.trim()) throw new Error('La entrega requiere título y contenido.');
  if (Buffer.byteLength(content, 'utf8') > 512 * 1024) throw new Error('La entrega supera 512 KiB.');
  const artifacts = list(payload, 'agentArtifactVersions');
  const same = artifacts.filter(a => a?.taskId === taskId && a?.artifactId === artifactId);
  const previous = same.sort((a, b) => Number(b.version) - Number(a.version))[0];
  const version = previous ? Number(previous.version) + 1 : 1;
  const versionId = taskId + ':' + artifactId + ':v' + version;
  if (artifacts.some(a => a?.versionId === versionId)) throw new Error('La versión ya existe.');
  const digest = hash(content);
  const nextArtifacts = artifacts.map(a => a?.taskId === taskId && a?.artifactId === artifactId && a.versionId === previous?.versionId
    ? { ...a, status: 'superseded', supersededAt: at, supersededBy: versionId }
    : a);
  const record = {
    taskId, artifactId, versionId, version, title, content, contentHash: digest,
    authorRole: role, status: 'in_review', submittedAt: at,
    predecessorVersionId: previous?.versionId || null,
    reviewIds: [], correctionTaskIds: []
  };
  const current = { ...(payload || {}) };
  const heads = {
    ...(current.agentArtifactHeads || {}),
    [taskId + '|' + artifactId]: versionId
  };
  return {
    ...current,
    agentArtifactVersions: boundArtifactHistory([...nextArtifacts, record], heads),
    agentArtifactHeads: heads,
    agentArtifactReviews: list(current, 'agentArtifactReviews').slice(-MAX_REVIEWS),
    agentCorrectionQueue: boundCorrectionHistory(list(current, 'agentCorrectionQueue'))
  };
}

export function getCurrentArtifactVersion(payload = {}, { taskId, artifactId } = {}) {
  const key = safeId(taskId, 'taskId') + '|' + safeId(artifactId, 'artifactId');
  const headId = payload?.agentArtifactHeads?.[key];
  return list(payload, 'agentArtifactVersions').find(a => a?.versionId === headId) || null;
}

/**
 * Review is version-bound. A stale review is recorded but cannot enqueue a
 * correction against a newer head without explicit revalidation.
 */
export function reviewArtifactVersion(payload = {}, input, reviewerRole, at = new Date().toISOString()) {
  const role = roleOf(reviewerRole);
  if (!ROLES.has(role)) throw new Error('Rol revisor inválido.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Revisión inválida.');
  const versionId = safeId(input.versionId, 'versionId');
  const verdict = String(input.verdict || '').toLowerCase();
  if (!['approve', 'needs_correction', 'uncertain', 'false_positive'].includes(verdict)) throw new Error('Veredicto inválido.');
  const summary = clean(input.summary, 2000);
  if (!summary) throw new Error('La revisión requiere un resumen.');
  const artifacts = list(payload, 'agentArtifactVersions');
  const artifact = artifacts.find(a => a?.versionId === versionId);
  if (!artifact) throw new Error('No existe esa versión entregada.');
  if (artifact.authorRole === role) throw new Error('Un agente no puede revisar su propia entrega.');
  const currentHead = getCurrentArtifactVersion(payload, { taskId: artifact.taskId, artifactId: artifact.artifactId });
  const stale = !currentHead || currentHead.versionId !== versionId;
  const reviewId = 'review-' + hash([versionId, role, verdict, summary, at].join('\n')).slice(0, 20);
  const review = {
    reviewId, taskId: artifact.taskId, artifactId: artifact.artifactId, versionId,
    reviewedHash: artifact.contentHash, reviewerRole: role, verdict, summary,
    evidence: clean(input.evidence, 3000), stale, status: stale ? 'needs_revalidation' : 'recorded', createdAt: at
  };
  let corrections = list(payload, 'agentCorrectionQueue');
  const nextArtifacts = artifacts.map(a => {
    if (a?.versionId !== versionId) return a;
    const reviewIds = [...(Array.isArray(a.reviewIds) ? a.reviewIds : []), reviewId].slice(-100);
    let status = a.status;
    const hasActiveCorrection = corrections.some(item => item?.targetVersionId === versionId && ['queued', 'in_progress', 'needs_revalidation'].includes(item?.status));
    if (!stale && verdict === 'needs_correction') status = 'correction_queued';
    if (!stale && verdict === 'approve') status = hasActiveCorrection ? 'correction_queued' : 'ready_for_supervisor';
    return { ...a, reviewIds, status };
  });
  let correction = null;
  if (!stale && verdict === 'needs_correction') {
    const correctionId = 'fix-' + hash([versionId, role, summary, at].join('\n')).slice(0, 20);
    correction = {
      correctionId, taskId: artifact.taskId, artifactId: artifact.artifactId,
      targetVersionId: versionId, targetVersionHash: artifact.contentHash,
      authorRole: artifact.authorRole, queuedBy: role, status: 'queued',
      priority: /critical|bloqueante|security|seguridad/i.test(summary) ? 'high' : 'normal',
      summary, evidence: clean(input.evidence, 3000), createdAt: at,
      queueSequence: corrections.length ? Math.max(...corrections.map(c => Number(c.queueSequence) || 0)) + 1 : 1
    };
    if (!corrections.some(c => c?.correctionId === correctionId)) corrections = boundCorrectionHistory([...corrections, correction]);
  }
  const updated = nextArtifacts.map(a => a?.versionId === versionId && correction
    ? { ...a, correctionTaskIds: [...(Array.isArray(a.correctionTaskIds) ? a.correctionTaskIds : []), correction.correctionId].slice(-100) }
    : a);
  return {
    ...payload,
    agentArtifactVersions: updated,
    agentArtifactReviews: [...list(payload, 'agentArtifactReviews'), review].slice(-MAX_REVIEWS),
    agentCorrectionQueue: corrections,
    review: { ...review },
    correction: correction ? { ...correction } : null
  };
}

/** Claim only queued work for an idle author; never interrupts active work. */
export function claimNextCorrection(payload = {}, authorRole, { busy = false } = {}, at = new Date().toISOString()) {
  const role = roleOf(authorRole);
  if (!ROLES.has(role)) throw new Error('Rol responsable inválido.');
  if (busy) return { ...payload, claimedCorrection: null, reason: 'author_busy' };
  const queue = list(payload, 'agentCorrectionQueue');
  const nowMs = Date.parse(at);
  const leaseMs = 15 * 60 * 1000;
  const next = queue.filter(c => {
    if (c?.authorRole !== role) return false;
    if (c.status === 'queued') return true;
    return c.status === 'in_progress' && Number.isFinite(nowMs) && Number.isFinite(Date.parse(c.claimedAt)) && nowMs - Date.parse(c.claimedAt) >= leaseMs;
  }).sort((a, b) => Number(a.queueSequence) - Number(b.queueSequence))[0];
  if (!next) return { ...payload, claimedCorrection: null, reason: 'queue_empty' };
  const head = getCurrentArtifactVersion(payload, { taskId: next.taskId, artifactId: next.artifactId });
  const stale = !head || head.versionId !== next.targetVersionId || head.contentHash !== next.targetVersionHash;
  const updated = queue.map(c => c?.correctionId !== next.correctionId ? c : {
    ...c, status: stale ? 'needs_revalidation' : 'in_progress', claimedAt: at,
    ...(stale ? { staleReason: 'La versión objetivo ya no es la versión vigente.' } : {})
  });
  return {
    ...payload, agentCorrectionQueue: updated,
    claimedCorrection: stale ? null : { ...next, status: 'in_progress', claimedAt: at },
    reason: stale ? 'stale_target' : 'claimed'
  };
}

/** Link the new delivery to the exact correction and keep the old version immutable. */
export function completeCorrectionDelivery(payload = {}, correctionId, newVersionId, at = new Date().toISOString()) {
  const id = safeId(correctionId, 'correctionId');
  const versionId = safeId(newVersionId, 'newVersionId');
  const queue = list(payload, 'agentCorrectionQueue');
  const correction = queue.find(c => c?.correctionId === id);
  if (!correction) throw new Error('Corrección inexistente.');
  const version = list(payload, 'agentArtifactVersions').find(a => a?.versionId === versionId);
  if (correction.status !== 'in_progress') throw new Error('La corrección debe estar reclamada antes de registrar su entrega.');
  if (!version || version.taskId !== correction.taskId || version.artifactId !== correction.artifactId || version.predecessorVersionId !== correction.targetVersionId) {
    throw new Error('La nueva versión debe declarar como predecesora la versión corregida.');
  }
  if (version.authorRole !== correction.authorRole) throw new Error('La corrección debe entregarla el agente responsable original.');
  if (correction.deliveredVersionId) throw new Error('La corrección ya tiene una entrega vinculada.');
  return {
    ...payload,
    agentCorrectionQueue: queue.map(c => c?.correctionId === id
      ? { ...c, status: 'delivered', deliveredVersionId: versionId, deliveredAt: at }
      : c)
  };
}

export function listArtifactLineage(payload = {}, { taskId, artifactId } = {}) {
  const t = safeId(taskId, 'taskId');
  const a = safeId(artifactId, 'artifactId');
  const head = getCurrentArtifactVersion(payload, { taskId: t, artifactId: a });
  return {
    currentVersionId: head?.versionId || null,
    versions: list(payload, 'agentArtifactVersions')
      .filter(item => item?.taskId === t && item?.artifactId === a)
      .sort((x, y) => Number(x.version) - Number(y.version))
      .map(item => ({ ...item, content: undefined, isCurrent: item.versionId === head?.versionId })),
    reviews: list(payload, 'agentArtifactReviews').filter(r => r?.taskId === t && r?.artifactId === a).map(r => ({ ...r })),
    corrections: list(payload, 'agentCorrectionQueue').filter(c => c?.taskId === t && c?.artifactId === a).map(c => ({ ...c }))
  };
}
