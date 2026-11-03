import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentToolDispatcher, getAgentToolDefinitions } from './agentToolDispatcher.js';

const roles = ['coordinador', 'arquitecto', 'esceptico', 'arbitro', 'auditor', 'validador', 'desarrollador'];
const reviewTools = ['agent_artifact_submit', 'agent_artifact_review', 'agent_artifact_lineage'];

test('every agent role receives versioned artifact review tools', () => {
  for (const role of roles) {
    const names = getAgentToolDefinitions(role).map(item => item.function.name);
    for (const tool of reviewTools) assert.ok(names.includes(tool), role + ' lacks ' + tool);
  }
});

test('dispatcher routes review requests to the persistence adapter', async () => {
  let seen = null;
  const dispatcher = createAgentToolDispatcher({
    role: 'auditor', jobId: 'task-test',
    workspace: { list: async () => [], read: async () => null, write: async () => ({ ok: true }) },
    reviewArtifact: async (args, role) => { seen = { args, role }; return { review: { verdict: args.verdict }, message: 'recorded' }; }
  });
  const result = await dispatcher.invoke({ name: 'agent_artifact_review', arguments: { versionId: 'task-test:report:v1', verdict: 'needs_correction', summary: 'Missing regression test', evidence: 'No test file in delivery' } });
  assert.equal(seen.role, 'auditor');
  assert.equal(seen.args.versionId, 'task-test:report:v1');
  assert.equal(result.ok, true);
  assert.equal(result.result.review.verdict, 'needs_correction');
});

test('dispatcher rejects extra fields for artifact review', async () => {
  const dispatcher = createAgentToolDispatcher({
    role: 'validador',
    workspace: { list: async () => [], read: async () => null, write: async () => ({ ok: true }) },
    reviewArtifact: async () => ({})
  });
  await assert.rejects(() => dispatcher.invoke({ name: 'agent_artifact_review', arguments: { versionId: 'task:report:v1', verdict: 'approve', summary: 'Reviewed', arbitrary: true } }), /Campos extra no permitidos/);
});
