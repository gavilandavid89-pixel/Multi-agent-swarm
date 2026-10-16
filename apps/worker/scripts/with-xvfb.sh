#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  echo "Uso: sh scripts/with-xvfb.sh <comando> [argumentos...]" >&2
  exit 2
fi

if ! command -v xvfb-run >/dev/null 2>&1; then
  echo "xvfb-run no está instalado; este helper está pensado para la imagen Docker del worker." >&2
  exit 127
fi

exec env -i PATH="${PATH:-/usr/bin:/bin}" HOME="${HOME:-/tmp}" LANG="${LANG:-C.UTF-8}" xvfb-run -a -s "-screen 0 1280x900x24 -nolisten tcp" "$@"
