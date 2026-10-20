import test from 'node:test';
import assert from 'node:assert/strict';
import { getRetryRecoveryMode } from '../apps/worker/services/retryRecovery.js';

test('retries only the runner when delivery and AI validation are checkpointed', () => {
  assert.equal(getRetryRecoveryMode({
    lastCheckpoint: 'runner-infra-error',
    delivery: '### Archivo: app.js\n\nconsole.log("ok")',
    validation: { verdict: 'APPROVED' },
    syntax: { ok: false, runnerExecution: { infraError: true } }
  }), 'runner-only');
});

test('uses normal workflow retry when the runner failure checkpoint is incomplete', () => {
  assert.equal(getRetryRecoveryMode({
    lastCheckpoint: 'runner-infra-error',
    delivery: '### Archivo: app.js',
    validation: null,
    syntax: { runnerExecution: { infraError: true } }
  }), 'workflow');
});

test('does not select runner-only retry for code/test failures', () => {
  assert.equal(getRetryRecoveryMode({
    lastCheckpoint: 'validation-2',
    delivery: '### Archivo: app.js',
    validation: { verdict: 'APPROVED' },
    syntax: { ok: false, runnerExecution: { infraError: false } }
  }), 'workflow');
});
