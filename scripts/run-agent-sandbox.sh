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
  /|/home|/root|/root/*|/etc|/etc/*|/usr|/usr/*|/var|/var/*|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*|/run|/run/*|/tmp)
    echo "ERROR: se rechazó un directorio raíz, del sistema o temporal del host: $workspace" >&2
    exit 2
    ;;
esac
# Allow project folders under a user's home (and dedicated /tmp workspaces), but
# never mount the entire current home or well-known credential directories.
host_home=$(CDPATH= cd -- "${HOME:-/nonexistent}" 2>/dev/null && pwd -P || true)
if [ -n "$host_home" ] && [ "$workspace" = "$host_home" ]; then
  echo "ERROR: no se permite montar el home completo del usuario." >&2
  exit 2
fi
case "$workspace" in
  */.ssh|*/.ssh/*|*/.aws|*/.aws/*|*/.azure|*/.azure/*|*/.kube|*/.kube/*|*/.gnupg|*/.gnupg/*|*/.docker|*/.docker/*)
    echo "ERROR: no se permite montar directorios que suelen contener credenciales: $workspace" >&2
    exit 2
    ;;
esac

image=${SWARM_RUNNER_IMAGE:-swarm-agent-runner:local}
timeout_seconds=${SWARM_RUNNER_TIMEOUT_SECONDS:-120}
memory_limit=${SWARM_RUNNER_MEMORY:-1g}
cpu_limit=${SWARM_RUNNER_CPUS:-2}
pids_limit=${SWARM_RUNNER_PIDS:-128}
network_mode=${SWARM_RUNNER_NETWORK:-none}

case "$timeout_seconds" in
  ''|*[!0-9]*|0) echo "ERROR: SWARM_RUNNER_TIMEOUT_SECONDS debe ser un entero positivo." >&2; exit 2 ;;
esac
case "$pids_limit" in
  ''|*[!0-9]*|0) echo "ERROR: SWARM_RUNNER_PIDS debe ser un entero positivo." >&2; exit 2 ;;
esac
case "$network_mode" in
  none) docker_network=none ;;
  restricted)
    docker_network=swarm-agent-egress
    if ! docker network inspect "$docker_network" >/dev/null 2>&1; then
      echo "ERROR: falta la red interna '$docker_network' y su proxy de salida con allowlist." >&2
      echo "No se habilita acceso directo a Internet como alternativa." >&2
      exit 125
    fi
    network_is_internal=$(docker network inspect --format '{{.Internal}}' "$docker_network")
    if [ "$network_is_internal" != true ]; then
      echo "ERROR: '$docker_network' existe pero no es una red Docker interna; se rechaza por seguridad." >&2
      exit 125
    fi
    ;;
  *) echo "ERROR: SWARM_RUNNER_NETWORK admite solo none o restricted." >&2; exit 2 ;;
esac

if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "ERROR: no existe la imagen local '$image'." >&2
  echo "Construíla con: docker build -t swarm-agent-runner:local -f apps/runner/Dockerfile apps/runner" >&2
  exit 125
fi

echo "Sandbox: image=$image timeout=${timeout_seconds}s memory=$memory_limit cpus=$cpu_limit pids=$pids_limit network=$network_mode"
# Intentionally pass no host environment wholesale. Only explicitly safe values enter.
# The workspace is the sole writable host mount; Docker socket and credentials are never mounted.
run_sandbox() {
  if [ "$network_mode" = restricted ]; then
    exec timeout --signal=TERM --kill-after=5s "${timeout_seconds}s" docker run --rm --init \
      --network "$docker_network" --read-only --cap-drop ALL \
      --security-opt no-new-privileges:true --pids-limit "$pids_limit" \
      --memory "$memory_limit" --cpus "$cpu_limit" \
      --tmpfs /tmp:rw,nosuid,nodev,size=512m \
      --mount "type=bind,src=$workspace,dst=/workspace" \
      --workdir /workspace --user "$(id -u):$(id -g)" \
      --env HOME=/tmp --env CI=true --env LANG=C.UTF-8 \
      --env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      --env CHROME_BIN=/usr/bin/chromium \
      --env HTTP_PROXY=http://swarm-egress-proxy:3128 \
      --env HTTPS_PROXY=http://swarm-egress-proxy:3128 \
      --env ALL_PROXY=http://swarm-egress-proxy:3128 \
      --env NO_PROXY=localhost,127.0.0.1,::1 "$image" "$@"
  else
    exec timeout --signal=TERM --kill-after=5s "${timeout_seconds}s" docker run --rm --init \
      --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges:true --pids-limit "$pids_limit" \
      --memory "$memory_limit" --cpus "$cpu_limit" \
      --tmpfs /tmp:rw,nosuid,nodev,size=512m \
      --mount "type=bind,src=$workspace,dst=/workspace" \
      --workdir /workspace --user "$(id -u):$(id -g)" \
      --env HOME=/tmp --env CI=true --env LANG=C.UTF-8 \
      --env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      --env CHROME_BIN=/usr/bin/chromium "$image" "$@"
  fi
}
run_sandbox "$@"
