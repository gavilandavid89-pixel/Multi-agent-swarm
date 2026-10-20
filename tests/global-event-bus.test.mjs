import test from 'node:test';
import assert from 'node:assert/strict';
import '../apps/web/public/global-event-bus.js';

const bus = globalThis.SwarmEvents;

test('global event bus delivers a typed event and returns an unsubscribe function', () => {
  let received;
  const unsubscribe = bus.on('test.delivery', event => { received = event; });
  const result = bus.emit('test.delivery', { value: 42 });
  unsubscribe();
  bus.emit('test.delivery', { value: 43 });
  assert.equal(received.detail.value, 42);
  assert.equal(received.type, 'test.delivery');
  assert.equal(result.delivered, 1);
  assert.equal(result.errors.length, 0);
});

test('global event bus supports one-time listeners', () => {
  let calls = 0;
  bus.once('test.once', () => { calls += 1; });
  bus.emit('test.once');
  bus.emit('test.once');
  assert.equal(calls, 1);
});

test('a failing subscriber does not prevent other subscribers from receiving an event', () => {
  let delivered = false;
  const offFailure = bus.on('test.isolation', () => { throw new Error('subscriber failure'); });
  const offSuccess = bus.on('test.isolation', () => { delivered = true; });
  const result = bus.emit('test.isolation');
  offFailure();
  offSuccess();
  assert.equal(delivered, true);
  assert.equal(result.errors.length, 1);
});
