#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
workspace=${RUNNER_TEMP:-/tmp}/swarm-agent-sandbox-smoke
rm -rf "$workspace"
mkdir -p "$workspace"
trap 'docker compose -f docker-compose.runner-egress.yml down --remove-orphans >/dev/null 2>&1 || true; rm -rf "$workspace"' EXIT HUP INT TERM

cd "$repo_root"
docker build -t swarm-agent-runner:local -f apps/runner/Dockerfile apps/runner

# Writable workspace is available and the runner does not inherit arbitrary host env.
SWARM_SANDBOX_SENTINEL=must-not-leak sh scripts/run-agent-sandbox.sh "$workspace" node -e '
  const fs = require("node:fs");
  if (process.env.SWARM_SANDBOX_SENTINEL) process.exit(31);
  fs.writeFileSync("/workspace/result.txt", "sandbox-ok");
'
test "$(cat "$workspace/result.txt")" = "sandbox-ok"
echo "PASS writable isolated workspace; host sentinel not inherited"

cat > "$workspace/index.html" <<'HTML'
<!doctype html><html><head><title>Sandbox browser smoke</title></head><body><main id="app">browser-ok</main></body></html>
HTML
sh scripts/run-agent-sandbox.sh "$workspace" xvfb-run -a chromium --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check --dump-dom file:///workspace/index.html > "$workspace/dom.out"
grep -q 'browser-ok' "$workspace/dom.out"
echo "PASS Chromium rendered HTML under Xvfb"

# Network must be unavailable inside the sandbox.
sh scripts/run-agent-sandbox.sh "$workspace" node -e '
  fetch("https://example.com", { signal: AbortSignal.timeout(2500) })
    .then(() => process.exit(41))
    .catch(() => process.exit(0));
'
echo "PASS network disabled"

# Restricted mode is opt-in and routes only through an allowlisting proxy on an
# internal Docker network; test one approved package host and one denied host.
docker compose -f docker-compose.runner-egress.yml up --build -d
SWARM_RUNNER_NETWORK=restricted sh scripts/run-agent-sandbox.sh "$workspace" python3 -c '
import urllib.request
with urllib.request.urlopen("https://registry.npmjs.org/-/ping", timeout=10) as response:
    assert response.status == 200, response.status
'
echo "PASS restricted egress allows an explicitly approved package host"

set +e
SWARM_RUNNER_NETWORK=restricted sh scripts/run-agent-sandbox.sh "$workspace" python3 -c '
import urllib.request
try:
    urllib.request.urlopen("https://example.com", timeout=10)
except Exception:
    raise SystemExit(0)
raise SystemExit(41)
'
status=$?
set -e
if [ "$status" -ne 0 ]; then
  echo "FAIL restricted egress reached a non-allowlisted host" >&2
  exit 1
fi
echo "PASS restricted egress denies non-allowlisted hosts"

# Host-side timeout must terminate a long-running process.
set +e
SWARM_RUNNER_TIMEOUT_SECONDS=2 sh scripts/run-agent-sandbox.sh "$workspace" node -e 'setTimeout(() => {}, 15000)'
status=$?
set -e
if [ "$status" -ne 124 ]; then
  echo "FAIL expected timeout exit 124, got $status" >&2
  exit 1
fi
echo "PASS wall-clock timeout"

# Root filesystem is read-only; this write must fail.
set +e
sh scripts/run-agent-sandbox.sh "$workspace" node -e 'require("node:fs").writeFileSync("/etc/swarm-sandbox-must-not-write", "x")'
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "FAIL container root filesystem accepted a write" >&2
  exit 1
fi
echo "PASS root filesystem read-only"

echo "Agent sandbox smoke tests passed."
