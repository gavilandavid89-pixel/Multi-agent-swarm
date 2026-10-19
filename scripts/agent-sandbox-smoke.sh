#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
workspace=${RUNNER_TEMP:-/tmp}/swarm-agent-sandbox-smoke
rm -rf "$workspace"
mkdir -p "$workspace"
api_pid=
proxy_started_by_smoke=0
cleanup() {
  if [ -n "$api_pid" ]; then kill "$api_pid" >/dev/null 2>&1 || true; wait "$api_pid" 2>/dev/null || true; fi
  if [ "$proxy_started_by_smoke" -eq 1 ]; then docker compose -f docker-compose.runner-egress.yml down --remove-orphans >/dev/null 2>&1 || true; fi
  rm -rf "$workspace" "${workspace}-runner-state" "${workspace}-runner-api.log" "${workspace}-unauthorized.json" "${workspace}-secret-rejection.json" "${workspace}-capabilities.json" "${workspace}-create-response.json"
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

# The image must contain every documented language/runtime and helper tool.
capability_result=$(sh scripts/run-agent-sandbox.sh "$workspace" bash /opt/swarm-runner/capabilities-smoke.sh)
printf '%s\\n' "$capability_result" | grep -q 'SWARM_RUNNER_CAPABILITIES_CHECKED=1'
echo "PASS runner toolchain inventory matches the machine-readable catalog"

# Headless Chromium has deterministic process lifetime; a separate timeout catches hangs
# without consuming the runner's full 120-second outer deadline.
sh scripts/run-agent-sandbox.sh "$workspace" timeout --signal=TERM --kill-after=3s 25s chromium \
  --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --disable-background-networking --disable-extensions --no-first-run \
  --no-default-browser-check --user-data-dir=/tmp/swarm-chrome-profile \
  --dump-dom file:///workspace/index.html > "$workspace/dom.out"
grep -q 'browser-ok' "$workspace/dom.out"
echo "PASS Chromium rendered HTML with a bounded headless run"

browser_result=$(sh scripts/run-agent-sandbox.sh "$workspace" node /opt/swarm-runner/browser-smoke.mjs)
printf '%s\n' "$browser_result" | grep -q 'SWARM_BROWSER_CHECKED=1'
echo "PASS isolated Chromium/Xvfb browser smoke script detects JavaScript runtime errors"

cp "$workspace/index.html" "$workspace/index.html.good"
cat > "$workspace/index.html" <<'HTML'
<!doctype html><html><head></head><body><script>throw new Error("browser-error-detection")</script></body></html>
HTML
set +e
sh scripts/run-agent-sandbox.sh "$workspace" node /opt/swarm-runner/browser-smoke.mjs > "$workspace/browser-error.log" 2>&1
browser_error_status=$?
set -e
mv "$workspace/index.html.good" "$workspace/index.html"
if [ "$browser_error_status" -eq 0 ] || ! grep -q 'browser-error-detection' "$workspace/browser-error.log"; then
  echo "FAIL isolated browser checker did not report a JavaScript runtime exception" >&2
  cat "$workspace/browser-error.log" >&2
  exit 1
fi
echo "PASS isolated browser smoke rejects a deliberate JavaScript exception"

mkdir -p "$workspace/godot-smoke"
cat > "$workspace/godot-smoke/project.godot" <<'GODOT'
config_version=5

[application]
config/name="Swarm Runner Smoke"
run/main_scene="res://main.tscn"

[rendering]
renderer/rendering_method="gl_compatibility"
GODOT
cat > "$workspace/godot-smoke/main.tscn" <<'SCENE'
[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://main.gd" id="1"]

[node name="Main" type="Node"]
script = ExtResource("1")
SCENE
cat > "$workspace/godot-smoke/main.gd" <<'GDSCRIPT'
extends Node

func _ready() -> void:
    print("godot-runner-ok")
GDSCRIPT
godot_result=$(sh scripts/run-agent-sandbox.sh "$workspace" bash -lc 'cd /workspace/godot-smoke && bash /opt/swarm-runner/godot-smoke.sh')
printf '%s\n' "$godot_result" | grep -q 'SWARM_GODOT_CHECKED=1'
echo "PASS pinned Godot headless import, script parsing and project startup"

# Exercise the authenticated Worker-facing API against the actual Docker daemon.
RUNNER_SHARED_SECRET=runner-smoke-secret-32-characters-min \
RUNNER_API_SENTINEL=must-not-leak \
RUNNER_STATE_DIR="${workspace}-runner-state" \
PORT=3200 node apps/runner-api/server.js > "${workspace}-runner-api.log" 2>&1 &
api_pid=$!
ready=0
i=0
while [ "$i" -lt 100 ]; do
  if curl -fsS http://127.0.0.1:3200/readyz >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$api_pid" >/dev/null 2>&1; then cat "${workspace}-runner-api.log" >&2; exit 1; fi
  sleep 1
  i=$((i + 1))
done
if [ "$ready" -ne 1 ]; then cat "${workspace}-runner-api.log" >&2; echo "FAIL runner API readiness timeout" >&2; exit 1; fi

unauthorized=$(curl -sS -o "${workspace}-unauthorized.json" -w '%{http_code}' -X POST http://127.0.0.1:3200/v1/jobs -H 'content-type: application/json' -d '{}')
if [ "$unauthorized" != 401 ]; then echo "FAIL runner API accepted unauthenticated request ($unauthorized)" >&2; exit 1; fi
echo "PASS runner API rejects unauthenticated requests"

restricted_stdin_body=$(node -e 'process.stdout.write(JSON.stringify({files:[],command:["python3","-m","pdb"],network:"restricted",timeoutMs:5000,stdin:"q\\n"}))')
restricted_stdin_status=$(curl --max-time 10 -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -d "$restricted_stdin_body")
if [ "$restricted_stdin_status" != 400 ]; then echo "FAIL runner accepted debugger stdin with restricted networking ($restricted_stdin_status)" >&2; exit 1; fi
non_debugger_stdin_body=$(node -e 'process.stdout.write(JSON.stringify({files:[],command:["node","-e","process.stdout.write(String.fromCharCode(111,107))"],network:"none",timeoutMs:5000,stdin:"q\n"}))')
non_debugger_stdin_status=$(curl --max-time 10 -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -d "$non_debugger_stdin_body")
if [ "$non_debugger_stdin_status" != 400 ]; then echo "FAIL runner accepted stdin for a non-debugger command ($non_debugger_stdin_status)" >&2; exit 1; fi
oversize_stdin_body=$(node -e 'process.stdout.write(JSON.stringify({files:[],command:["python3","-m","pdb"],network:"none",timeoutMs:5000,stdin:"x".repeat(16385)}))')
oversize_stdin_status=$(curl --max-time 10 -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -d "$oversize_stdin_body")
if [ "$oversize_stdin_status" != 413 ]; then echo "FAIL runner accepted oversized debugger stdin ($oversize_stdin_status)" >&2; exit 1; fi
echo "PASS runner rejects debugger input with network egress and enforces the 16 KiB limit"

capabilities_status=$(curl -sS -o "${workspace}-capabilities.json" -w '%{http_code}' http://127.0.0.1:3200/v1/capabilities -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
if [ "$capabilities_status" != 200 ]; then echo "FAIL authenticated capability discovery HTTP $capabilities_status" >&2; exit 1; fi
node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(c.schemaVersion!==1||c.execution.defaultNetwork!=="none"||!c.toolchains.some(x=>x.id==="typescript")||!c.toolchains.some(x=>x.id==="godot")) process.exit(51)' "${workspace}-capabilities.json"
echo "PASS authenticated capability discovery exposes the supported toolchains and safety defaults"

secret_body=$(node -e 'process.stdout.write(JSON.stringify({
  files:[{path:"id_rsa",content:"-----BEGIN OPENSSH PRIVATE KEY-----\\nnot-a-real-key\\n-----END OPENSSH PRIVATE KEY-----"}],
  command:["true"],network:"none",timeoutMs:5000
}))')
secret_status=$(curl -sS -o "${workspace}-secret-rejection.json" -w '%{http_code}' -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-api-secret-01' \
  -d "$secret_body")
if [ "$secret_status" != 400 ]; then echo "FAIL runner API accepted a credential-like file path ($secret_status)" >&2; exit 1; fi
echo "PASS runner API rejects credential-like paths before job creation"

job_body=$(node -e 'process.stdout.write(JSON.stringify({
  files:[{path:"main.js",content:"console.log(\"input-file-ok\")\n"},{path:"deleted.txt",content:"remove-me"}],
  command:["node","-e","const fs=require(\"node:fs\"); if(process.env.RUNNER_SHARED_SECRET||process.env.RUNNER_API_SENTINEL) process.exit(41); if(process.cwd()!==\"/workspace\") {console.error(\"unexpected cwd=\"+process.cwd()); process.exit(43)} fs.writeFileSync(\"/workspace/main.js\",\"main-modified\"); fs.unlinkSync(\"/workspace/deleted.txt\"); fs.writeFileSync(\"/workspace/generated.txt\",\"artifact-ok\"); fs.writeFileSync(\"/workspace/credential-output.txt\",\"-----BEGIN OPENSSH PRIVATE KEY-----\\\\nnot-a-real-key\\\\n-----END OPENSSH PRIVATE KEY-----\"); console.log(\"runner-api-ok cwd=\"+process.cwd()); console.error(\"runner-stderr-ok\")"],
  workspaceId:"11111111-1111-4111-8111-111111111111",resetWorkspace:true,
  network:"none",timeoutMs:15000
}))')
create_status=$(curl --max-time 20 -sS -o "${workspace}-create-response.json" -w '%{http_code}' -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-api-job-0001' \
  -d "$job_body") || { echo "FAIL runner API job-creation request failed" >&2; exit 1; }
created=$(cat "${workspace}-create-response.json")
if [ "$create_status" != 202 ]; then echo "FAIL runner API job creation HTTP $create_status: $created" >&2; exit 1; fi
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
  if(j.status!=="succeeded" || !String(j.stdout||"").includes("runner-api-ok") || !String(j.stderr||"").includes("runner-stderr-ok") || j.exitCode!==0) {
    console.error("FAIL runner API execution:", JSON.stringify(j)); process.exit(1);
  }
})'
artifacts=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$job_id"/files -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
printf '%s' "$artifacts" | SWARM_JOB_JSON="$job_json" node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const f=JSON.parse(s).files||[];if(!f.some(x=>x.path==="generated.txt"&&x.content==="artifact-ok")||!f.some(x=>x.path==="main.js"&&x.content==="main-modified")||f.some(x=>x.path==="deleted.txt")){console.error("FAIL missing generated artifact",JSON.stringify({files:f,job:JSON.parse(process.env.SWARM_JOB_JSON||"{}")}));process.exit(1)}if(f.some(x=>x.path==="credential-output.txt"||x.path===".env.generated")){console.error("FAIL sensitive-path output was returned",JSON.stringify(f));process.exit(1)}})'
repeat=$(curl -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-api-job-0001' \
  -d "$job_body")
repeat_id=$(printf '%s' "$repeat" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
if [ "$repeat_id" != "$job_id" ]; then echo "FAIL runner API idempotency returned a duplicate job" >&2; exit 1; fi

set +e
conflict_status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-api-job-0001' \
  -d "$(printf '%s' "$job_body" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);j.timeoutMs=14000;process.stdout.write(JSON.stringify(j))})')" )
set -e
if [ "$conflict_status" != 409 ]; then echo "FAIL runner API accepted a changed request with a reused idempotency key ($conflict_status)" >&2; exit 1; fi
echo "PASS runner API rejects idempotency-key collisions with changed payloads"

step_body=$(node -e 'process.stdout.write(JSON.stringify({
  files:[],workspaceId:"11111111-1111-4111-8111-111111111111",resetWorkspace:false,
  command:["node","-e","const fs=require(\"node:fs\"); if(!fs.readFileSync(\"/workspace/generated.txt\",\"utf8\").includes(\"artifact-ok\")) process.exit(42); fs.writeFileSync(\"/workspace/second-step.txt\",\"workspace-reused\"); console.log(\"runner-api-step-2-ok cwd=\"+process.cwd())"],
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
printf '%s' "$second_artifacts" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const f=JSON.parse(s).files||[];if(!f.some(x=>x.path==="second-step.txt"&&x.content==="workspace-reused")){console.error("FAIL missing reused-workspace artifact",JSON.stringify(f));process.exit(1)}})'
echo "PASS runner API idempotency and sequential task-scoped workspace reuse"
echo "PASS authenticated runner API executes in bounded tmpfs and returns artifacts"

