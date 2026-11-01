#!/usr/bin/env bash
# Run only inside the isolated server checkout, never against user browser tabs.
set -euo pipefail
[[ "$(uname -s)" == Linux && "${XHARNESS_BROWSER_TEST_SERVER:-}" == 1 ]] || {
  echo 'Run on the isolated Linux server with XHARNESS_BROWSER_TEST_SERVER=1' >&2
  exit 2
}
cd "$(dirname "$0")/../.."
mkdir -p docs/evidence
node --test scripts/browser_use/evidence-gate.test.mjs
npm ci --prefix plugins/browser-use --ignore-scripts --no-audit --no-fund
rm -rf plugins/browser-use/dist
npm run build --prefix plugins/browser-use
node --test scripts/browser_use/policy-contract.test.mjs scripts/browser_use/protocol-contract.test.mjs
node --test scripts/browser_use/reference-guidance.test.mjs scripts/browser_use/backend-isolation.test.mjs scripts/browser_use/screenshot-stability.test.mjs scripts/browser_use/navigation-stability.test.mjs
status=0
BROWSER_ACCEPTANCE_EVIDENCE=docs/evidence/browser-use-parity-engine-20261022.json node scripts/browser_use/acceptance.mjs || status=1
BROWSER_STDIO_EVIDENCE=docs/evidence/browser-use-parity-stdio-20261022.json node scripts/browser_use/stdio.mjs || status=1
UI_TEST_DEPS="$PWD/plugins/browser-use" BROWSER_LEGACY_EVIDENCE=docs/evidence/browser-use-parity-legacy-20261022.json node scripts/browser_use/legacy-gate.mjs || status=1
node scripts/browser_use/update-matrix.mjs || status=1
exit "$status"
