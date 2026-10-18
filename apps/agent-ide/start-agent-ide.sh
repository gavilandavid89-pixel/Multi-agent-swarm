#!/bin/sh
set -eu

if [ -z "${PASSWORD:-}" ] || [ "${#PASSWORD}" -lt 24 ]; then
  echo '[agent-ide] PASSWORD must be configured and contain at least 24 characters.' >&2
  exit 78
fi
case "$PASSWORD" in
  *[!A-Za-z0-9._~!@#%+=:-]*)
    echo '[agent-ide] PASSWORD contains unsupported characters; use letters, numbers and . _ ~ ! @ # % + = : -' >&2
    exit 78
    ;;
esac

mkdir -p "$HOME/.config/code-server" /tmp/agent-ide/user-data /tmp/agent-ide/extensions
chmod 700 "$HOME/.config/code-server"
escaped_password=$(printf '%s' "$PASSWORD" | sed "s/'/''/g")
umask 077
printf "bind-addr: 0.0.0.0:8080\nauth: password\npassword: '%s'\ncert: false\ndisable-telemetry: true\n" "$escaped_password" > "$HOME/.config/code-server/config.yaml"
chmod 600 "$HOME/.config/code-server/config.yaml"
unset PASSWORD escaped_password

exec code-server \
  --bind-addr 0.0.0.0:8080 \
  --auth password \
  --disable-telemetry \
  --disable-update-check \
  --user-data-dir /tmp/agent-ide/user-data \
  --extensions-dir /tmp/agent-ide/extensions \
  /workspace
