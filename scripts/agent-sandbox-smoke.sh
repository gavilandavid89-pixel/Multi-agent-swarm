#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
workspace=${RUNNER_TEMP:-/tmp}/swarm-agent-sandbox-smoke
rm -rf "$workspace"
mkdir -p "$workspace"
api_pid=
cleanup() {
  if [ -n "$api_pid" ]; then kill "$api_pid" >/dev/null 2>&1 || true; wait "$api_pid" 2>/dev/null || true; fi
  docker compose -f docker-compose.runner-egress.yml down --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$workspace"
}
trap cleanup EXIT HUP INT TERM

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
# Confirm the X server starts and exposes a usable display before testing the browser.
sh scripts/run-agent-sandbox.sh "$workspace" xvfb-run -a timeout --signal=TERM --kill-after=2s 10s xdpyinfo >/dev/null
echo "PASS Xvfb starts a usable X11 display"

# Headless Chromium has deterministic process lifetime; a separate timeout catches hangs
# without consuming the runner's full 120-second outer deadline.
sh scripts/run-agent-sandbox.sh "$workspace" timeout --signal=TERM --kill-after=3s 25s chromium \
  --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --disable-background-networking --disable-extensions --no-first-run \
  --no-default-browser-check --user-data-dir=/tmp/swarm-chrome-profile \
  --dump-dom file:///workspace/index.html > "$workspace/dom.out"
grep -q 'browser-ok' "$workspace/dom.out"
echo "PASS Chromium rendered HTML with a bounded headless run"

# Exercise the authenticated Worker-facing API against the actual Docker daemon.
RUNNER_SHARED_SECRET=runner-smoke-secret-32-characters-min \
RUNNER_API_SENTINEL=must-not-leak \
RUNNER_STATE_DIR="$workspace/runner-api-state" \
PORT=3200 node apps/runner-api/server.js > "$workspace/runner-api.log" 2>&1 &
api_pid=$!
ready=0
i=0
while [ "$i" -lt 45 ]; do
  if curl -fsS http://127.0.0.1:3200/readyz >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$api_pid" >/dev/null 2>&1; then cat "$workspace/runner-api.log" >&2; exit 1; fi
  sleep 1
  i=$((i + 1))
done
if [ "$ready" -ne 1 ]; then cat "$workspace/runner-api.log" >&2; echo "FAIL runner API readiness timeout" >&2; exit 1; fi

