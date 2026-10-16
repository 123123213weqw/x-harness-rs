#!/usr/bin/env bash
# Run only on the local orchestration machine. Rust executes exclusively on SSH.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${XHARNESS_BUILD_HOST:-WZU_Server}"
# Keep the experiment under the mandated repo namespace, but never overwrite
# another task's source tree. Reuse only the Cargo target cache.
REMOTE_SOURCE="codex-build/x-harness-rs/unified-jobs-20261013"
EVIDENCE="$ROOT/docs/evidence/unified-jobs-20261013"
mkdir -p "$EVIDENCE"
LOG="$EVIDENCE/remote-tests-$(date -u +%Y%m%dT%H%M%SZ).log"
printf 'Complete remote output: %s\n' "$LOG"
ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "mkdir -p \"\$HOME/$REMOTE_SOURCE\""
# Use the existing remote source as a content-checked copy cache. The destination
# is still isolated; no hardlinks and no writes to the cache source are made.
# UI/desktop packaging and reports are not inputs to this Rust-workspace test.
rsync -azc --delete --copy-dest='/home/wzu/codex-build/x-harness-rs' \
  --exclude='.git' --exclude='target/' --exclude='node_modules/' \
  --exclude='.env' --exclude='.env.*' --exclude='*.pem' --exclude='*.key' \
  --exclude='.git-credentials' --exclude='.cargo/credentials*' --exclude='.aws/credentials' --exclude='cookies.txt' \
  --exclude='/ui/' --exclude='/apps/' \
  --include='/docs/' --include='/docs/specs/***' --exclude='/docs/*' \
  --exclude='docs/evidence/unified-jobs-20261013/' \
  "$ROOT/" "$HOST:$REMOTE_SOURCE/"
ssh -o BatchMode=yes "$HOST" bash -s -- "$REMOTE_SOURCE" <<'REMOTE' 2>&1 | tee "$LOG"
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$HOME/codex-build/x-harness-rs/target-unified-jobs-20261013"
export CARGO_BUILD_JOBS=4
cd "$HOME/$1"
date -u '+%Y-%m-%dT%H:%M:%SZ'
hostname
cargo --version
printf '\n=== A/B/C contracts ===\n'
cargo test -p xharness-jobs -p xharness-schedule -p xharness-host -- --test-threads=1
printf '\n=== Existing lifecycle regression ===\n'
cargo test -p xharness-coding-tools -- --test-threads=1
cargo test -p xharness-host-app --lib -- --test-threads=1
cargo check -p xharness-host-app
printf '\n=== Strict Clippy ===\n'
cargo clippy -p xharness-schedule -p xharness-jobs -p xharness-host -p xharness-host-app -p xharness-coding-tools --all-targets -- -D warnings
REMOTE
# Cargo may add test-only dependency edges to the workspace lock file.
rsync -az "$HOST:$REMOTE_SOURCE/Cargo.lock" "$ROOT/Cargo.lock"
