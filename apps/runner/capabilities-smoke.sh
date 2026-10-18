#!/bin/sh
set -eu

# This runs inside the isolated runner image. It is a build-time inventory,
# not a command executed in the Worker or on the runner host.
required='node npm npx tsc tsx prettier eslint python3 pytest black flake8 mypy java javac jdb mvn go php composer ruby bundle gcc g++ make rustc cargo chromium xvfb-run godot jq sqlite3 rg fdfind tree shellcheck shfmt'
missing=''
for command_name in $required; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'MISSING_TOOL=%s\n' "$command_name" >&2
    missing="$missing $command_name"
  fi
done
if [ -n "$missing" ]; then
  printf 'Runner image is missing required tools:%s\n' "$missing" >&2
  exit 1
fi

node --version
npm --version
tsc --version
tsx --version
prettier --version
eslint --version
python3 --version
pytest --version
black --version
flake8 --version
mypy --version
java -version 2>&1 | head -n 1
mvn --version | head -n 1
go version
php --version | head -n 1
ruby --version
rustc --version
cargo --version
chromium --version 2>&1 | head -n 1
godot --version
jq --version
sqlite3 --version | head -n 1
shellcheck --version | head -n 2
shfmt --version
jdb -help >/dev/null 2>&1 || true

# Exercise the debugger non-interactively with bounded debugger commands.
debug_tmp=$(mktemp -d)
trap 'rm -rf "$debug_tmp"' EXIT
printf '%s\n' 'print("debug target reached")' > "$debug_tmp/debug_target.py"
printf 'p 6 * 7\nq\n' | python3 -m pdb "$debug_tmp/debug_target.py" > "$debug_tmp/pdb.out"
grep -q '42' "$debug_tmp/pdb.out"
echo 'SWARM_RUNNER_DEBUGGER_CHECKED=1'

node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync("/opt/swarm-runner/capabilities.json", "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.id !== "swarm-agent-runner") process.exit(41);
  const ids = new Set(manifest.toolchains.map(x => x.id));
  for (const id of ["javascript-node", "typescript", "python", "java", "go", "php", "ruby", "c-cpp", "rust", "godot", "web-lint-format", "shell", "data-files"]) {
    if (!ids.has(id)) { console.error("Missing toolchain profile:", id); process.exit(42); }
  }
  if (manifest.execution.defaultNetwork !== "none" || manifest.execution.concurrency !== 1) process.exit(43);
  if (manifest.workspaceIsolation?.status !== "worker-primitives-and-model-tool-dispatch-implemented" || manifest.workspaceIsolation.concurrency.globalRunner !== 1 || !manifest.workspaceIsolation.merge.includes("fail closed")) process.exit(48);
  if (manifest.agentToolContract.rolePolicyStatus !== "enforced-by-worker-dispatcher" || !manifest.agentToolContract.rolePolicy.Desarrollador || !manifest.agentToolContract.rolePolicy.Validador) process.exit(45);
  if (!Array.isArray(manifest.agentToolContract.notYetImplemented)) process.exit(44);
  if (!manifest.output || !manifest.output.streams.includes("stdout") || !manifest.output.streams.includes("stderr") || manifest.output.maxRetainedCharsPerStream !== 65536) process.exit(46);
  const debuggers = new Set((manifest.debugging?.debuggers || []).map(x => x.id));
  if (!debuggers.has("python-pdb") || manifest.debugging.stdin.maxBytes !== 16384 || !manifest.debugging.notYetImplemented.includes("persistent interactive debugger sessions")) process.exit(47);
'
echo 'SWARM_RUNNER_CAPABILITIES_CHECKED=1'
