import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after } from 'node:test';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.HISTORY_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const { initStore, closeStore, saveDiagnosticReport, getDiagnosticReport, listDiagnosticReports, updateDiagnosticTriage } = await import('../services/store.js');
const { normalizeDiagnosticReport } = await import('../services/diagnosticNormalizer.js');

before(async () => { await initStore(); });
after(async () => { await closeStore(); });

test('normalizes report fields and bounds untrusted values', () => {
  const result = normalizeDiagnosticReport({
    reportId: 'report_12345678', occurredAt: '2026-10-17T12:00:00Z', service: 'runner', environment: 'test',
    severity: 'critical', category: 'timeout', summary: 'runner timed out',
    error: { name: 'TimeoutError', message: 'secret=supersecret failed', stack: 'x'.repeat(12000) },
    correlation: { taskId: 'task-123', checkpoint: 'browser-test' },
    operation: { name: 'browser-test', attempt: 200, elapsedMs: 999999999, retryable: true },
    reproduction: { steps: Array.from({ length: 20 }, (_, i) => `step-${i}`), expected: 'loaded', actual: 'timeout' },
    runtime: { coldStartSuspected: true, serviceReady: false, httpStatus: 503 },
    evidence: { logReferences: ['log-1'], artifactReferences: ['artifact-1'] }
  });
  assert.equal(result.reportId, 'report_12345678');
  assert.equal(result.severity, 'critical');
  assert.equal(result.report.error.message, 'secret=[REDACTED] failed');
  assert.equal(result.report.error.stack.length, 8000);
  assert.equal(result.report.operation.attempt, 100);
  assert.equal(result.report.operation.elapsedMs, 86400000);
  assert.equal(result.report.reproduction.steps.length, 12);
  assert.equal(result.report.runtime.httpStatus, 503);
  assert.deepEqual(result.report.evidence.logReferences, ['log-1']);
  assert.equal(result.taskId, 'task-123');
});

test('redacts URL credentials and API key-like values', () => {
  const result = normalizeDiagnosticReport({
    summary: 'failed https://alice:pass123@example.com/path api_key=secret-value sk-abcdefghijklmnopqrstuvwxyz',
    error: { message: 'failed https://alice:pass123@example.com/path api_key=secret-value sk-abcdefghijklmnopqrstuvwxyz' }
  });
  const serialized = JSON.stringify(result.report);
  assert.equal(serialized.includes('pass123'), false);
  assert.equal(serialized.includes('secret-value'), false);
  assert.equal(serialized.includes('sk-abcdefghijklmnopqrstuvwxyz'), false);
});

test('uses safe defaults for invalid enum values and invalid report IDs', () => {
  const result = normalizeDiagnosticReport({ reportId: 'bad id', severity: 'urgent', category: 'arbitrary', environment: 'prod' });
  assert.match(result.reportId, /^[a-f0-9-]{36}$/i);
  assert.equal(result.severity, 'error');
  assert.equal(result.category, 'unknown');
  assert.equal(result.environment, 'unknown');
});

test('persists, deduplicates, lists and updates a diagnostic report in PostgreSQL', async () => {
  const reportId = `report_${randomUUID()}`;
  const input = {
    reportId, service: 'integration-test', environment: 'test', severity: 'error', category: 'runtime',
    summary: `persistent-report-${randomUUID()}`,
    error: { name: 'IntegrationError', message: `failure-${randomUUID()}`, stack: 'safe stack' },
    correlation: { taskId: `task-${randomUUID()}`, checkpoint: 'integration' },
    evidence: { logReferences: ['test-log-ref'], artifactReferences: ['test-artifact-ref'] }
  };
  const created = await saveDiagnosticReport(input);
  assert.equal(created.duplicate, false);
  assert.equal(created.status, 'queued');
  const duplicate = await saveDiagnosticReport(input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.reportId, reportId);
  const stored = await getDiagnosticReport(reportId);
  assert.equal(stored.status, 'queued');
  assert.deepEqual(stored.report.evidence.logReferences, ['test-log-ref']);
  const listed = await listDiagnosticReports({ limit: 100, status: 'queued' });
  assert.ok(listed.some(item => item.reportId === reportId));
  const triage = await updateDiagnosticTriage(reportId, { status: 'investigating', analysis: 'Reproducible integration test', likelyCause: 'test fixture', nextTests: ['run the test again'] });
  assert.equal(triage.status, 'investigating');
  assert.equal(triage.attempts, 1);
  assert.equal(triage.triage.analysis, 'Reproducible integration test');
  const resolved = await updateDiagnosticTriage(reportId, { status: 'resolved', analysis: 'Verified by integration test' });
  assert.equal(resolved.status, 'resolved');
  assert.ok(resolved.triage.resolvedAt);
});

test('rejects unsupported triage states', async () => {
  await assert.rejects(() => updateDiagnosticTriage('report_missing_123', { status: 'auto-deploy' }), { status: 400 });
});

test('keeps identical failures from different tasks separately correlatable', () => {
  const common = { service: 'runner', category: 'runtime', summary: 'same failure', error: { name: 'Error', message: 'same failure' }, operation: { name: 'test' } };
  const first = normalizeDiagnosticReport({ ...common, correlation: { taskId: 'task-alpha' } });
  const second = normalizeDiagnosticReport({ ...common, correlation: { taskId: 'task-beta' } });
  assert.notEqual(first.fingerprint, second.fingerprint);
});
