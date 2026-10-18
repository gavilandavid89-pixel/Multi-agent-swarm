import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const wrapper = await readFile(new URL('../scripts/run-agent-sandbox.sh', import.meta.url), 'utf8');
const image = await readFile(new URL('../apps/runner/Dockerfile', import.meta.url), 'utf8');

test('agent sandbox disables network and uses a read-only container root', () => {
  for (const flag of [
    '--network none',
    '--read-only',
    '--cap-drop ALL',
    '--security-opt no-new-privileges:true'
  ]) assert.ok(wrapper.includes(flag), `missing security control: ${flag}`);
});

test('agent sandbox applies process, memory, CPU and wall-clock limits', () => {
  for (const flag of [
    '--pids-limit "$pids_limit"',
    '--memory "$memory_limit"',
    '--cpus "$cpu_limit"',
    '--tmpfs /tmp:rw,nosuid,nodev,size=512m'
  ]) assert.ok(wrapper.includes(flag), `missing resource limit: ${flag}`);
  assert.ok(wrapper.includes('timeout --signal=TERM --kill-after=5s'));
});

test('only the requested project directory is mounted writable', () => {
  assert.ok(wrapper.includes('--mount "type=bind,src=$workspace,dst=/workspace,rw"'));
  assert.equal(wrapper.includes('/var/run/docker.sock'), false);
  assert.equal(wrapper.includes('--privileged'), false);
  assert.equal(wrapper.includes('--network host'), false);
  assert.ok(wrapper.includes('--env HOME=/tmp'));
  assert.equal(wrapper.includes('--env-file'), false);
});

test('runner image includes common language toolchains and browser tools', () => {
  for (const tool of [
    'node:22-bookworm-slim', 'python3', 'python3-pytest',
    'default-jdk-headless', 'golang-go', 'php-cli', 'ruby-full',
    'gcc', 'g++', 'rustc', 'cargo', 'chromium', 'xvfb', 'xauth'
  ]) {
    assert.ok(image.includes(tool), `missing runner capability: ${tool}`);
  }
  assert.ok(image.includes('USER runner'));
});
