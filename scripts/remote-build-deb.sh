#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-WZU_Server}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOSITORY="$(basename "$ROOT")"
REMOTE_DIR="${XHARNESS_REMOTE_DIR:-~/codex-build/$REPOSITORY}"
LOCAL_DIST="$ROOT/dist"

rsync -az --delete \
  --exclude='.git/' \
  --exclude='target/' \
  --exclude='dist/' \
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
export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="${CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER:-/usr/bin/cc}"
cd "$REMOTE_DIR"
tests/packaging/sandbox_setup.sh packaging/deb/xharness-sandbox-setup
cargo fmt --check --all
cargo check --workspace --all-targets
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
scripts/build-deb.sh
REMOTE

mkdir -p "$LOCAL_DIST"
rsync -az "$HOST:$REMOTE_DIR/dist/" "$LOCAL_DIST/"
printf 'Debian packages copied to %s\n' "$LOCAL_DIST"
