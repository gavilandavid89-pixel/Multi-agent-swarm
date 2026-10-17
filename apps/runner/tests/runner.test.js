import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
test('runner avoids shell execution', () => {
  assert.match(source, /shell:\s*false/);
  assert.doesNotMatch(source, /execSync\(|exec\(/);
});
test('runner authenticates requests and rejects traversal paths', () => {
  assert.match(source, /x-swarm-runner-secret/);
  assert.match(source, /part !== '\.\.'/);
  assert.match(source, /startsWith\('\/'\)/);
});
test('runner applies runtime and output limits', () => {
  assert.match(source, /MAX_RUNTIME_MS/);
  assert.match(source, /MAX_OUTPUT_BYTES/);
  assert.match(source, /process\.kill\(-child\.pid, 'SIGKILL'\)/);
});
test('runner defaults to a restricted command allowlist', () => {
  assert.match(source, /\['npm', 'node', 'python3', 'pytest', 'xvfb-run', 'chromium'\]/);
});
