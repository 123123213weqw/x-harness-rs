# Runtime Diagnostics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. In this environment use the available executing-plans guidance; do not delegate without user authorization.

**Goal:** Ship lightweight permanent diagnostics and an explicitly enabled, expiring deep-diagnostic tier in the same desktop product, without installing or publishing during development.

**Architecture:** A portable diagnostic recorder owns bounded, typed metadata files, abnormal-run markers and export. Desktop owns Host lifecycle/resource observation independently of the Host. The deep tier is a runtime lease, never a different production identity or automatic tool replay. Native unsafe operations stay in xharness-win32.

**Tech Stack:** Rust/serde, Tauri 2, vanilla JavaScript, Windows APIs behind cfg, GitHub Actions, Python contract tests.

## Decisions and boundaries

- Chosen: one product, two tiers and two independently reviewable implementation batches. Alternatives were a separate diagnostic application (harder for intermittent reproduction) and always-on full trace (unacceptable privacy/resource cost).
- Work from upstream/master ceba2e2 in isolated btlqql/runtime-diagnostics. Preserve installed payload, state, provider credentials and updater feed.
- Rust build/test/check only on WZU_Server or CI, never local Windows.
- Metadata export uses a typed allowlist, not heuristic redaction of arbitrary logs. No chat/config/environment/raw stderr is included. Dump files are explicitly sensitive and excluded from metadata export.
- Deep recording expires, stops on a byte budget and is off after restart. Heap instrumentation requiring a different build or OS changes must be documented separately, not silently enabled system-wide.
- Preserve exact version/source/toolchain/hash and symbols separately from installers. Actions artifacts alone are not permanent storage; document retention and durable archival requirement.

## Task 1: Portable bounded recorder (tier 1)

Files: create crates/xharness-diagnostics/{Cargo.toml,src/lib.rs}; modify Cargo.toml/Cargo.lock.

1. Add tests for rotation, strict record schema, interrupted marker, normal shutdown and export failure.
2. Remote `cargo test -p xharness-diagnostics`; confirm initial failure before implementation.
3. Implement fixed-size log segments, typed events, atomic run marker, and bounded JSON export without recursive directory collection.
4. Re-run remote tests/clippy; commit this independent unit.

## Task 2: Desktop lifecycle and recovery (tier 1)

Files: apps/desktop/src-tauri/src/{lib.rs,sidecar.rs,diagnostics.rs}, build.rs, capabilities/desktop-main.json, Cargo.toml; frontend/diagnostics.html; ui/desktop/diagnostics.js; scripts/assemble-static-ui.mjs.

1. Test state transitions (expected/unexpected exit, missed event, no auto retry).
2. Attach recorder to desktop; observe Host exit and low-frequency owned-PID resources.
3. Open an independent bundled diagnostic window from normal UI or automatically on unexpected Host exit. Never navigate away from the existing chat/draft or restart a tool.
4. Explicit user recovery closes/reopens the application only; no autonomous replay. Export must report actual failure.
5. Test UI/controller locally in Node and browser, Rust on remote/CI; commit.

## Task 3: Expiring deep diagnostics (tier 2)

Files: crates/xharness-debug/src/diagnostics.rs; xharness-host-app/src/main.rs; xharness-win32/src/diagnostics.rs; desktop diagnostic commands/UI.

1. Add lease expiry/restart/stop/budget tests.
2. Capture bounded detailed event metadata without payload as the safe enhanced trace. Raw full trace is a separate explicitly sensitive opt-in, never auto-exported.
3. Implement scoped Windows process sampling and optional memory capture; do not touch global registry settings or unrelated processes. Test failure/cleanup paths.
4. Document best-effort crash capture limits and heap-check limitations explicitly; do not claim crash first-write capture without evidence.
5. Remote Rust tests and native Windows CI acceptance; commit.

## Task 4: Symbols and regression coverage

Files: .github/workflows/desktop-release.yml, scripts/archive-desktop-symbols.py and tests; docs/runtime-diagnostics.md.

1. Keep release optimization; enable release debug information and disable stripping during native builds.
2. Archive Windows PDBs with matching binaries, source SHA, toolchain and SHA256 inventory separately; fail on missing symbols. Never publish runtime diagnostic data.
3. Add CI coverage for both diagnostic tiers, Windows capture and JS recovery/export flow.
4. Run relevant release contract tests and inspect generated artifacts. Report native acceptance honestly if not run.

## Acceptance

- Bounded default overhead/storage; failures do not abort normal Agent work.
- Abnormal exits survive app restart and are visible even when Host is unavailable.
- Export contains only allowlisted metadata; no automatic network upload.
- Deep state expires and is off after application restart; evidence files obey a separate budget.
- No production installation, release publication, signing-key change or tool replay.
