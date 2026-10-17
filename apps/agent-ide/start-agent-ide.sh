#!/bin/sh
set -eu

if [ -z "${PASSWORD:-}" ] || [ "${#PASSWORD}" -lt 24 ]; then
  echo '[agent-ide] PASSWORD must be configured and contain at least 24 characters.' >&2
  exit 78
fi

if [ "${AGENT_IDE_DISABLE_TERMINAL:-false}" = 'true' ]; then
  echo '[agent-ide] Terminal is disabled by configuration; this image is intended for private, trusted development workspaces only.' >&2
fi

exec code-server \
  --bind-addr 0.0.0.0:8080 \
  --auth password \
  --disable-telemetry \
  --disable-update-check \
  --user-data-dir /tmp/agent-ide/user-data \
  --extensions-dir /tmp/agent-ide/extensions \
  /workspace