# Simulate an abrupt Runner API process loss during an active job. The next
# process must recover the persisted job as failed, keep its old idempotency
# key bound to that failed job, and accept a fresh key for an explicit retry.
restart_body=$(node -e 'process.stdout.write(JSON.stringify({
  files:[],workspaceId:"22222222-2222-4222-8222-222222222222",resetWorkspace:true,
  command:["node","-e","setTimeout(() => console.log(\"should-not-finish\"), 60000)"],
  network:"none",timeoutMs:90000
}))')
restart_create=$(curl --max-time 20 -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-restart-active-01' \
  -d "$restart_body")
restart_id=$(printf '%s' "$restart_create" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
if [ -z "$restart_id" ]; then echo "FAIL runner restart smoke did not create a job" >&2; exit 1; fi
restart_state=
i=0
while [ "$i" -lt 20 ]; do
  restart_state=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$restart_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  [ "$restart_state" = "running" ] && break
  case "$restart_state" in failed|timed_out|cancelled|succeeded) echo "FAIL restart smoke job ended before API restart ($restart_state)" >&2; exit 1 ;; esac
  sleep 1
  i=$((i + 1))
done
if [ "$restart_state" != "running" ]; then echo "FAIL restart smoke job never entered running state ($restart_state)" >&2; exit 1; fi
restart_cid_file="${workspace}-runner-state/jobs/${restart_id}.cid"
restart_cid=
i=0
while [ "$i" -lt 40 ]; do
  if [ -s "$restart_cid_file" ]; then
    restart_cid=$(cat "$restart_cid_file")
    if [ "$(docker inspect --format '{{.State.Running}}' "$restart_cid" 2>/dev/null || true)" = "true" ]; then break; fi
  fi
  sleep 1
  i=$((i + 1))
done
if [ -z "$restart_cid" ] || [ "$(docker inspect --format '{{.State.Running}}' "$restart_cid" 2>/dev/null || true)" != "true" ]; then echo "FAIL restart smoke could not confirm a live container before killing the API" >&2; exit 1; fi

# Queue a second, independent job behind the active job. After the API process
# is killed, the active job must fail closed while the queued job is recovered
# and executed exactly once by the new process.
queued_body=$(node -e 'process.stdout.write(JSON.stringify({
  files:[],workspaceId:"33333333-3333-4333-8333-333333333333",resetWorkspace:true,
  command:["node","-e","console.log(731045)"],
  network:"none",timeoutMs:15000
}))')
queued_create=$(curl --max-time 20 -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-restart-queued-03' \
  -d "$queued_body")
queued_id=$(printf '%s' "$queued_create" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
if [ -z "$queued_id" ] || [ "$queued_id" = "$restart_id" ]; then echo "FAIL restart smoke did not create an independent queued job" >&2; exit 1; fi
queued_state=
i=0
while [ "$i" -lt 10 ]; do
  queued_state=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$queued_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  [ "$queued_state" = "queued" ] && break
  sleep 1
  i=$((i + 1))
done
if [ "$queued_state" != "queued" ]; then echo "FAIL restart smoke second job was not queued behind active job ($queued_state)" >&2; exit 1; fi
kill -9 "$api_pid" >/dev/null 2>&1 || true
wait "$api_pid" 2>/dev/null || true
api_pid=
RUNNER_SHARED_SECRET=runner-smoke-secret-32-characters-min \
RUNNER_API_SENTINEL=must-not-leak \
RUNNER_STATE_DIR="${workspace}-runner-state" \
PORT=3200 node apps/runner-api/server.js >> "${workspace}-runner-api.log" 2>&1 &
api_pid=$!
ready=0
i=0
while [ "$i" -lt 100 ]; do
  if curl -fsS http://127.0.0.1:3200/readyz >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$api_pid" >/dev/null 2>&1; then cat "${workspace}-runner-api.log" >&2; exit 1; fi
  sleep 1
  i=$((i + 1))
done
if [ "$ready" -ne 1 ]; then cat "${workspace}-runner-api.log" >&2; echo "FAIL runner API did not recover after process restart" >&2; exit 1; fi
recovered_job=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$restart_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
printf '%s' "$recovered_job" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.status!=="failed"||!String(j.error||"").includes("servicio se reinició")){console.error("FAIL restart recovery state",JSON.stringify(j));process.exit(1)}})'

