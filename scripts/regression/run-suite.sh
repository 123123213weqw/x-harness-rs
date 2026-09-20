#!/usr/bin/env bash
set -euo pipefail

SOURCE=""
SUITE=""
RUN_ID=""
REVISION=""
DIRTY="false"
SECRET_FILE="~/.config/xharness/regression.env"
MODEL_OVERRIDE=""
BASE_URL_OVERRIDE=""

while (($#)); do
  case "$1" in
    --source) SOURCE="${2:?}"; shift 2 ;;
    --suite) SUITE="${2:?}"; shift 2 ;;
    --run-id) RUN_ID="${2:?}"; shift 2 ;;
    --revision) REVISION="${2:?}"; shift 2 ;;
    --dirty) DIRTY="${2:?}"; shift 2 ;;
    --secret-file) SECRET_FILE="${2:?}"; shift 2 ;;
    --model) MODEL_OVERRIDE="${2:-}"; shift 2 ;;
    --base-url) BASE_URL_OVERRIDE="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$SOURCE" && -n "$SUITE" && -n "$RUN_ID" && -n "$REVISION" ]] || {
  echo "missing required runner arguments" >&2
  exit 2
}

SOURCE="${SOURCE/#\~/$HOME}"
SECRET_FILE="${SECRET_FILE/#\~/$HOME}"
ARTIFACTS="$SOURCE/.regression-artifacts"
LOGS="$ARTIFACTS/logs"
RESULTS="$ARTIFACTS/results.jsonl"
mkdir -p "$LOGS"
: > "$RESULTS"

export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TERM_COLOR=never
export RUST_BACKTRACE=1
export CARGO_TARGET_DIR="${XHARNESS_REGRESSION_TARGET_DIR:-$HOME/codex-build/x-harness-rs/target}"
cd "$SOURCE"

python3 - "$ARTIFACTS/environment.json" "$RUN_ID" "$REVISION" "$DIRTY" "$SUITE" <<'PY'
import json, os, pathlib, platform, sys
path, run_id, revision, dirty, suite = sys.argv[1:]
pathlib.Path(path).write_text(json.dumps({
    "run_id": run_id,
    "revision": revision,
    "dirty": dirty == "true",
    "suite": suite,
    "hostname": platform.node(),
    "platform": platform.platform(),
    "machine": platform.machine(),
    "python": platform.python_version(),
    "target_dir": os.environ.get("CARGO_TARGET_DIR"),
}, indent=2) + "\n")
PY

FAILURES=0
SKIPS=0

record_result() {
  local name="$1" status="$2" duration="$3" log="$4" classification="$5"
  python3 - "$RESULTS" "$name" "$status" "$duration" "$log" "$classification" <<'PY'
import json, pathlib, sys
path, name, status, duration, log, classification = sys.argv[1:]
with pathlib.Path(path).open("a") as stream:
    stream.write(json.dumps({
        "name": name,
        "status": status,
        "duration_seconds": int(duration),
        "log": log,
        "classification": classification,
    }) + "\n")
PY
}

run_case() {
  local name="$1"
  shift
  local log="$LOGS/$name.log" start end status
  start="$(date +%s)"
  echo "[case:$name] $*"
  set +e
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  set -e
  end="$(date +%s)"
  if ((status == 0)); then
    record_result "$name" passed "$((end-start))" "logs/$name.log" product
  else
    record_result "$name" failed "$((end-start))" "logs/$name.log" product
    FAILURES=$((FAILURES+1))
  fi
}

skip_case() {
  local name="$1" reason="$2"
  printf '%s\n' "$reason" > "$LOGS/$name.log"
  record_result "$name" skipped 0 "logs/$name.log" prerequisite
  SKIPS=$((SKIPS+1))
}

run_ui_contracts() {
  local tests=(
    scripts/test-assistant-projection.mjs
    scripts/test-atomic-history.mjs
    scripts/test-compaction-ui.mjs
    scripts/test-context-accounting.mjs
    scripts/test-live-answer-recovery.mjs
    scripts/test-retry-turn-projection.mjs
  )
  local test name
  for test in "${tests[@]}"; do
    if [[ -f "$test" ]]; then
      name="ui-$(basename "$test" .mjs)"
      run_case "$name" node "$test"
    else
      skip_case "ui-$(basename "$test" .mjs)" "fixture is not present in this revision: $test"
    fi
  done
}

