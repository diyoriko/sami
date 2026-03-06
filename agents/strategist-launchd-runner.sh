#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

build_path() {
  local path_value="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  local candidate

  for candidate in "$HOME"/.nvm/versions/node/*/bin; do
    if [[ -d "$candidate" ]]; then
      path_value="$candidate:$path_value"
    fi
  done

  printf '%s\n' "$path_value"
}

export PATH="$(build_path)"
export HOME="${HOME:-$(cd ~ && pwd)}"
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

cd "$ROOT_DIR"
exec /bin/bash "$ROOT_DIR/agents/strategist.sh"
