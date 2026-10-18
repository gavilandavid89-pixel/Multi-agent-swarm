import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const wrapper = await readFile(new URL('../scripts/run-agent-sandbox.sh', import.meta.url), 'utf8');
const image = await readFile(new URL('../apps/runner/Dockerfile', import.meta.url), 'utf8');

test('agent sandbox disables network and uses a read-only container root', () => {
  assert.match(wrapper, /--network none/);
  assert.match(wrapper, /--read-only/);
  assert.match(wrapper, /--cap-drop ALL/);
  assert.match(wrapper, /--security-opt no-new-privileges:true/);
});

test('agent sandbox applies process, memory, CPU and wall-clock limits', () => {
  assert.match(wrapper, /--pids-limit "\$pids_limit"/);
  assert.match(wrapper, /--memory "\$memory_limit"/);
  assert.match(wrapper, /--cpus "\$cpu_limit"/);
  assert.match(wrapper, /timeout --signal=TERM --kill-after=5s/);
  assert.match(wrapper, /--tmpfs \/tmp:rw,nosuid,nodev,size=512m/);
});

test('only the requested project directory is mounted writable', () => {
  assert.match(wrapper, /--mount "type=bind,src=\$workspace,dst=\/workspace,rw"/);
  assert.doesNotMatch(wrapper, /\/var\/run\/docker\.sock/);
  assert.doesNotMatch(wrapper, /--privileged/);
  assert.doesNotMatch(wrapper, /--network host/);
  assert.match(wrapper, /--env HOME=\/tmp/);
  assert.doesNotMatch(wrapper, /docker run[^\n]*--env-file/);
});

test('runner image includes common language toolchains and browser tools', () => {
  for (const tool of [
    'node:22-bookworm-slim', 'python3', 'python3-pytest',
    'default-jdk-headless', 'golang-go', 'php-cli', 'ruby-full',
    'gcc', 'g++', 'rustc', 'cargo', 'chromium', 'xvfb', 'xauth'
  ]) {
    assert.ok(image.includes(tool), `missing runner capability: ${tool}`);
  }
  assert.match(image, /USER runner/);
});