queued_json=
i=0
while [ "$i" -lt 30 ]; do
  queued_json=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$queued_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
  queued_state=$(printf '%s' "$queued_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  case "$queued_state" in succeeded|failed|timed_out|cancelled) break ;; esac
  sleep 1
  i=$((i + 1))
done
printf '%s' "$queued_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.status!=="succeeded"||!String(j.stdout||"").includes("731045")){console.error("FAIL queued job was not resumed after runner API restart",JSON.stringify(j));process.exit(1)}})'
echo "PASS queued job survives API restart and runs once while interrupted active job fails closed"
# Verify completed jobs, their artifacts, and their idempotency records survive
# the same API restart, not just queued/active job recovery.
persisted_completed=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$job_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
printf '%s' "$persisted_completed" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.status!=="succeeded"||!String(j.stdout||"").includes("runner-api-ok")){console.error("FAIL completed job did not survive API restart",JSON.stringify(j));process.exit(1)}})'
persisted_artifacts=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$job_id"/files -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
printf '%s' "$persisted_artifacts" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const f=JSON.parse(s).files||[];if(!f.some(x=>x.path==="generated.txt"&&x.content==="artifact-ok")){console.error("FAIL completed job artifacts did not survive API restart",JSON.stringify(f));process.exit(1)}})'
persisted_repeat=$(curl -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-api-job-0001' \
  -d "$job_body")
persisted_repeat_id=$(printf '%s' "$persisted_repeat" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
if [ "$persisted_repeat_id" != "$job_id" ]; then echo "FAIL completed idempotency record did not survive API restart" >&2; exit 1; fi
echo "PASS completed job state, artifacts, and idempotency survive Runner API restart"

same_queued_job=$(curl -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-restart-queued-03' \
  -d "$queued_body")
same_queued_id=$(printf '%s' "$same_queued_job" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
if [ "$same_queued_id" != "$queued_id" ]; then echo "FAIL queued recovery idempotency created a duplicate job" >&2; exit 1; fi
same_restart_job=$(curl -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-restart-active-01' \
  -d "$restart_body")
same_restart_id=$(printf '%s' "$same_restart_job" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
if [ "$same_restart_id" != "$restart_id" ]; then echo "FAIL recovered idempotency key created a duplicate instead of returning the failed job" >&2; exit 1; fi
retry_body=$(node -e 'process.stdout.write(JSON.stringify({
  files:[],workspaceId:"22222222-2222-4222-8222-222222222222",resetWorkspace:false,
  command:["node","-e","console.log(\"runner-restart-retry-ok\")"],
  network:"none",timeoutMs:15000
}))')
retry_create=$(curl --max-time 20 -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-restart-retry-02' \
  -d "$retry_body")
retry_id=$(printf '%s' "$retry_create" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
if [ -z "$retry_id" ] || [ "$retry_id" = "$restart_id" ]; then echo "FAIL fresh idempotency key did not create a retry job" >&2; exit 1; fi
retry_json=
i=0
while [ "$i" -lt 30 ]; do
  retry_json=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$retry_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
  retry_state=$(printf '%s' "$retry_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  case "$retry_state" in succeeded|failed|timed_out|cancelled) break ;; esac
  sleep 1
  i=$((i + 1))
done
printf '%s' "$retry_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.status!=="succeeded"||!String(j.stdout||"").includes("runner-restart-retry-ok")){console.error("FAIL runner retry after restart",JSON.stringify(j));process.exit(1)}})'
echo "PASS Runner API restart recovery and explicit idempotent retry"

# Kill an execution container while the API stays alive. The job must fail closed,
# the API must remain healthy, and a later job (the pdb smoke below) must still run.
container_crash_body=$(node -e 'process.stdout.write(JSON.stringify({
  files:[],workspaceId:"66666666-6666-4666-8666-666666666666",resetWorkspace:true,
  command:["node","-e","setTimeout(() => console.log(String.fromCharCode(110,111,112,101)), 60000)"],
  network:"none",timeoutMs:90000
}))')
container_crash_create=$(curl --max-time 20 -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-container-crash-01' \
  -d "$container_crash_body")
container_crash_id=$(printf '%s' "$container_crash_create" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
if [ -z "$container_crash_id" ]; then echo "FAIL container-crash smoke did not create a job" >&2; exit 1; fi
container_crash_state=
i=0
while [ "$i" -lt 20 ]; do
  container_crash_state=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$container_crash_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  [ "$container_crash_state" = "running" ] && break
  case "$container_crash_state" in failed|timed_out|cancelled|succeeded) echo "FAIL container-crash job ended before forced container termination ($container_crash_state)" >&2; exit 1 ;; esac
  sleep 1
  i=$((i + 1))
done
if [ "$container_crash_state" != "running" ]; then echo "FAIL container-crash job never entered running state ($container_crash_state)" >&2; exit 1; fi
container_crash_cid_file="${workspace}-runner-state/jobs/${container_crash_id}.cid"
container_crash_cid=
i=0
while [ "$i" -lt 40 ]; do
  if [ -s "$container_crash_cid_file" ]; then
    container_crash_cid=$(cat "$container_crash_cid_file")
    if [ "$(docker inspect --format '{{.State.Running}}' "$container_crash_cid" 2>/dev/null || true)" = "true" ]; then break; fi
  fi
  sleep 1
  i=$((i + 1))
done
if [ -z "$container_crash_cid" ] || [ "$(docker inspect --format '{{.State.Running}}' "$container_crash_cid" 2>/dev/null || true)" != "true" ]; then echo "FAIL container-crash smoke could not confirm a live execution container" >&2; exit 1; fi
docker kill "$container_crash_cid" >/dev/null
container_crash_json=
i=0
while [ "$i" -lt 30 ]; do
  container_crash_json=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$container_crash_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
  container_crash_state=$(printf '%s' "$container_crash_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  case "$container_crash_state" in failed|timed_out|cancelled|succeeded) break ;; esac
  sleep 1
  i=$((i + 1))
done
printf '%s' "$container_crash_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.status!=="failed"||j.exitCode===0){console.error("FAIL forced execution-container termination was not reported as failure",JSON.stringify(j));process.exit(1)}})'
curl -fsS http://127.0.0.1:3200/readyz >/dev/null
echo "PASS execution-container crash fails closed while Runner API stays healthy"

# Exercise stdin-driven Python pdb through the authenticated runner API.
debug_body=$(node -e 'process.stdout.write(JSON.stringify({
  files:[{path:"debug_target.py",content:"print(\"debug target reached\")\n"}],
  workspaceId:"55555555-5555-4555-8555-555555555555",resetWorkspace:true,
  command:["python3","-m","pdb","debug_target.py"],stdin:"p 6 * 7\nq\n",
  network:"none",timeoutMs:15000
}))')
debug_created=$(curl --max-time 20 -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-debugger-01' \
  -d "$debug_body")
debug_id=$(printf '%s' "$debug_created" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
debug_json=
i=0
while [ "$i" -lt 20 ]; do
  debug_json=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$debug_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
  state=$(printf '%s' "$debug_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  case "$state" in succeeded|failed|timed_out|cancelled) break ;; esac
  sleep 1
  i=$((i + 1))
done
printf '%s' "$debug_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.status!=="succeeded"||j.exitCode!==0||!String(j.stdout||"").includes("42")){console.error("FAIL debugger stdin/output:",JSON.stringify(j));process.exit(1)}})'
echo "PASS runner accepts bounded debugger stdin and returns debugger output"

# Verify stdout is visible from GET /v1/jobs/:id before the process exits.
stream_body=$(node -e 'process.stdout.write(JSON.stringify({
  files:[],workspaceId:"88888888-8888-4888-8888-888888888888",resetWorkspace:true,
  command:["node","-e","console.log(\"stream-start\"); setTimeout(()=>console.log(\"stream-end\"),3000)"],
  network:"none",timeoutMs:10000
}))')
stream_created=$(curl --max-time 20 -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-live-output-01' \
  -d "$stream_body")
stream_id=$(printf '%s' "$stream_created" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
stream_partial=
i=0
while [ "$i" -lt 15 ]; do
  stream_partial=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$stream_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
  has_start=$(printf '%s' "$stream_partial" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.status==="running"&&String(j.stdout||"").includes("stream-start")?"yes":"no")})')
  [ "$has_start" = "yes" ] && break
  sleep 1
  i=$((i + 1))
done
if [ "$has_start" != "yes" ]; then echo "FAIL runner did not expose live stdout while running: $stream_partial" >&2; exit 1; fi
stream_final=
i=0
while [ "$i" -lt 15 ]; do
  stream_final=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$stream_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
  state=$(printf '%s' "$stream_final" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  case "$state" in succeeded|failed|timed_out|cancelled) break ;; esac
  sleep 1
  i=$((i + 1))
done
printf '%s' "$stream_final" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.status!=="succeeded"||j.exitCode!==0||!String(j.stdout||"").includes("stream-end")){console.error("FAIL final streamed output:",JSON.stringify(j));process.exit(1)}})'
echo "PASS runner exposes partial stdout while running and final output after exit"

# Verify active cancellation reaches a terminal cancelled state.
cancel_body=$(node -e 'process.stdout.write(JSON.stringify({
  files:[],workspaceId:"99999999-9999-4999-8999-999999999999",resetWorkspace:true,
  command:["node","-e","setInterval(()=>console.log(\"cancel-tick\"),1000)"],
  network:"none",timeoutMs:30000
}))')
cancel_created=$(curl --max-time 20 -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-cancel-active-01' \
  -d "$cancel_body")
cancel_id=$(printf '%s' "$cancel_created" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
i=0
while [ "$i" -lt 15 ]; do
  cancel_state=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$cancel_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  [ "$cancel_state" = "running" ] && break
  sleep 1
  i=$((i + 1))
done
if [ "$cancel_state" != "running" ]; then echo "FAIL runner job never reached running before cancellation ($cancel_state)" >&2; exit 1; fi
cancel_http=$(curl --max-time 10 -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3200/v1/jobs/"$cancel_id"/cancel -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
if [ "$cancel_http" != 202 ]; then echo "FAIL runner rejected active cancellation ($cancel_http)" >&2; exit 1; fi
cancel_final=
i=0
while [ "$i" -lt 20 ]; do
  cancel_final=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$cancel_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
  state=$(printf '%s' "$cancel_final" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  case "$state" in cancelled|failed|timed_out|succeeded) break ;; esac
  sleep 1
  i=$((i + 1))
done
printf '%s' "$cancel_final" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.status!=="cancelled"||j.cancelled!==true){console.error("FAIL active cancellation:",JSON.stringify(j));process.exit(1)}})'
echo "PASS runner cancels an active process and reports terminal state"

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
existing_proxy=$(docker inspect --format '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' swarm-egress-proxy 2>/dev/null || true)
if [ -n "$existing_proxy" ]; then
  if [ "$existing_proxy" != "true|healthy" ]; then
    echo "FAIL existing swarm-egress-proxy is not healthy; refusing to replace a shared service during smoke tests" >&2
    exit 1
  fi
else
  if ! docker compose -f docker-compose.runner-egress.yml up --build -d --wait --wait-timeout 60; then
    docker compose -f docker-compose.runner-egress.yml logs --no-color swarm-egress-proxy >&2 || true
    exit 1
  fi
  proxy_started_by_smoke=1
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
  command:["python3","-c","import urllib.request; r=urllib.request.urlopen("+JSON.stringify("https://registry.npmjs.org/-/ping")+",timeout=10); assert r.status==200"],
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

# Exercise a real Docker daemon restart while an execution is active.
# The API process and its state directory stay in place for this first pass.
daemon_restart_body=$(node -e 'process.stdout.write(JSON.stringify({
  files:[],workspaceId:"33333333-3333-4333-8333-333333333333",resetWorkspace:true,
  command:["node","-e","setTimeout(()=>{},30000)"],
  network:"none",timeoutMs:60000
}))')
daemon_restart_create=$(curl -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-daemon-restart-01' \
  -d "$daemon_restart_body")
daemon_restart_id=$(printf '%s' "$daemon_restart_create" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
if [ -z "$daemon_restart_id" ]; then echo "FAIL Docker daemon restart test did not create a job" >&2; exit 1; fi
daemon_restart_state=
i=0
while [ "$i" -lt 30 ]; do
  daemon_restart_state=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$daemon_restart_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  [ "$daemon_restart_state" = "running" ] && break
  case "$daemon_restart_state" in failed|timed_out|cancelled|succeeded) echo "FAIL daemon restart test job ended before daemon restart ($daemon_restart_state)" >&2; exit 1 ;; esac
  sleep 1
  i=$((i + 1))
done
if [ "$daemon_restart_state" != "running" ]; then echo "FAIL daemon restart test job never entered running state ($daemon_restart_state)" >&2; exit 1; fi
if ! command -v systemctl >/dev/null 2>&1 || ! sudo -n systemctl is-active --quiet docker; then
  echo "FAIL Docker daemon restart test requires an active systemd Docker service and passwordless sudo" >&2
  exit 1
fi
sudo -n systemctl restart docker
ready=0
i=0
while [ "$i" -lt 90 ]; do
  if curl -fsS http://127.0.0.1:3200/readyz >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$api_pid" >/dev/null 2>&1; then cat "${workspace}-runner-api.log" >&2; echo "FAIL runner API died during Docker daemon restart" >&2; exit 1; fi
  sleep 1
  i=$((i + 1))
done
if [ "$ready" -ne 1 ]; then cat "${workspace}-runner-api.log" >&2; echo "FAIL runner API did not regain readiness after Docker daemon restart" >&2; exit 1; fi
daemon_restart_json=
i=0
while [ "$i" -lt 45 ]; do
  daemon_restart_json=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$daemon_restart_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
  daemon_restart_state=$(printf '%s' "$daemon_restart_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  case "$daemon_restart_state" in succeeded|failed|timed_out|cancelled) break ;; esac
  sleep 1
  i=$((i + 1))
done
case "$daemon_restart_state" in succeeded|failed|timed_out|cancelled) ;; *) echo "FAIL active job remained non-terminal after Docker daemon restart ($daemon_restart_state)" >&2; exit 1 ;; esac
if [ "$daemon_restart_state" != "failed" ]; then echo "FAIL active job was not failed closed after Docker daemon restart ($daemon_restart_state)" >&2; exit 1; fi
echo "PASS Docker daemon restart restores API readiness and fails the interrupted active job closed"

