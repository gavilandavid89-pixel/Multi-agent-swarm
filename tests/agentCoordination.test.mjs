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
  assert.throws(() => upsertAgentTask({ agentTasks: updated.tasks }, {
    taskId: first.task.taskId, title: first.task.title, summary: 'coordinator status override', status: 'done'
  }, 'coordinador'), /solo puede actualizar una tarea existente para reasignarla/);
  assert.throws(() => upsertAgentTask({ agentTasks: updated.tasks }, {
    taskId: first.task.taskId, title: first.task.title, summary: 'owner reassignment', assignedRole: 'desarrollador'
  }, 'auditor'), /Solo el coordinador puede reasignar/);
  const reassigned = upsertAgentTask({ agentTasks: updated.tasks }, {
    taskId: first.task.taskId, title: first.task.title, summary: 'Reasignada por el coordinador.',
    assignedRole: 'desarrollador'
  }, 'coordinador', '2026-10-18T12:02:00.000Z');
  assert.equal(reassigned.task.assignedRole, 'desarrollador');
  assert.equal(reassigned.task.status, 'in_progress', 'reassignment must not override the existing status');
});


test('dispatcher exposes shared network tools with strict schemas and role-scoped task updates', async () => {
  const { AGENT_TOOL_DEFINITIONS, createAgentToolDispatcher } = await import('../apps/worker/services/agentToolDispatcher.js');
  for (const name of ['agent_feed_publish', 'agent_feed_list', 'agent_task_upsert', 'agent_tasks_list']) {
    const definition = AGENT_TOOL_DEFINITIONS.find(item => item.function.name === name);
    assert.ok(definition, name + ' schema missing');
    assert.equal(definition.function.parameters.additionalProperties, false);
  }
  const dispatcher = createAgentToolDispatcher({
    role: 'auditor',
    workspace: { list: async () => [], read: async () => null, write: async () => ({}) },
    runner: {}, jobId: 'task-network',
    publishPost: async (post, role) => ({ post, role }),
    listPosts: async filters => [{ type: 'progress', filters }],
    updateTask: async (task, role) => ({ task, role }),
    listTasks: async filters => [{ status: 'blocked', filters }]
  });
  const post = await dispatcher.invoke({ name: 'agent_feed_publish', arguments: {
    type: 'blocker', title: 'Needs review', body: 'Please inspect the dependency manifest.'
  } });
  assert.equal(post.result.role, 'auditor');
  assert.equal((await dispatcher.invoke({ name: 'agent_feed_list', arguments: { limit: 10 } })).result[0].filters.limit, 10);
  assert.equal((await dispatcher.invoke({ name: 'agent_task_upsert', arguments: {
    title: 'Review dependency risk', summary: 'Check dependency provenance.', status: 'pending'
  } })).result.role, 'auditor');
  assert.equal((await dispatcher.invoke({ name: 'agent_tasks_list', arguments: { status: 'blocked' } })).result[0].filters.status, 'blocked');
  await assert.rejects(dispatcher.invoke({ name: 'agent_tasks_list', arguments: { status: 'banana' } }), /status inválido/);
});


test('task owners classify status and checkpoint metadata never overrides it', async () => {
  const { agentStageTaskId, upsertAgentTask } = await import('../apps/worker/services/agentCoordination.js');
  const firstId = agentStageTaskId('arquitecto', 'Arquitecto', 'Arquitectura');
  const nextId = agentStageTaskId('esceptico', 'Escéptico', 'Auditoría escéptica');
  assert.equal(firstId, agentStageTaskId('arquitecto', 'Arquitecto', 'Arquitectura'));
  assert.notEqual(firstId, nextId);

  // The system creates a visible task, but does not claim that work has started.
  const created = upsertAgentTask({}, {
    taskId: firstId, title: 'Arquitecto: Arquitectura', summary: 'Definir el plan.',
    status: 'pending', assignedRole: 'arquitecto'
  }, 'arquitecto', '2026-10-18T12:00:00.000Z');

  // The assigned agent chooses its status based on its own work.
  const ownerUpdate = upsertAgentTask({ agentTasks: created.tasks }, {
    taskId: firstId, title: 'Arquitecto: Arquitectura', summary: 'Propuesta lista para revisión.',
    status: 'in_review', assignedRole: 'arquitecto', nextStep: 'Esperar auditoría escéptica.'
  }, 'arquitecto', '2026-10-18T12:01:00.000Z');

  // A later automatic checkpoint refreshes metadata but omits status: the owner's
  // classification must survive and must not create a fake status transition.
  const checkpoint = upsertAgentTask({ agentTasks: ownerUpdate.tasks }, {
    taskId: firstId, title: 'Arquitecto: Arquitectura', summary: 'Checkpoint persistido.',
    assignedRole: 'arquitecto'
  }, 'arquitecto', '2026-10-18T12:02:00.000Z');

  const nextStage = upsertAgentTask({ agentTasks: checkpoint.tasks }, {
    taskId: nextId, title: 'Escéptico: Auditoría escéptica', summary: 'Buscar contradicciones.',
    status: 'pending', assignedRole: 'esceptico'
  }, 'esceptico', '2026-10-18T12:03:00.000Z');

  assert.equal(nextStage.tasks.length, 2);
  assert.equal(nextStage.tasks.find(task => task.taskId === firstId).status, 'in_review');
  assert.equal(nextStage.tasks.find(task => task.taskId === firstId).history.length, 2);
  assert.equal(nextStage.tasks.find(task => task.taskId === nextId).status, 'pending');

  const doneByOwner = upsertAgentTask({ agentTasks: nextStage.tasks }, {
    taskId: firstId, title: 'Arquitecto: Arquitectura', summary: 'Criterios de arquitectura cumplidos.',
    status: 'done', assignedRole: 'arquitecto'
  }, 'arquitecto', '2026-10-18T12:04:00.000Z');
  assert.equal(doneByOwner.task.status, 'done');
  assert.equal(doneByOwner.task.history.length, 3);
});


test('automatic stage task IDs normalize whitespace in agent and stage labels', async () => {
  const { agentStageTaskId } = await import('../apps/worker/services/agentCoordination.js');
  assert.equal(
    agentStageTaskId('arquitecto', 'Arquitecto   Principal', 'Diseño   del sistema'),
    agentStageTaskId('arquitecto', 'Arquitecto Principal', 'Diseño del sistema')
  );
  assert.equal(
    agentStageTaskId('arquitecto', 'Arquitecto Principal', 'Diseño del sistema'),
    agentStageTaskId('arquitecto', '  Arquitecto Principal  ', '  Diseño del sistema  ')
  );
});
