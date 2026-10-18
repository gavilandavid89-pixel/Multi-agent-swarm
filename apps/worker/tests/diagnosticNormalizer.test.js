import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDiagnosticReport, sanitizeDiagnosticText } from '../services/diagnosticNormalizer.js';

test('normalizes a valid diagnostic report and preserves task correlation', () => {
  const normalized = normalizeDiagnosticReport({
    reportId: 'report_12345678',
    occurredAt: '2026-10-17T12:00:00.000Z',
    service: 'swarm-worker',
    environment: 'test',
    severity: 'critical',
    category: 'timeout',
    summary: 'Browser test timed out',
    correlation: { taskId: 'task-42', checkpoint: 'browser-test' },
    operation: { name: 'browser-test', attempt: 2, elapsedMs: 20000, retryable: true },
  });
  assert.equal(normalized.reportId, 'report_12345678');
  assert.equal(normalized.report.severity, 'critical');
  assert.equal(normalized.report.category, 'timeout');
  assert.equal(normalized.taskId, 'task-42');
  assert.equal(normalized.report.correlation.checkpoint, 'browser-test');
  assert.equal(normalized.report.operation.attempt, 2);
});

test('redacts common credentials and credential-bearing URLs', () => {
  const value = sanitizeDiagnosticText('Bearer: abc123 token=secret123 https://alice:password@example.com/path sk-abcdefghijklmnop Authorization: Bearer header-secret');
  assert.doesNotMatch(value, /abc123|secret123|header-secret|alice:password|sk-abcdefghijklmnop/);
  assert.match(value, /REDACTED/);
});

test('bounds stack traces, summaries and reproduction steps', () => {
  const normalized = normalizeDiagnosticReport({
    summary: 'x'.repeat(900),
    error: { stack: 'y'.repeat(12000) },
    reproduction: { steps: Array.from({ length: 20 }, () => 'step'.repeat(200)) },
    operation: { attempt: 999, elapsedMs: 999999999 },
  });
  assert.equal(normalized.report.summary.length, 500);
  assert.equal(normalized.report.error.stack.length, 8000);
  assert.equal(normalized.report.reproduction.steps.length, 12);
  assert.ok(normalized.report.reproduction.steps.every(step => step.length <= 500));
  assert.equal(normalized.report.operation.attempt, 100);
  assert.equal(normalized.report.operation.elapsedMs, 86400000);
});

test('normalizes invalid enums and timestamps without trusting caller input', () => {
  const normalized = normalizeDiagnosticReport({
    reportId: 'not valid id!',
    occurredAt: 'not-a-date',
    severity: 'owner',
    category: 'run-shell',
    environment: 'private',
  });
  assert.match(normalized.reportId, /^[a-f0-9-]{36}$/i);
  assert.equal(normalized.report.severity, 'error');
  assert.equal(normalized.report.category, 'unknown');
  assert.equal(normalized.report.environment, 'unknown');
  assert.doesNotThrow(() => new Date(normalized.report.occurredAt).toISOString());
});

test('does not treat task-specific identical failures as the same fingerprint', () => {
  const one = normalizeDiagnosticReport({ service: 'worker', summary: 'failed', correlation: { taskId: 'task-a' } });
  const two = normalizeDiagnosticReport({ service: 'worker', summary: 'failed', correlation: { taskId: 'task-b' } });
  assert.notEqual(one.fingerprint, two.fingerprint);
});
