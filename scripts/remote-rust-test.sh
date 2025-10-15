#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-WZU_Server}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOSITORY="$(basename "$ROOT")"
REMOTE_DIR="${XHARNESS_REMOTE_DIR:-~/codex-build/$REPOSITORY}"

rsync -az --delete \
  --exclude='.git/' \
  --exclude='target/' \
  --exclude='node_modules/' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='.DS_Store' \
  "$ROOT/" "$HOST:$REMOTE_DIR/"

ssh "$HOST" "bash -s" -- "$REMOTE_DIR" <<'REMOTE'
set -euo pipefail
REMOTE_DIR="$1"
REMOTE_DIR="${REMOTE_DIR/#\~/$HOME}"
export PATH="$HOME/.cargo/bin:$PATH"
cd "$REMOTE_DIR"

cargo fmt --check --all
cargo check --workspace --all-targets
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
REMOTE
