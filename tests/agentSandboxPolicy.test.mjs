import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const wrapper = await readFile(new URL('../scripts/run-agent-sandbox.sh', import.meta.url), 'utf8');
const image = await readFile(new URL('../apps/runner/Dockerfile', import.meta.url), 'utf8');
const proxy = await readFile(new URL('../apps/runner/egress-proxy/squid.conf', import.meta.url), 'utf8');
const proxyDocker = await readFile(new URL('../apps/runner/egress-proxy/Dockerfile', import.meta.url), 'utf8');
const allowlist = await readFile(new URL('../apps/runner/egress-proxy/allowed-domains.txt', import.meta.url), 'utf8');
const compose = await readFile(new URL('../docker-compose.runner-egress.yml', import.meta.url), 'utf8');
const runnerApi = await readFile(new URL('../apps/runner-api/server.js', import.meta.url), 'utf8');
const workerClient = await readFile(new URL('../apps/worker/services/runnerClient.js', import.meta.url), 'utf8');

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

test('network is denied by default and restricted mode requires a fixed egress proxy', () => {
  assert.ok(wrapper.includes('network_mode=${SWARM_RUNNER_NETWORK:-none}'));
  assert.ok(wrapper.includes('docker_network=swarm-agent-egress'));
  assert.ok(wrapper.includes('--env HTTPS_PROXY=http://172.30.0.2:3128'));
  assert.ok(wrapper.includes('--dns 127.0.0.1'));
  assert.ok(wrapper.includes('docker network inspect "$docker_network"'));
  assert.ok(wrapper.includes('docker inspect --format'));
  assert.ok(wrapper.includes('swarm-egress-proxy no está healthy'));
  assert.ok(wrapper.includes('proxy_ip=$(docker inspect --format'));
  assert.ok(wrapper.includes('proxy_outbound_ip=$(docker inspect --format'));
  assert.ok(runnerApi.includes("proxyIp.stdout.trim() !== '172.30.0.2'"));
  assert.ok(wrapper.includes('home_relative'));
  assert.ok(wrapper.includes('network_is_internal=$(docker network inspect --format'));
  assert.ok(wrapper.includes('if [ "$network_is_internal" != true ]'));
  assert.ok(wrapper.includes('--network none'));
});

test('restricted egress proxy uses an internal runner network and default-deny allowlist', () => {
  assert.ok(compose.includes('internal: true'));
  assert.ok(compose.includes('name: swarm-agent-egress'));
  assert.ok(compose.includes('name: swarm-egress-outbound'));
  assert.ok(proxyDocker.includes('squidclient'));
  assert.ok(proxy.includes('http_access allow swarm_runner allowed_domains'));
  assert.ok(proxy.includes('http_access deny all'));
  assert.ok(proxy.includes('http_access deny private_dst'));
  assert.ok(proxy.includes('fc00::/7'));
  assert.ok(allowlist.includes('registry.npmjs.org'));
  assert.equal(allowlist.includes('*'), false);
});

test('only the requested project directory is mounted writable', () => {
  assert.ok(wrapper.includes('--mount "type=bind,src=$workspace,dst=/workspace"'));
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
    'gcc', 'g++', 'rustc', 'cargo', 'chromium', 'xvfb', 'xauth',
    'Godot_v4.4.1-stable_linux.x86_64.zip', 'SHA512-SUMS.txt', 'browser-smoke.mjs', 'godot-smoke.sh'
  ]) {
    assert.ok(image.includes(tool), `missing runner capability: ${tool}`);
  }
  assert.ok(image.includes('USER runner'));
  assert.ok(runnerApi.includes("'.godot'"));
  assert.ok(workerClient.includes("'.godot'"));
});