run_quick() {
  run_case architecture-boundaries python3 scripts/regression/check-architecture.py
  run_case rustfmt cargo fmt --check --all
  run_case rust-check cargo check --locked --workspace --all-targets
  run_case critical-state-machines cargo test --locked \
    -p xharness-token -p xharness-compaction -p xharness-context \
    -p xharness-session -p xharness-core -p xharness-agent -p xharness-host \
    --all-targets
  run_ui_contracts
}

run_full() {
  run_case architecture-boundaries python3 scripts/regression/check-architecture.py
  run_case rustfmt cargo fmt --check --all
  run_case rust-check cargo check --locked --workspace --all-targets
  run_case rust-test cargo test --locked --workspace --all-targets
  run_case process-drop-cleanup cargo test --locked -p xharness-process \
    --test process dropping_ -- --test-threads=1
  run_case rust-clippy cargo clippy --locked --workspace --all-targets -- -D warnings
  run_ui_contracts
}

load_live_environment() {
  if [[ ! -f "$SECRET_FILE" ]]; then
    echo "missing remote credential file: $SECRET_FILE" >&2
    return 1
  fi
  local mode
  mode="$(stat -c '%a' "$SECRET_FILE" 2>/dev/null || true)"
  if [[ -z "$mode" || ! "$mode" =~ ^[0-7]{3,4}$ || $((8#$mode & 077)) -ne 0 ]]; then
    echo "credential file must not be group/world readable: $SECRET_FILE (mode=${mode:-unknown})" >&2
    return 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$SECRET_FILE"
  set +a
  # Reuse the historical bench credential names without copying or rewriting
  # the secret file. The canonical regression names still take precedence.
  export XHARNESS_LIVE_API_KEY="${XHARNESS_LIVE_API_KEY:-${DEEPSEEK_API_KEY:-}}"
  [[ -n "${XHARNESS_LIVE_API_KEY:-}" ]] || {
    echo "XHARNESS_LIVE_API_KEY/DEEPSEEK_API_KEY is missing in $SECRET_FILE" >&2
    return 1
  }
  if [[ "$MODEL_OVERRIDE" != "__XHARNESS_UNSET__" ]]; then
    export XHARNESS_LIVE_MODEL="$MODEL_OVERRIDE"
  else
    export XHARNESS_LIVE_MODEL="${XHARNESS_LIVE_MODEL:-deepseek-v4-flash}"
  fi
  if [[ "$BASE_URL_OVERRIDE" != "__XHARNESS_UNSET__" ]]; then
    export XHARNESS_LIVE_BASE_URL="$BASE_URL_OVERRIDE"
  else
    export XHARNESS_LIVE_BASE_URL="${XHARNESS_LIVE_BASE_URL:-${DEEPSEEK_BASE_URL:-https://api.deepseek.com}}"
  fi
}

run_live_case() {
  local test_name="$1"
  run_case "live-$test_name" cargo test --locked -p xharness-coding-tools \
    --test live_loop "$test_name" -- --ignored --exact --nocapture --test-threads=1
}

run_live_smoke() {
  if ! load_live_environment; then
    skip_case live-credentials "live credentials are unavailable or unsafe; see the runner output"
    FAILURES=$((FAILURES+1))
    return
  fi
  run_live_case live_model_calls_real_tool_and_finishes_the_loop
  run_live_case live_model_uses_managed_jobs_instead_of_pty_or_nohup
}

run_live_full() {
  run_live_smoke
  if ((FAILURES == 0)); then
    run_live_case live_model_repairs_code_and_emits_complete_debug_evidence
    run_live_case live_model_continues_coding_across_execution_checkpoints
  else
    skip_case live-long-coding "live smoke failed; paid long-running cases were not started"
  fi
}

case "$SUITE" in
  quick) run_quick ;;
  full) run_full ;;
  live-smoke)
    run_case architecture-boundaries python3 scripts/regression/check-architecture.py
    run_live_smoke
    ;;
  live-full)
    run_case architecture-boundaries python3 scripts/regression/check-architecture.py
    run_live_full
    ;;
  full-live)
    run_full
    if ((FAILURES == 0)); then
      run_live_full
    else
      skip_case live-suite "offline regression failed; paid live cases were not started"
    fi
    ;;
  *) echo "unsupported suite: $SUITE" >&2; exit 2 ;;
esac

python3 scripts/regression/summarize.py \
  --environment "$ARTIFACTS/environment.json" \
  --results "$RESULTS" \
  --json "$ARTIFACTS/summary.json" \
  --markdown "$ARTIFACTS/summary.md"

echo "[regression] failures=$FAILURES skips=$SKIPS summary=$ARTIFACTS/summary.md"
((FAILURES == 0))
