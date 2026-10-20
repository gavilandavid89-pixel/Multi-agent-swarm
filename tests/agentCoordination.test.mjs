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


test('agent feed schema accepts longer model output while storage remains bounded', async () => {
  const { AGENT_TOOL_DEFINITIONS } = await import('../apps/worker/services/agentToolDispatcher.js');
  const { validateAgentPost } = await import('../apps/worker/services/agentCoordination.js');
  const definition = AGENT_TOOL_DEFINITIONS.find(item => item.function.name === 'agent_feed_publish');
  assert.equal(definition.function.parameters.properties.body.maxLength, 3000);
  const post = validateAgentPost({ type: 'decision', title: 'Decision', body: 'x'.repeat(2600) }, 'arbitro');
  assert.equal(post.body.length, 2000);
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



test('task dependencies must exist and cannot create cycles', async () => {
  const { upsertAgentTask } = await import('../apps/worker/services/agentCoordination.js');
  const base = upsertAgentTask({}, {
    taskId: 'task-prerequisite', title: 'Define API contract', summary: 'Agree on the request and response shape.',
    assignedRole: 'arquitecto', status: 'pending'
  }, 'coordinador', '2026-10-19T12:00:00.000Z');
  const dependent = upsertAgentTask({ agentTasks: base.tasks }, {
    taskId: 'task-implementation', title: 'Implement API', summary: 'Build against the agreed contract.',
    assignedRole: 'desarrollador', status: 'pending', dependsOn: ['task-prerequisite']
  }, 'coordinador', '2026-10-19T12:01:00.000Z');
  assert.deepEqual(dependent.task.dependsOn, ['task-prerequisite']);
  assert.throws(() => upsertAgentTask({ agentTasks: dependent.tasks }, {
    taskId: 'task-implementation', title: 'Implement API', summary: 'Cannot start before the contract is done.',
    assignedRole: 'desarrollador', status: 'in_progress'
  }, 'desarrollador'), /completar sus dependencias/);
  const completedPrerequisite = upsertAgentTask({ agentTasks: dependent.tasks }, {
    taskId: 'task-prerequisite', title: 'Define API contract', summary: 'Contract approved.',
    assignedRole: 'arquitecto', status: 'done'
  }, 'arquitecto', '2026-10-19T12:02:00.000Z');
  const startedDependent = upsertAgentTask({ agentTasks: completedPrerequisite.tasks }, {
    taskId: 'task-implementation', title: 'Implement API', summary: 'Now the contract is ready.',
    assignedRole: 'desarrollador', status: 'in_progress'
  }, 'desarrollador', '2026-10-19T12:03:00.000Z');
  assert.equal(startedDependent.task.status, 'in_progress');
  assert.throws(() => upsertAgentTask({ agentTasks: dependent.tasks }, {
    taskId: 'task-unassigned', title: 'Assign someone else work', summary: 'This must be coordinated.',
    assignedRole: 'auditor'
  }, 'desarrollador'), /Solo el coordinador puede asignar/);
  assert.throws(() => upsertAgentTask({ agentTasks: dependent.tasks }, {
    taskId: 'task-implementation', title: 'Implement API', summary: 'Unknown prerequisite.',
    assignedRole: 'desarrollador', dependsOn: ['task-missing']
  }, 'desarrollador'), /tarea existente/);
  assert.throws(() => upsertAgentTask({ agentTasks: dependent.tasks }, {
    taskId: 'task-prerequisite', title: 'Define API contract', summary: 'Would create a cycle.',
    assignedRole: 'arquitecto', dependsOn: ['task-implementation']
  }, 'arquitecto'), /crearía un ciclo/);
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


test('end-to-end agent handoff shares findings, feed updates, task ownership, and validator evidence', async () => {
  const {
    listAgentFindings, recordAgentFinding,
    listAgentPosts, recordAgentPost,
    listAgentTasks, upsertAgentTask
  } = await import('../apps/worker/services/agentCoordination.js');
  const { createAgentToolDispatcher } = await import('../apps/worker/services/agentToolDispatcher.js');

  // Simulate the durable shared payload used by the worker. Each tool adapter
  // writes back to this same state, so the next role must observe prior writes.
  const state = { agentFindings: [], agentFeed: [], agentTasks: [] };
  const workspace = { list: async () => [], read: async () => null, write: async () => ({ ok: true }) };
  const runner = {};
  const coordinator = createAgentToolDispatcher({
    role: 'coordinador', workspace, runner, jobId: 'e2e-coordination',
    updateTask: async (input, role) => {
      const saved = upsertAgentTask({ agentTasks: state.agentTasks }, input, role);
      state.agentTasks = saved.tasks;
      return saved.task;
    },
    listTasks: async filters => listAgentTasks({ agentTasks: state.agentTasks }, filters)
  });

  const task = (await coordinator.invoke({ name: 'agent_task_upsert', arguments: {
    taskId: 'e2e-security-review', title: 'Review possible token exposure',
    summary: 'Investigate a reported security concern and provide evidence.',
    assignedRole: 'auditor', status: 'pending', priority: 'high'
  }})).result;
  assert.equal(task.assignedRole, 'auditor');

  const developer = createAgentToolDispatcher({
    role: 'desarrollador', workspace, runner, jobId: 'e2e-coordination',
    reportFinding: async (input, role) => {
      const saved = recordAgentFinding({ agentFindings: state.agentFindings }, input, role, '2026-10-19T12:00:00.000Z');
      state.agentFindings = saved.findings;
      return saved.finding;
    },
    publishPost: async (input, role) => {
      const saved = recordAgentPost({ agentFeed: state.agentFeed }, input, role, '2026-10-19T12:01:00.000Z');
      state.agentFeed = saved.posts;
      return saved.post;
    }
  });
  const finding = (await developer.invoke({ name: 'agent_finding_report', arguments: {
    category: 'quality', severity: 'high', title: 'Debug output exposes authorization metadata',
    summary: 'A debug path may expose authorization data.',
    evidence: 'Reproduced with a redacted test fixture.', filePath: 'src/debug.js'
  }})).result;
  await developer.invoke({ name: 'agent_feed_publish', arguments: {
    type: 'handoff', title: 'Security finding needs review',
    body: 'Finding ' + finding.id + ' is routed to the auditor with redacted reproduction evidence.',
    taskId: 'e2e-security-review'
  }});

  const auditor = createAgentToolDispatcher({
    role: 'auditor', workspace, runner, jobId: 'e2e-coordination',
    listFindings: async role => listAgentFindings({ agentFindings: state.agentFindings }, role),
    listPosts: async filters => listAgentPosts({ agentFeed: state.agentFeed }, filters),
    updateTask: async (input, role) => {
      const saved = upsertAgentTask({ agentTasks: state.agentTasks }, input, role);
      state.agentTasks = saved.tasks;
      return saved.task;
    },
    listTasks: async filters => listAgentTasks({ agentTasks: state.agentTasks }, filters),
    publishPost: async (input, role) => {
      const saved = recordAgentPost({ agentFeed: state.agentFeed }, input, role, '2026-10-19T12:02:00.000Z');
      state.agentFeed = saved.posts;
      return saved.post;
    }
  });

  const inbox = (await auditor.invoke({ name: 'agent_findings_list', arguments: {} })).result;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].id, finding.id, 'the second agent must see the first agent\'s finding');
  const handoff = (await auditor.invoke({ name: 'agent_feed_list', arguments: { taskId: 'e2e-security-review' } })).result;
  assert.equal(handoff.length, 1);
  assert.equal(handoff[0].role, 'desarrollador');

  const started = (await auditor.invoke({ name: 'agent_task_upsert', arguments: {
    taskId: 'e2e-security-review', title: 'Review possible token exposure',
    summary: 'Auditor is investigating the reported finding.',
    status: 'in_progress', nextStep: 'Inspect the redacted reproduction evidence.'
  }})).result;
  assert.equal(started.status, 'in_progress');
  const completed = (await auditor.invoke({ name: 'agent_task_upsert', arguments: {
    taskId: 'e2e-security-review', title: 'Review possible token exposure',
    summary: 'Review completed; the reproduced case uses a redacted fixture.',
    status: 'done', evidence: 'src/debug.js: redacted reproduction reviewed; no live credential used.',
    nextStep: 'Independent validator checks the evidence.'
  }})).result;
  assert.equal(completed.status, 'done');
  assert.match(completed.evidence, /redacted reproduction reviewed/);

  const validator = createAgentToolDispatcher({
    role: 'validador', workspace, runner, jobId: 'e2e-coordination',
    listFindings: async role => listAgentFindings({ agentFindings: state.agentFindings }, role),
    listPosts: async filters => listAgentPosts({ agentFeed: state.agentFeed }, filters),
    listTasks: async filters => listAgentTasks({ agentTasks: state.agentTasks }, filters)
  });
  const validatorFindings = (await validator.invoke({ name: 'agent_findings_list', arguments: {} })).result;
  const completedTasks = (await validator.invoke({ name: 'agent_tasks_list', arguments: {
    assignedRole: 'auditor', status: 'done'
  }})).result;
  const visibleFeed = (await validator.invoke({ name: 'agent_feed_list', arguments: { taskId: 'e2e-security-review' } })).result;
  assert.equal(validatorFindings[0].id, finding.id, 'validator must receive the same shared finding');
  assert.equal(completedTasks[0].evidence, completed.evidence, 'validator must see evidence from the task owner');
  assert.ok(visibleFeed.some(post => post.type === 'handoff'), 'handoff must remain visible after later agent actions');
});