# Create an active job immediately before the simulated host restart.
host_restart_body=$(node -e 'process.stdout.write(JSON.stringify({
  files:[],workspaceId:"44444444-4444-4444-8444-444444444444",resetWorkspace:true,
  command:["node","-e","console.log('host-restart-ready');setTimeout(()=>{},30000)"],
  network:"none",timeoutMs:60000
}))')
host_restart_create=$(curl -fsS -X POST http://127.0.0.1:3200/v1/jobs \
  -H 'content-type: application/json' \
  -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min' \
  -H 'x-swarm-idempotency-key: smoke-runner-host-restart-01' \
  -d "$host_restart_body")
host_restart_id=$(printf '%s' "$host_restart_create" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).id||""))')
if [ -z "$host_restart_id" ]; then echo "FAIL simulated host restart test did not create a job" >&2; exit 1; fi
host_restart_state=
i=0
while [ "$i" -lt 30 ]; do
  host_restart_job=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$host_restart_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
  host_restart_state=$(printf '%s' "$host_restart_job" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
  [ "$host_restart_state" = "running" ] && break
  case "$host_restart_state" in failed|timed_out|cancelled|succeeded) echo "FAIL host restart test job ended before simulated restart ($host_restart_state): $host_restart_job" >&2; exit 1 ;; esac
  sleep 1
  i=$((i + 1))
