import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

if (!process.env.SWARM_DATABASE_URL) {
  test('worker task creation is idempotent under PostgreSQL', { skip: 'requires the isolated CI PostgreSQL service' }, () => {});
} else {
  process.env.DATABASE_URL ||= process.env.SWARM_DATABASE_URL;
  process.env.HISTORY_ENCRYPTION_KEY ||= process.env.SWARM_API_ENCRYPTION_KEY || '';

  const { initStore, createJob, closeStore } = await import('../apps/worker/services/store.js');

  test('concurrent retries with one idempotency key return the same task and reject changed payloads', async t => {
    t.after(async () => { await closeStore(); });
    await initStore();

    const key = randomUUID();
    const objective = `Prueba de idempotencia ${randomUUID()}`;
    const [first, retry] = await Promise.all([
      createJob(objective, 8000, null, key),
      createJob(objective, 8000, null, key)
    ]);

    assert.equal(retry.id, first.id, 'concurrent requests with the same key must return the same task');
    assert.equal([first, retry].filter(job => job.created === true).length, 1, 'exactly one concurrent request may create the task');
    assert.equal([first, retry].filter(job => job.created === false).length, 1, 'the replay must be marked so the worker does not enqueue it again');
    await assert.rejects(
      createJob(`${objective} modificada`, 8000, null, key),
      error => error?.status === 409,
      'the same key must not be reused for a different task payload'
    );
  });
}
