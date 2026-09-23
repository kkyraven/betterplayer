#!/usr/bin/env sh
[ "$(uname -s)" = "Darwin" ] || { echo "This script is for macOS; see the others in the repo root." >&2; exit 1; }
exec "$(dirname "$0")/scripts/dev.sh" "$@"
