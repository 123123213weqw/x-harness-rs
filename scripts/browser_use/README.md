# Browser Use server acceptance

This suite launches only a fresh, isolated Chromium context. It does not attach to
user tabs or change a live XHarness process. Fixtures are first-party local HTTP
pages; correctness is checked through page-owned event/state records, trusted input
flags, tab identity, downloaded bytes and PNG geometry, not merely tool receipts.

Run **on the isolated server**, after the root coordinator has synchronized sources
and built `plugins/browser-use`:

```sh
XHARNESS_BROWSER_TEST_SERVER=1 \
BROWSER_ACCEPTANCE_EVIDENCE=docs/evidence/browser-use-parity-engine-20261022.json \
node scripts/browser_use/acceptance.mjs
```

`BROWSER_ENGINE_MODULE` may point to a built engine for compatibility comparisons.
The fixture server binds ephemeral loopback ports and removes its temporary browser
artifacts on exit. A second unapproved HTTP origin records attempted navigation
independently of tool errors.

The parity matrix is in
`docs/evidence/browser-use-parity-matrix-20261022.json`. It intentionally separates
implemented engine behavior from separately tested Host media, full JavaScript facade,
external model quality and reference-runtime A/B claims. Do not turn the matrix
into a blanket “full parity” assertion based on passing these fixture tests.

The actual stdio MCP/image-block smoke test is separate:

```sh
XHARNESS_BROWSER_TEST_SERVER=1 \
BROWSER_STDIO_EVIDENCE=docs/evidence/browser-use-parity-stdio-20261022.json \
node scripts/browser_use/stdio.mjs
```

Image content in MCP is necessary but not sufficient: Host multimodal projection
still requires its Rust tests. Neither suite evaluates LLM reasoning or compares
completion rates with a running ZCode installation.

Run the pre-existing regression suite **without editing or relaxing its assertions**:

```sh
XHARNESS_BROWSER_TEST_SERVER=1 \
UI_TEST_DEPS="$HOME/codex-build/x-harness-rs-page-priority-browser-deps" \
BROWSER_LEGACY_EVIDENCE=docs/evidence/browser-use-parity-legacy-20261022.json \
node scripts/browser_use/legacy-gate.mjs
```

The wrapper records the original test's SHA-256 and refuses to report success
without exactly 30 completed contract checks and zero exit code. Failures are
compatibility blockers, not reasons to replace this suite with the newer fixture.

Run the aggregate server gate with `bash scripts/browser_use/run-server-acceptance.sh`
and `XHARNESS_BROWSER_TEST_SERVER=1`. It also runs 26 evidence-integrity cases
and seven compiled native-policy control tests before the real browser cases.

## Explicit Host image-chain acceptance

After syncing all current sources and building this plugin on V100, run only the
named opt-in integration test (not every ignored test):

```sh
XHARNESS_BROWSER_TEST_SERVER=1 \
CARGO_TARGET_DIR="$HOME/codex-build/x-harness-rs/target" CARGO_BUILD_JOBS=4 \
cargo test --locked -p xharness-host-app --lib \
  plugin_mcp::browser_e2e::real_browser_mcp_image_reaches_provider_request_and_durable_history \
  -- --ignored --exact --nocapture --test-threads=1
```

This creates its own offline-verified MCP-only plugin, session, fixture, browser
process and durable attachment store. The real Host media sink delivers actual
rendered PNG pixels into a scripted provider's next request. Assertions include
session isolation, no base64 in history and reopening persisted image bytes.
The scripted provider is not an LLM-quality or ZCode performance comparison.
Do not run Rust compilation/tests locally or against an existing user Host.
