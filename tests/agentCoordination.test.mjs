import test from 'node:test';
import assert from 'node:assert/strict';
import { listAgentFindings, recordAgentFinding, validateAgentFinding } from '../apps/worker/services/agentCoordination.js';

test('routes a security finding to responsible roles and creates transcript notifications', () => {
  const saved = recordAgentFinding({}, {
    category: 'security', severity: 'high', title: 'Possible token exposure',
    summary: 'The debug output may include an authorization header.',
    evidence: 'runner output includes Authorization', filePath: 'src/debug.js'
  }, 'desarrollador', '2026-10-18T12:00:00.000Z');
  assert.equal(saved.created, true);
  assert.deepEqual(saved.finding.targetRoles, ['auditor', 'coordinador']);
  assert.deepEqual(saved.notifications.map(item => item.content.includes('Hallazgo para auditor') ? 'auditor' : 'coordinador'), ['auditor', 'coordinador']);
  assert.equal(listAgentFindings({ agentFindings: saved.findings }, 'auditor').length, 1);
  assert.equal(listAgentFindings({ agentFindings: saved.findings }, 'validador').length, 0);
});

test('deduplicates repeated findings and does not emit duplicate notifications', () => {
  const input = { category: 'bug', severity: 'medium', title: 'Null guard missing', summary: 'Function throws when input is null.' };
  const first = recordAgentFinding({}, input, 'validador', '2026-10-18T12:00:00.000Z');
  const second = recordAgentFinding({ agentFindings: first.findings }, input, 'validador', '2026-10-18T12:01:00.000Z');
  assert.equal(second.created, false);
  assert.equal(second.findings.length, 1);
  assert.equal(second.finding.occurrences, 2);
  assert.equal(second.notifications.length, 0);
});

test('rejects unsupported fields, categories, severities, and unsafe file paths', () => {
  assert.throws(() => validateAgentFinding({ category: 'unknown', severity: 'low', title: 'x', summary: 'y' }, 'auditor'), /Categoría/);
  assert.throws(() => validateAgentFinding({ category: 'bug', severity: 'urgent', title: 'x', summary: 'y' }, 'auditor'), /Severidad/);
  assert.throws(() => validateAgentFinding({ category: 'bug', severity: 'low', title: 'x', summary: 'y', extra: true }, 'auditor'), /campos no permitidos/);
  assert.throws(() => validateAgentFinding({ category: 'bug', severity: 'low', title: 'x', summary: 'y', filePath: '../secret.env' }, 'auditor'), /Ruta de evidencia/);
});

test('agent tool schemas expose findings only through strict bounded arguments', async () => {
  const { AGENT_TOOL_DEFINITIONS, createAgentToolDispatcher } = await import('../apps/worker/services/agentToolDispatcher.js');
  const report = AGENT_TOOL_DEFINITIONS.find(tool => tool.function.name === 'agent_finding_report');
  assert.ok(report);
  assert.equal(report.function.parameters.additionalProperties, false);
  assert.deepEqual(report.function.parameters.required, ['category', 'severity', 'title', 'summary']);
  const dispatcher = createAgentToolDispatcher({
    role: 'desarrollador',
    workspace: { list: async () => [], read: async () => null, write: async () => ({}) },
    runner: {}, jobId: 'task-1',
    reportFinding: async (finding, role) => ({ title: finding.title, role }),
    listFindings: async role => [{ id: 'f1', targetRoles: [role] }]
  });
  assert.deepEqual((await dispatcher.invoke({ name: 'agent_finding_report', arguments: {
    category: 'bug', severity: 'low', title: 'Broken empty state', summary: 'The screen is blank.'
  } })).result, { title: 'Broken empty state', role: 'desarrollador' });
  assert.equal((await dispatcher.invoke({ name: 'agent_findings_list', arguments: {} })).result[0].id, 'f1');
});
