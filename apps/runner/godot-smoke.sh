#!/usr/bin/env bash
set -uo pipefail
if ! command -v godot >/dev/null 2>&1; then
  echo "Godot no está instalado en la imagen del runner." >&2
  exit 127
fi
if [[ ! -f project.godot ]]; then
  echo "No se encontró project.godot en el directorio del proyecto." >&2
  exit 2
fi
log=$(mktemp /tmp/swarm-godot-check.XXXXXX)
trap 'rm -f "$log"' EXIT
if ! godot --headless --editor --path . --quit >"$log" 2>&1; then
  cat "$log" >&2
  exit 1
fi
if grep -E 'SCRIPT ERROR:|Parse Error:|Failed to load script' "$log"; then
  cat "$log" >&2
  exit 1
fi
if ! godot --headless --path . --quit-after 10 >"$log" 2>&1; then
  cat "$log" >&2
  exit 1
fi
if grep -E 'SCRIPT ERROR:|Parse Error:|Failed to load script' "$log"; then
  cat "$log" >&2
  exit 1
fi
echo "SWARM_GODOT_CHECKED=1"
echo "Godot headless import, script parsing and 10-frame startup passed."