unauthorized=$(curl -sS -o "$workspace/unauthorized.json" -w '%{http_code}' -X POST http://127.0.0.1:3200/v1/jobs -H 'content-type: application/json' -d '{}')
if [ "$unauthorized" != 401 ]; then echo "FAIL runner API accepted unauthenticated request ($unauthorized)" >&2; exit 1; fi
echo "PASS runner API rejects unauthenticated requests"

job_body=$(node -e 'process.stdout.write(JSON.stringify({
  files:[{path:"main.js",content:"console.log(\"input-file-ok\")\n"}],
  command:["node","-e","const fs=require(\"node:fs\"); if(process.env.RUNNER_SHARED_SECRET||process.env.RUNNER_API_SENTINEL) process.exit(41); fs.writeFileSync(\"generated.txt\",\"artifact-ok\"); console.log(\"runner-api-ok\")"],
  workspaceId:"11111111-1111-4111-8111-111111111111",resetWorkspace:true,
  network:"none",timeoutMs:15000
}))')
created=$(curl -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-api-job-0001' \
  -d "$job_body")
job_id=$(printf '%s' "$created" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
if [ -z "$job_id" ]; then echo "FAIL runner API did not return a job ID: $created" >&2; exit 1; fi
job_json=
i=0
while [ "$i" -lt 60 ]; do
  job_json=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$job_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
  state=$(printf '%s' "$job_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  case "$state" in succeeded|failed|timed_out|cancelled) break ;; esac
  sleep 1
  i=$((i + 1))
done
printf '%s' "$job_json" | node -e '
let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
  const j=JSON.parse(s);
  if(j.status!=="succeeded" || !String(j.stdout||"").includes("runner-api-ok") || j.exitCode!==0) {
    console.error("FAIL runner API execution:", JSON.stringify(j)); process.exit(1);
  }
})'
artifacts=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$job_id"/files -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
printf '%s' "$artifacts" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const f=JSON.parse(s).files||[];if(!f.some(x=>x.path==="generated.txt"&&x.content==="artifact-ok"))process.exit(1)})'
repeat=$(curl -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-api-job-0001' \
  -d "$job_body")
repeat_id=$(printf '%s' "$repeat" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
if [ "$repeat_id" != "$job_id" ]; then echo "FAIL runner API idempotency returned a duplicate job" >&2; exit 1; fi

step_body=$(node -e 'process.stdout.write(JSON.stringify({
  files:[],workspaceId:"11111111-1111-4111-8111-111111111111",resetWorkspace:false,
  command:["node","-e","const fs=require(\"node:fs\"); if(!fs.readFileSync(\"generated.txt\",\"utf8\").includes(\"artifact-ok\")) process.exit(42); fs.writeFileSync(\"second-step.txt\",\"workspace-reused\"); console.log(\"runner-api-step-2-ok\")"],
  network:"none",timeoutMs:15000
}))')
second=$(curl -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-api-job-0002' \
  -d "$step_body")
second_id=$(printf '%s' "$second" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
second_json=
i=0
while [ "$i" -lt 60 ]; do
  second_json=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$second_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
  state=$(printf '%s' "$second_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  case "$state" in succeeded|failed|timed_out|cancelled) break ;; esac
  sleep 1
  i=$((i + 1))
done
printf '%s' "$second_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.status!=="succeeded"||!String(j.stdout||"").includes("runner-api-step-2-ok")){console.error(JSON.stringify(j));process.exit(1)}})'
second_artifacts=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$second_id"/files -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
printf '%s' "$second_artifacts" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const f=JSON.parse(s).files||[];if(!f.some(x=>x.path==="second-step.txt"&&x.content==="workspace-reused"))process.exit(1)})'
echo "PASS runner API idempotency and sequential task-scoped workspace reuse"
echo "PASS authenticated runner API executes in bounded tmpfs and returns artifacts"

timeout_body=$(node -e 'process.stdout.write(JSON.stringify({
  files:[],workspaceId:"33333333-3333-4333-8333-333333333333",resetWorkspace:true,
  command:["node","-e","setTimeout(()=>{},30000)"],network:"none",timeoutMs:2000
}))')
timeout_job=$(curl -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-api-timeout-01' \
  -d "$timeout_body")
timeout_id=$(printf '%s' "$timeout_job" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
timeout_json=
i=0
while [ "$i" -lt 30 ]; do
  timeout_json=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$timeout_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
  state=$(printf '%s' "$timeout_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  case "$state" in succeeded|failed|timed_out|cancelled) break ;; esac
  sleep 1
  i=$((i + 1))
done
printf '%s' "$timeout_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.status!=="timed_out"||j.timedOut!==true){console.error("FAIL API timeout enforcement:",JSON.stringify(j));process.exit(1)}})'
echo "PASS runner API kills timed-out executions"

# Network must be unavailable inside the sandbox.
sh scripts/run-agent-sandbox.sh "$workspace" node -e '
  fetch("https://example.com", { signal: AbortSignal.timeout(2500) })
    .then(() => process.exit(41))
    .catch(() => process.exit(0));
'
echo "PASS network disabled"

# Restricted mode is opt-in and routes only through an allowlisting proxy on an
# internal Docker network; test one approved package host and one denied host.
docker compose -f docker-compose.runner-egress.yml config -q
if ! docker compose -f docker-compose.runner-egress.yml up --build -d --wait --wait-timeout 60; then
  docker compose -f docker-compose.runner-egress.yml logs --no-color swarm-egress-proxy >&2 || true
  exit 1
fi
SWARM_RUNNER_NETWORK=restricted sh scripts/run-agent-sandbox.sh "$workspace" python3 -c '
import urllib.request
with urllib.request.urlopen("https://registry.npmjs.org/-/ping", timeout=10) as response:
    assert response.status == 200, response.status
'
echo "PASS restricted egress allows an explicitly approved package host"

# Verify the API's own restricted-network mode, not just the local wrapper.
api_network_body=$(node -e 'process.stdout.write(JSON.stringify({
  files:[],workspaceId:"22222222-2222-4222-8222-222222222222",resetWorkspace:true,
  command:["python3","-c","import urllib.request; r=urllib.request.urlopen(\\"https://registry.npmjs.org/-/ping\\",timeout=10); assert r.status==200"],
  network:"restricted",timeoutMs:15000
}))')
api_network_job=$(curl -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-api-egress-0001' \
  -d "$api_network_body")
api_network_id=$(printf '%s' "$api_network_job" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
api_network_json=
i=0
while [ "$i" -lt 60 ]; do
  api_network_json=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$api_network_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
  state=$(printf '%s' "$api_network_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  case "$state" in succeeded|failed|timed_out|cancelled) break ;; esac
  sleep 1
  i=$((i + 1))
done
printf '%s' "$api_network_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.status!=="succeeded"||j.exitCode!==0){console.error("FAIL API restricted egress:",JSON.stringify(j));process.exit(1)}})'
echo "PASS runner API restricted mode reaches allowlisted package host"

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

set +e
SWARM_RUNNER_NETWORK=restricted sh scripts/run-agent-sandbox.sh "$workspace" python3 -c '
import socket
try:
    socket.getaddrinfo("example.com", 443)
except OSError:
    raise SystemExit(0)
raise SystemExit(42)
'
status=$?
set -e
if [ "$status" -ne 0 ]; then
  echo "FAIL ordinary DNS resolution worked inside restricted mode" >&2
  exit 1
fi
echo "PASS ordinary DNS resolution disabled inside restricted mode"

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
