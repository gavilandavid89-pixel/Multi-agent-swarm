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


test('shared agent feed stores progress posts and filters by task with bounded results', async () => {
  const { listAgentPosts, recordAgentPost } = await import('../apps/worker/services/agentCoordination.js');
  const first = recordAgentPost({}, {
    type: 'progress', title: 'Parser fixed', body: 'Null input is handled.', taskId: 'task-1'
  }, 'desarrollador', '2026-10-18T12:00:00.000Z');
  const second = recordAgentPost({ agentFeed: first.posts }, {
    type: 'blocker', title: 'Security review needed', body: 'Please inspect token handling.', taskId: 'task-2'
  }, 'auditor', '2026-10-18T12:01:00.000Z');
  assert.equal(second.posts.length, 2);
  assert.equal(listAgentPosts({ agentFeed: second.posts }, { taskId: 'task-1' })[0].role, 'desarrollador');
  assert.equal(listAgentPosts({ agentFeed: second.posts }, { limit: 1 }).length, 1);
  assert.throws(() => recordAgentPost({}, { type: 'system_override', title: 'x', body: 'y' }, 'auditor'), /Tipo de publicación/);
});

test('shared task board tracks ownership, status history, and next steps', async () => {
  const { listAgentTasks, upsertAgentTask } = await import('../apps/worker/services/agentCoordination.js');
  const first = upsertAgentTask({}, {
    title: 'Review token redaction', summary: 'Inspect logs for accidental secret exposure.',
    status: 'pending', priority: 'high', assignedRole: 'auditor', nextStep: 'Inspect dispatcher output.'
  }, 'coordinador', '2026-10-18T12:00:00.000Z');
  assert.equal(first.created, true);
  assert.equal(first.task.status, 'pending');
  const updated = upsertAgentTask({ agentTasks: first.tasks }, {
    taskId: first.task.taskId, title: first.task.title, summary: first.task.summary,
    status: 'in_progress', nextStep: 'Review output redaction.'
  }, 'auditor', '2026-10-18T12:01:00.000Z');
  assert.equal(updated.created, false);
  assert.equal(updated.task.priority, 'high');
  assert.equal(updated.task.assignedRole, 'auditor');
  assert.equal(updated.task.history.length, 2);
  assert.equal(listAgentTasks({ agentTasks: updated.tasks }, { role: 'auditor', status: 'in_progress' }).length, 1);
  assert.throws(() => upsertAgentTask({ agentTasks: updated.tasks }, {
    taskId: first.task.taskId, title: first.task.title, summary: 'unauthorized update', status: 'done'
  }, 'desarrollador'), /Solo el responsable/);
});
