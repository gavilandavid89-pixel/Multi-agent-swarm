import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [bridge, app] = await Promise.all([
  readFile(new URL('../apps/bridge/server.js', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/public/app.js', import.meta.url), 'utf8')
]);

test('server event stream is behind session auth and scopes job reads to the owner', () => {
  const auth = bridge.indexOf("app.use('/api', async (req, res, next) =>");
  const route = bridge.indexOf("app.get('/api/events'");
  assert.ok(auth >= 0 && route > auth, 'event stream must be registered after /api session middleware');
  assert.match(bridge.slice(route, bridge.indexOf("app.post('/api/jobs'", route)), /findSession\(req\.sessionToken\)/);
  assert.match(bridge.slice(route, bridge.indexOf("app.post('/api/jobs'", route)), /WHERE user_id=\$1/);
  assert.match(bridge.slice(route, bridge.indexOf("app.post('/api/jobs'", route)), /text\/event-stream/);
  assert.match(bridge.slice(route, bridge.indexOf("app.post('/api/jobs'", route)), /res\.on\('close', cleanup\)/);
});

test('browser event stream reconnects and aborts stale connections', () => {
  assert.match(app, /function stopTaskEventStream\(\)[\s\S]*?eventStreamController\?\.abort\(\)/);
  assert.match(app, /function startTaskEventStream\(\)[\s\S]*?stopTaskEventStream\(\)/);
  assert.match(app, /await pause\(3000\)/);
  assert.match(app, /eventName === 'task\.status'/);
});

test('password rotation restarts the stream with the replacement session token', () => {
  const rotation = app.indexOf("state.accessKey = result.token");
  assert.ok(rotation >= 0);
  const next = app.slice(rotation, rotation + 300);
  assert.match(next, /sessionStorage\.setItem\('swarm-session-token', result\.token\)/);
  assert.match(next, /startTaskEventStream\(\)/);
});
