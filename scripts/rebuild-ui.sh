#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$#" -ne 0 ]]; then
  echo 'usage: rebuild-ui.sh (repository inputs only; no external source directory)' >&2
  exit 2
fi
npm ci --prefix "$repo_root/ui" --ignore-scripts
npm run build --prefix "$repo_root/ui"
