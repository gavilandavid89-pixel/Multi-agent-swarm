import { randomUUID, createHash } from 'node:crypto';
export function sanitizeDiagnosticText(value, max = 2000) {
  return String(value ?? '')
    .replace(/(bearer|token|api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+/ig, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/ig, 'https://[REDACTED]@')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED]')
    .slice(0, max);
}
export function normalizeDiagnosticReport(input = {}) {
  const reportId = typeof input.reportId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(input.reportId) ? input.reportId : randomUUID();
  const severity = ['info','warning','error','critical'].includes(input.severity) ? input.severity : 'error';
  const category = ['runtime','network','database','browser','validation','dependency','timeout','unknown'].includes(input.category) ? input.category : 'unknown';
  const service = sanitizeDiagnosticText(input.service || 'unknown', 80);
  const environment = ['development','test','staging','production','unknown'].includes(input.environment) ? input.environment : 'unknown';
  const summary = sanitizeDiagnosticText(input.summary || input.error?.message || 'Error sin resumen', 500);
  const error = input.error && typeof input.error === 'object' ? {
    name: sanitizeDiagnosticText(input.error.name || 'Error', 100),
    message: sanitizeDiagnosticText(input.error.message || summary, 1200),
    stack: sanitizeDiagnosticText(input.error.stack || '', 8000)
  } : null;
  const correlation = input.correlation && typeof input.correlation === 'object' ? {
    taskId: sanitizeDiagnosticText(input.correlation.taskId || '', 100),
    checkpoint: sanitizeDiagnosticText(input.correlation.checkpoint || '', 120),
    requestId: sanitizeDiagnosticText(input.correlation.requestId || '', 100),
    traceId: sanitizeDiagnosticText(input.correlation.traceId || '', 100)
  } : {};
  const operation = input.operation && typeof input.operation === 'object' ? {
    name: sanitizeDiagnosticText(input.operation.name || '', 120),
    attempt: Math.max(0, Math.min(100, Number(input.operation.attempt) || 0)),
    elapsedMs: Math.max(0, Math.min(86400000, Number(input.operation.elapsedMs) || 0)),
    retryable: input.operation.retryable === true,
    idempotencyKey: sanitizeDiagnosticText(input.operation.idempotencyKey || '', 100)
  } : {};
  const reproduction = input.reproduction && typeof input.reproduction === 'object' ? {
    steps: Array.isArray(input.reproduction.steps) ? input.reproduction.steps.slice(0, 12).map(x => sanitizeDiagnosticText(x, 500)) : [],
    expected: sanitizeDiagnosticText(input.reproduction.expected || '', 1000),
    actual: sanitizeDiagnosticText(input.reproduction.actual || '', 1000)
  } : {};
  const runtime = input.runtime && typeof input.runtime === 'object' ? {
    coldStartSuspected: input.runtime.coldStartSuspected === true,
    serviceReady: input.runtime.serviceReady === true,
    httpStatus: Number.isInteger(input.runtime.httpStatus) ? Math.max(0, Math.min(599, input.runtime.httpStatus)) : null
  } : {};
  const evidence = input.evidence && typeof input.evidence === 'object' ? {
    logReferences: Array.isArray(input.evidence.logReferences) ? input.evidence.logReferences.slice(0, 20).map(x => sanitizeDiagnosticText(x, 200)) : [],
    artifactReferences: Array.isArray(input.evidence.artifactReferences) ? input.evidence.artifactReferences.slice(0, 20).map(x => sanitizeDiagnosticText(x, 200)) : []
  } : {};
  const report = {
    schemaVersion: 1, reportId,
    occurredAt: Number.isFinite(Date.parse(input.occurredAt)) ? new Date(input.occurredAt).toISOString() : new Date().toISOString(),
    service, environment, severity, category, summary, error, correlation, operation, reproduction, runtime, evidence
  };
  const fingerprint = createHash('sha256').update(JSON.stringify([service, category, correlation.taskId || '', error?.name, error?.message || summary, operation.name])).digest('hex');
  return { reportId, report, severity, category, service, environment, summary, fingerprint, taskId: correlation.taskId || null };
}