done
if [ "$host_restart_state" != "running" ]; then echo "FAIL host restart test job never entered running state ($host_restart_state): $host_restart_job" >&2; exit 1; fi
# Give the runner time to launch the isolated container and start the command.
sleep 3
host_restart_job=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$host_restart_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
host_restart_state=$(printf '%s' "$host_restart_job" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""))')
if [ "$host_restart_state" != "running" ]; then echo "FAIL host restart test job was not active immediately before simulated restart ($host_restart_state): $host_restart_job" >&2; exit 1; fi

# Simulate host boot ordering: the API process is gone while Docker restarts,
# then a fresh API starts with the same state directory and recovers both jobs.
kill "$api_pid" >/dev/null 2>&1 || true
wait "$api_pid" 2>/dev/null || true
api_pid=
sudo -n systemctl restart docker
RUNNER_SHARED_SECRET=runner-smoke-secret-32-characters-min \
RUNNER_API_SENTINEL=must-not-leak \
RUNNER_STATE_DIR="${workspace}-runner-state" \
PORT=3200 node apps/runner-api/server.js > "${workspace}-runner-api.log" 2>&1 &
api_pid=$!
ready=0
i=0
while [ "$i" -lt 100 ]; do
  if curl -fsS http://127.0.0.1:3200/readyz >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$api_pid" >/dev/null 2>&1; then cat "${workspace}-runner-api.log" >&2; exit 1; fi
  sleep 1
  i=$((i + 1))
