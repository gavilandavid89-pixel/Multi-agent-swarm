#!/bin/sh
set -eu

usage() {
  echo "Uso: $0 <directorio-del-proyecto> <comando> [argumentos...]" >&2
  echo "Ejemplo: $0 ./mi-proyecto npm test" >&2
}

if [ "$#" -lt 2 ]; then
  usage
  exit 2
fi

workspace_arg=$1
shift

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker no está instalado o no está en PATH." >&2
  exit 127
fi
if ! command -v timeout >/dev/null 2>&1; then
  echo "ERROR: se necesita el comando timeout del sistema host." >&2
  exit 127
fi

workspace=$(CDPATH= cd -- "$workspace_arg" 2>/dev/null && pwd -P) || {
  echo "ERROR: el directorio de proyecto no existe: $workspace_arg" >&2
  exit 2
}
case "$workspace" in
  /|/home|/root|/etc|/usr|/var|/proc|/sys|/dev|/run|/tmp)
    echo "ERROR: se rechazó un directorio demasiado amplio o sensible: $workspace" >&2
    exit 2
    ;;
esac

image=${SWARM_RUNNER_IMAGE:-swarm-agent-runner:local}
timeout_seconds=${SWARM_RUNNER_TIMEOUT_SECONDS:-120}
memory_limit=${SWARM_RUNNER_MEMORY:-1g}
cpu_limit=${SWARM_RUNNER_CPUS:-2}
pids_limit=${SWARM_RUNNER_PIDS:-128}

case "$timeout_seconds" in
  ''|*[!0-9]*|0) echo "ERROR: SWARM_RUNNER_TIMEOUT_SECONDS debe ser un entero positivo." >&2; exit 2 ;;
esac
case "$pids_limit" in
  ''|*[!0-9]*|0) echo "ERROR: SWARM_RUNNER_PIDS debe ser un entero positivo." >&2; exit 2 ;;
esac

if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "ERROR: no existe la imagen local '$image'." >&2
  echo "Construíla con: docker build -t swarm-agent-runner:local -f apps/runner/Dockerfile apps/runner" >&2
  exit 125
fi

echo "Sandbox: image=$image timeout=${timeout_seconds}s memory=$memory_limit cpus=$cpu_limit pids=$pids_limit network=none"
# Intentionally pass no host environment wholesale. Only explicitly safe values enter.
# The workspace is the sole writable host mount; Docker socket and credentials are never mounted.
exec timeout --signal=TERM --kill-after=5s "${timeout_seconds}s" docker run --rm --init \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit "$pids_limit" \
  --memory "$memory_limit" \
  --cpus "$cpu_limit" \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --mount "type=bind,src=$workspace,dst=/workspace,rw" \
  --workdir /workspace \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp \
  --env CI=true \
  --env LANG=C.UTF-8 \
  --env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --env CHROME_BIN=/usr/bin/chromium \
  "$image" "$@"
