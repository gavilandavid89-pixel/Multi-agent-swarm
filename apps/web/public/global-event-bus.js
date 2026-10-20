/* Shared browser event bus for loosely coupled Swarm modules. */
(function attachSwarmEventBus(root) {
  'use strict';
  const subscribers = new Map();
  let sequence = 0;

  function on(type, handler) {
    if (typeof type !== 'string' || !type.trim()) throw new TypeError('Event type must be a non-empty string.');
    if (typeof handler !== 'function') throw new TypeError('Event handler must be a function.');
    const key = type.trim();
    if (!subscribers.has(key)) subscribers.set(key, new Set());
    const handlers = subscribers.get(key);
    handlers.add(handler);
    let active = true;
    return function unsubscribe() {
      if (!active) return;
      active = false;
      handlers.delete(handler);
      if (handlers.size === 0) subscribers.delete(key);
    };
  }

  function once(type, handler) {
    let unsubscribe;
    unsubscribe = on(type, event => {
      unsubscribe();
      handler(event);
    });
    return unsubscribe;
  }

  function emit(type, detail = {}) {
    if (typeof type !== 'string' || !type.trim()) throw new TypeError('Event type must be a non-empty string.');
    const event = Object.freeze({
      id: ++sequence,
      type: type.trim(),
      detail,
      emittedAt: new Date().toISOString()
    });
    const handlers = [...(subscribers.get(event.type) || [])];
    const errors = [];
    for (const handler of handlers) {
      try { handler(event); } catch (error) { errors.push(error); }
    }
    return { event, delivered: handlers.length, errors };
  }

  const api = Object.freeze({ on, once, emit });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SwarmEvents = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
