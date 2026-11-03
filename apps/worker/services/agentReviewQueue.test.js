import test from 'node:test';
import assert from 'node:assert/strict';
import {
  submitArtifactVersion, reviewArtifactVersion, claimNextCorrection,
  completeCorrectionDelivery, getCurrentArtifactVersion, listArtifactLineage
} from './agentReviewQueue.js';

const deliver = (payload, content, at) => submitArtifactVersion(payload, {
  taskId: 'task-1', artifactId: 'report', title: 'Informe', content
}, 'desarrollador', at);

test('creates immutable sequential versions and marks prior version superseded', () => {
  let state = deliver({}, 'v1', '2026-01-01T00:00:00.000Z');
  state = deliver(state, 'v2', '2026-01-01T00:01:00.000Z');
  const v1 = state.agentArtifactVersions.find(v => v.versionId === 'report:v1');
  assert.equal(v1.content, 'v1');
  assert.equal(v1.status, 'superseded');
  assert.equal(v1.supersededBy, 'report:v2');
  assert.equal(getCurrentArtifactVersion(state, { taskId: 'task-1', artifactId: 'report' }).content, 'v2');
});

test('review by author is rejected', () => {
  const state = deliver({}, 'v1', '2026-01-01T00:00:00.000Z');
  assert.throws(() => reviewArtifactVersion(state, {
    versionId: 'report:v1', verdict: 'approve', summary: 'Looks good'
  }, 'desarrollador'), /no puede revisar su propia entrega/);
});

test('confirmed correction is queued for the author without preempting active work', () => {
  let state = deliver({}, 'v1', '2026-01-01T00:00:00.000Z');
  const result = reviewArtifactVersion(state, {
    versionId: 'report:v1', verdict: 'needs_correction',
    summary: 'Falta la prueba de regresión', evidence: 'El test de regresión no aparece'
  }, 'validador', '2026-01-01T00:02:00.000Z');
  state = result;
  assert.equal(result.correction.authorRole, 'desarrollador');
  assert.equal(result.correction.targetVersionId, 'report:v1');
  assert.equal(claimNextCorrection(state, 'desarrollador', { busy: true }).claimedCorrection, null);
  const claimed = claimNextCorrection(state, 'desarrollador', { busy: false }, '2026-01-01T00:03:00.000Z');
  assert.equal(claimed.claimedCorrection.targetVersionId, 'report:v1');
  assert.equal(claimed.agentCorrectionQueue[0].status, 'in_progress');
});

test('review against an older version is recorded stale and does not enqueue correction', () => {
  let state = deliver({}, 'v1', '2026-01-01T00:00:00.000Z');
  state = deliver(state, 'v2', '2026-01-01T00:01:00.000Z');
  const result = reviewArtifactVersion(state, {
    versionId: 'report:v1', verdict: 'needs_correction', summary: 'Finding from old version'
  }, 'auditor', '2026-01-01T00:02:00.000Z');
  assert.equal(result.review.stale, true);
  assert.equal(result.review.status, 'needs_revalidation');
  assert.equal(result.correction, null);
});

test('a correction cannot claim an outdated target version', () => {
  let state = deliver({}, 'v1', '2026-01-01T00:00:00.000Z');
  state = reviewArtifactVersion(state, {
    versionId: 'report:v1', verdict: 'needs_correction', summary: 'Fix issue'
  }, 'validador', '2026-01-01T00:02:00.000Z');
  state = deliver(state, 'v2', '2026-01-01T00:03:00.000Z');
  const claimed = claimNextCorrection(state, 'desarrollador', { busy: false }, '2026-01-01T00:04:00.000Z');
  assert.equal(claimed.claimedCorrection, null);
  assert.equal(claimed.reason, 'stale_target');
  assert.equal(claimed.agentCorrectionQueue[0].status, 'needs_revalidation');
});

test('correction delivery must point to predecessor version and original author', () => {
  let state = deliver({}, 'v1', '2026-01-01T00:00:00.000Z');
  state = reviewArtifactVersion(state, {
    versionId: 'report:v1', verdict: 'needs_correction', summary: 'Fix issue'
  }, 'validador', '2026-01-01T00:02:00.000Z');
  state = deliver(state, 'v2 corrected', '2026-01-01T00:03:00.000Z');
  state = completeCorrectionDelivery(state, state.agentCorrectionQueue[0].correctionId, 'report:v2', '2026-01-01T00:04:00.000Z');
  assert.equal(state.agentCorrectionQueue[0].status, 'delivered');
  assert.equal(state.agentCorrectionQueue[0].deliveredVersionId, 'report:v2');
});

test('supervisor gate is not bypassed by peer approval', () => {
  let state = deliver({}, 'v1', '2026-01-01T00:00:00.000Z');
  state = reviewArtifactVersion(state, {
    versionId: 'report:v1', verdict: 'approve', summary: 'Tests and scope reviewed'
  }, 'validador', '2026-01-01T00:02:00.000Z');
  assert.equal(getCurrentArtifactVersion(state, { taskId: 'task-1', artifactId: 'report' }).status, 'ready_for_supervisor');
  assert.notEqual(getCurrentArtifactVersion(state, { taskId: 'task-1', artifactId: 'report' }).status, 'approved');
});

test('lineage hides raw content while preserving hashes, sequence and correction history', () => {
  let state = deliver({}, 'private artifact content', '2026-01-01T00:00:00.000Z');
  state = reviewArtifactVersion(state, {
    versionId: 'report:v1', verdict: 'approve', summary: 'Reviewed'
  }, 'auditor', '2026-01-01T00:02:00.000Z');
  const lineage = listArtifactLineage(state, { taskId: 'task-1', artifactId: 'report' });
  assert.equal(lineage.currentVersionId, 'report:v1');
  assert.equal(lineage.versions[0].content, undefined);
  assert.match(lineage.versions[0].contentHash, /^[a-f0-9]{64}$/);
});

test('rejects unsafe IDs and oversized deliveries', () => {
  assert.throws(() => submitArtifactVersion({}, {
    taskId: '../task', artifactId: 'report', title: 'x', content: 'ok'
  }, 'desarrollador'), /inválido/);
  assert.throws(() => submitArtifactVersion({}, {
    taskId: 'task-1', artifactId: 'report', title: 'x', content: 'x'.repeat(512 * 1024 + 1)
  }, 'desarrollador'), /512 KiB/);
});
