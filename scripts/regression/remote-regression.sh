#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/regression/remote-regression.sh [options]

Synchronize the current working tree to a Linux build host, run a named
regression suite there, and download a self-contained report.

Options:
  --host HOST              SSH host (default: WZU_Server)
  --suite SUITE            quick | full | live-smoke | live-full | full-live
                           (default: quick)
  --model MODEL            Override XHARNESS_LIVE_MODEL for live suites
  --base-url URL           Override XHARNESS_LIVE_BASE_URL for live suites
  --secret-file PATH       Remote credential file
                           (default: ~/.config/xharness/regression.env)
  --output DIR             Local report directory
  --remote-root PATH       Remote source root
                           (default: ~/codex-build/x-harness-rs)
  -h, --help               Show this help

The API key is never accepted as an argument and is never copied by rsync.
See docs/runbooks/regression.md for one-time server credential setup.
EOF
}

HOST="WZU_Server"
SUITE="quick"
MODEL="__XHARNESS_UNSET__"
BASE_URL="__XHARNESS_UNSET__"
SECRET_FILE="~/.config/xharness/regression.env"
REMOTE_ROOT="~/codex-build/x-harness-rs"
OUTPUT=""

while (($#)); do
  case "$1" in
    --host) HOST="${2:?missing value for --host}"; shift 2 ;;
    --suite) SUITE="${2:?missing value for --suite}"; shift 2 ;;
    --model) MODEL="${2:?missing value for --model}"; shift 2 ;;
    --base-url) BASE_URL="${2:?missing value for --base-url}"; shift 2 ;;
    --secret-file) SECRET_FILE="${2:?missing value for --secret-file}"; shift 2 ;;
    --output) OUTPUT="${2:?missing value for --output}"; shift 2 ;;
    --remote-root) REMOTE_ROOT="${2:?missing value for --remote-root}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$SUITE" in
  quick|full|live-smoke|live-full|full-live) ;;
  *) echo "unsupported suite: $SUITE" >&2; exit 2 ;;
esac

ROOT="$(git rev-parse --show-toplevel)"
REVISION="$(git -C "$ROOT" rev-parse HEAD)"
SHORT_REVISION="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
DIRTY="false"
if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet ||
   [[ -n "$(git -C "$ROOT" ls-files --others --exclude-standard)" ]]; then
  DIRTY="true"
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${SHORT_REVISION}"
if [[ "$DIRTY" == "true" ]]; then
  RUN_ID="${RUN_ID}-dirty"
fi
if [[ -z "$OUTPUT" ]]; then
  OUTPUT="$ROOT/dist/regression/$RUN_ID"
fi
if [[ -e "$OUTPUT" ]]; then
  echo "output already exists: $OUTPUT" >&2
  exit 2
fi
mkdir -p "$OUTPUT"

REMOTE_RUN="$REMOTE_ROOT/runs/$RUN_ID/source"

python3 - "$OUTPUT/source.json" "$RUN_ID" "$REVISION" "$DIRTY" "$HOST" "$SUITE" <<'PY'
import json, pathlib, sys
path, run_id, revision, dirty, host, suite = sys.argv[1:]
pathlib.Path(path).write_text(json.dumps({
    "run_id": run_id,
    "revision": revision,
    "dirty": dirty == "true",
    "host": host,
    "suite": suite,
}, indent=2) + "\n")
PY

echo "[regression] syncing $REVISION (dirty=$DIRTY) to $HOST:$REMOTE_RUN"
ssh "$HOST" bash -s -- "$REMOTE_RUN" <<'REMOTE'
set -euo pipefail
remote_run="$1"
remote_run="${remote_run/#\~/$HOME}"
mkdir -p "$remote_run"
REMOTE
rsync -az --delete \
  --exclude='.git/' \
  --exclude='target/' \
  --exclude='node_modules/' \
  --exclude='/dist/' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='*.pem' \
  --exclude='*.key' \
  --exclude='.DS_Store' \
  "$ROOT/" "$HOST:$REMOTE_RUN/"

set +e
ssh "$HOST" bash -s -- \
  "$REMOTE_RUN" "$SUITE" "$RUN_ID" "$REVISION" "$DIRTY" \
  "$SECRET_FILE" "$MODEL" "$BASE_URL" <<'REMOTE'
set -euo pipefail
source_dir="$1"
source_dir="${source_dir/#\~/$HOME}"
shift
exec "$source_dir/scripts/regression/run-suite.sh" --source "$source_dir" \
  --suite "$1" --run-id "$2" --revision "$3" --dirty "$4" \
  --secret-file "$5" --model "$6" --base-url "$7"
REMOTE
REMOTE_STATUS=$?
set -e

# Evidence is collected even when a test failed. The report must be sufficient
# to diagnose the failure without rerunning a paid or flaky live-model case.
set +e
rsync -az "$HOST:$REMOTE_RUN/.regression-artifacts/" "$OUTPUT/"
FETCH_STATUS=$?
set -e

if ((FETCH_STATUS != 0)); then
  echo "[regression] failed to download evidence from $HOST" >&2
  exit "$FETCH_STATUS"
fi

echo "[regression] report: $OUTPUT/summary.md"
if ((REMOTE_STATUS != 0)); then
  echo "[regression] suite failed; inspect $OUTPUT/logs/ and $OUTPUT/summary.md" >&2
  echo "[regression] remote source retained for reproduction: $HOST:$REMOTE_RUN" >&2
else
  # Successful runs keep only the shared Cargo cache. Validate the path shape
  # before removal so an incorrectly configured remote root cannot be erased.
  ssh "$HOST" bash -s -- "$REMOTE_RUN" <<'REMOTE'
set -euo pipefail
source_dir="$1"
source_dir="${source_dir/#\~/$HOME}"
case "$source_dir" in
  "$HOME"/codex-build/x-harness-rs/runs/*/source)
    run_dir="${source_dir%/source}"
    rm -rf -- "$run_dir"
    ;;
  *)
    echo "refusing to clean unexpected regression path: $source_dir" >&2
    exit 2
    ;;
esac
REMOTE
fi
exit "$REMOTE_STATUS"
