import test from 'node:test';
import assert from 'node:assert/strict';

const databaseUrl = process.env.SWARM_DATABASE_URL || process.env.DATABASE_URL || '';
const encryptionKey = process.env.SWARM_API_ENCRYPTION_KEY || process.env.HISTORY_ENCRYPTION_KEY || '';

test('shared agent handoff survives encrypted PostgreSQL payload reload', {
  skip: !databaseUrl || !/^[0-9a-fA-F]{64}$/.test(encryptionKey)
    ? 'Requires the CI PostgreSQL URL and 32-byte history encryption key.'
    : false
}, async () => {
  // Match the environment aliases used by the worker service before importing its store.
  process.env.DATABASE_URL = databaseUrl;
  process.env.HISTORY_ENCRYPTION_KEY = encryptionKey;

  const store = await import('../apps/worker/services/store.js');
  const {
    listAgentFindings, recordAgentFinding,
    listAgentPosts, recordAgentPost,
    listAgentTasks, upsertAgentTask
  } = await import('../apps/worker/services/agentCoordination.js');

  let job;
  try {
    await store.initStore();
    job = await store.createJob('Integration test: persist agent handoff across worker restart', 4000);

    const initial = await store.getPayload(job.id);
    const finding = recordAgentFinding(initial.payload, {
      category: 'quality', severity: 'high',
      title: 'Debug output exposes authorization metadata',
      summary: 'A redacted reproduction indicates that debug output may reveal authorization metadata.',
      evidence: 'Fixture-only reproduction; no live credentials.',
      filePath: 'src/debug.js'
    }, 'desarrollador', '2026-10-19T13:00:00.000Z');

    await store.updateJob(job.id, {
      payload: { agentFindings: finding.findings, transcript: finding.notifications }
    });

    const afterFinding = await store.getPayload(job.id);
    const post = recordAgentPost(afterFinding.payload, {
      type: 'handoff', title: 'Security/quality review requested',
      body: 'Inspect finding ' + finding.finding.id + ' and verify the redacted evidence.',
      taskId: 'persisted-handoff'
    }, 'desarrollador', '2026-10-19T13:01:00.000Z');
    const assigned = upsertAgentTask(afterFinding.payload, {
      taskId: 'persisted-handoff', title: 'Review debug output finding',
      summary: 'Review the finding and document independent verification.',
      assignedRole: 'auditor', status: 'pending', priority: 'high'
    }, 'coordinador', '2026-10-19T13:01:00.000Z');

    await store.updateJob(job.id, {
      payload: {
        agentFeed: post.posts,
        agentTasks: assigned.tasks
      }
    });

    // A fresh database read models a worker coming back after its in-memory state was lost.
    const reloaded = await store.getPayload(job.id);
    assert.ok(reloaded, 'the job record must remain available');
    assert.equal(listAgentFindings(reloaded.payload, 'auditor')[0].id, finding.finding.id);
    assert.equal(listAgentPosts(reloaded.payload, { role: 'desarrollador', taskId: 'persisted-handoff' })[0].id, post.post.id);
    assert.equal(listAgentTasks(reloaded.payload, { role: 'auditor', status: 'pending' })[0].taskId, 'persisted-handoff');

    const auditorUpdate = upsertAgentTask(reloaded.payload, {
      taskId: 'persisted-handoff', title: 'Review debug output finding',
      summary: 'Independent review completed against the redacted fixture.',
      status: 'done',
      evidence: 'src/debug.js reviewed; fixture contains no live credential.',
      nextStep: 'Validator verifies the persisted evidence.'
    }, 'auditor', '2026-10-19T13:02:00.000Z');
    await store.updateJob(job.id, { payload: { agentTasks: auditorUpdate.tasks } });

    const validatorRead = await store.getPayload(job.id);
    const visibleTask = listAgentTasks(validatorRead.payload, { role: 'auditor', status: 'done' })[0];
    assert.equal(visibleTask.taskId, 'persisted-handoff');
    assert.match(visibleTask.evidence, /no live credential/);
    assert.equal(listAgentFindings(validatorRead.payload, 'validador').length, 1);
    assert.equal(listAgentPosts(validatorRead.payload, { taskId: 'persisted-handoff' }).length, 1);
  } finally {
    await store.closeStore();
  }
});