done
if [ "$ready" -ne 1 ]; then cat "${workspace}-runner-api.log" >&2; echo "FAIL runner API did not recover with persistent state after simulated host restart" >&2; exit 1; fi

host_recovered_job=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$host_restart_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
printf '%s' "$host_recovered_job" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.status!=="failed"||!j.error||!String(j.error).includes("se reinició durante la ejecución")){console.error("FAIL interrupted active job was not failed closed after simulated host restart",JSON.stringify(j));process.exit(1)}})'

host_completed_job=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$job_id" -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
printf '%s' "$host_completed_job" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.status!=="succeeded"||!String(j.stdout||"").includes("runner-api-ok")){console.error("FAIL completed job did not survive simulated host restart",JSON.stringify(j));process.exit(1)}})'
host_recovered_artifacts=$(curl -fsS http://127.0.0.1:3200/v1/jobs/"$job_id"/files -H 'x-swarm-runner-secret: runner-smoke-secret-32-characters-min')
printf '%s' "$host_recovered_artifacts" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const f=JSON.parse(s).files||[];if(!f.some(x=>x.path==="generated.txt"&&x.content==="artifact-ok")){console.error("FAIL completed artifact did not survive simulated host restart",JSON.stringify(f));process.exit(1)}})'
echo "PASS simulated host restart fails interrupted active job closed and preserves completed job state and artifacts on the persistent state directory"

echo "Agent sandbox smoke tests passed."
