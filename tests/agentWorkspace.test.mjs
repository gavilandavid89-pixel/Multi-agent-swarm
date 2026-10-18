import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAgentWorkspaceId, mergeAgentWorkspaceChanges } from '../apps/worker/services/agentWorkspace.js';

test('workspace IDs are stable per task, agent and purpose, and isolated across agents', () => {
  const developer = deriveAgentWorkspaceId('task-1', 'desarrollador');
  assert.equal(developer, deriveAgentWorkspaceId('task-1', 'DESARROLLADOR'));
  assert.match(developer, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(developer, deriveAgentWorkspaceId('task-1', 'validador'));
  assert.notEqual(developer, deriveAgentWorkspaceId('task-2', 'desarrollador'));
  assert.notEqual(developer, deriveAgentWorkspaceId('task-1', 'desarrollador', 'integration'));
  assert.throws(() => deriveAgentWorkspaceId('', 'desarrollador'), /taskId/);
  assert.throws(() => deriveAgentWorkspaceId('task-1', '../desarrollador'), /agentId/);
});

test('independent changes merge without overwriting one another', () => {
  const result = mergeAgentWorkspaceChanges({
    baseFiles: [{ path: 'README.md', content: 'base' }, { path: 'src/app.js', content: 'old' }],
    agentChanges: [
      { agentId: 'frontend', files: [{ path: 'src/app.js', content: 'new' }] },
      { agentId: 'docs', files: [{ path: 'README.md', content: 'updated docs' }, { path: 'src/extra.js', content: 'new module' }] }
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.changedPaths, ['README.md', 'src/app.js', 'src/extra.js']);
  assert.deepEqual(result.files, [
    { path: 'README.md', content: 'updated docs' },
    { path: 'src/app.js', content: 'new' },
    { path: 'src/extra.js', content: 'new module' }
  ]);
});

test('identical edits to the same file coalesce safely', () => {
  const result = mergeAgentWorkspaceChanges({
    baseFiles: [{ path: 'src/shared.js', content: 'before' }],
    agentChanges: [
      { agentId: 'developer-a', files: [{ path: 'src/shared.js', content: 'after' }] },
      { agentId: 'developer-b', files: [{ path: 'src/shared.js', content: 'after' }] }
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, [{ path: 'src/shared.js', content: 'after' }]);
});

test('conflicting edits to the same path fail closed without returning a partial merge', () => {
  const result = mergeAgentWorkspaceChanges({
    baseFiles: [{ path: 'src/shared.js', content: 'base' }, { path: 'safe.txt', content: 'base' }],
    agentChanges: [
      { agentId: 'developer-a', files: [{ path: 'src/shared.js', content: 'version A' }, { path: 'safe.txt', content: 'changed' }] },
      { agentId: 'developer-b', files: [{ path: 'src/shared.js', content: 'version B' }] }
    ]
  });
  assert.equal(result.ok, false);
  assert.equal(result.files, null);
  assert.deepEqual(result.changedPaths, []);
  assert.deepEqual(result.conflicts, [{ path: 'src/shared.js', agents: ['developer-a', 'developer-b'] }]);
});

test('base-identical proposals do not conflict with another agent change', () => {
  const result = mergeAgentWorkspaceChanges({
    baseFiles: [{ path: 'src/shared.js', content: 'base' }],
    agentChanges: [
      { agentId: 'reviewer', files: [{ path: 'src/shared.js', content: 'base' }] },
      { agentId: 'developer', files: [{ path: 'src/shared.js', content: 'changed' }] }
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, [{ path: 'src/shared.js', content: 'changed' }]);
});

test('deletes are explicit and conflict with a different edit', () => {
  const result = mergeAgentWorkspaceChanges({
    baseFiles: [{ path: 'src/old.js', content: 'base' }],
    agentChanges: [
      { agentId: 'cleanup', files: [{ path: 'src/old.js', content: null }] },
      { agentId: 'developer', files: [{ path: 'src/old.js', content: 'edited' }] }
    ]
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicts, [{ path: 'src/old.js', agents: ['cleanup', 'developer'] }]);
});

test('workspace merge rejects traversal, secret paths, duplicate paths and credential-like content', () => {
  assert.throws(() => mergeAgentWorkspaceChanges({ agentChanges: [{ agentId: 'dev', files: [{ path: '../outside', content: 'x' }] }] }), /ruta|segmento/i);
  assert.throws(() => mergeAgentWorkspaceChanges({ agentChanges: [{ agentId: 'dev', files: [{ path: '.env', content: 'x' }] }] }), /sensibles/i);
  assert.throws(() => mergeAgentWorkspaceChanges({ agentChanges: [{ agentId: 'dev', files: [{ path: 'a.js', content: 'one' }, { path: 'a.js', content: 'two' }] }] }), /duplicada/i);
  assert.throws(() => mergeAgentWorkspaceChanges({ agentChanges: [{ agentId: 'dev', files: [{ path: 'a.js', content: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890' }] }] }), /credenciales/i);
});
