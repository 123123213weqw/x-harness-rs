# Shared Model Settings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add, persist, select and call models from the existing settings UI on every supported platform.

**Architecture:** Host owns protocol adaptation and revisioned durable settings. An injected model settings service owns validation/composition and a separate credential store; the existing runtime owns execution. No frontend-specific state belongs in the agent loop.

**Tech Stack:** Rust, serde, existing Host control store and OpenAI adapter, native credential storage, bundled DeepSeek UI, GitHub Actions.

---

### Task 1: Settings schema and shared service contract

Files: create `crates/xharness-host/src/model_settings.rs`; modify
`crates/xharness-host/src/lib.rs`, `state.rs`, `rpc.rs`; test
`crates/xharness-host/tests/basic_host.rs`.

1. Add tests asserting namespace `llm-pi-ai`, profile path `providers/<id>`,
   supported protocol choices, revision rejection and invalid profile rejection.
2. Add injected service/credential interfaces and serialized schema matching
   `CustomProviderCard` and `ProviderEditor` (baseURL, apiKeyEnv, models).
3. Route settings and credential RPCs through the service when installed,
   preserving compatibility for embedded Hosts without a native service.
4. Verify formatting locally with `cargo fmt --check --all`; run regression tests
   on CI (`cargo test -p xharness-host --test basic_host`). Commit independently.

### Task 2: Native composition, persistence and credentials

Files: modify `crates/xharness-host-app/src/config.rs`, `main.rs`,
`Cargo.toml`; create `crates/xharness-host-app/src/model_settings.rs`.

1. Test translation of profiles to existing provider configuration, import of
   existing deployments, missing credentials and empty initial installations.
2. Implement credential resolution with environment overrides and native store;
   supply fake stores in tests so CI never needs real account credentials.
3. Restore persisted profile state before model activation; reuse provider
   construction without coupling settings RPCs to HTTP protocol implementation.
4. Validate all metadata before commit, preserve current state on failure and
   ensure credential mutation can refresh a previously unconfigured route.
5. Run native tests in CI and commit this component separately.

### Task 3: Runtime application and discovery

Files: modify `crates/xharness-host/src/runtime.rs`, `rpc.rs`, and native service.

1. Test that new models are routable, changed keys affect subsequent calls,
   in-flight turns retain their provider, removed routes fail clearly, and
   discovery uses only the selected configured endpoint.
2. Implement validated registry replacement and catalog notifications where
   safe; otherwise expose restart-required status without automatic restarts.
3. Ensure the model selection UI reads the same authoritative model catalog.
4. Run affected Host/runtime regressions in CI; commit.

### Task 4: End-to-end acceptance and delivery

Files: create `crates/xharness-host-app/tests/model_settings.rs`; modify
`docs/specs/desktop.md`, `docs/windows.md` as necessary.

1. Drive settings.describe, mutate, credentials.set, llm.models, session create
   and a real HTTP mock-provider turn using the compiled Host executable.
2. Restart with the same temporary state and verify profiles and routes survive.
3. Verify secrets never appear in API responses or control logs; cover bad keys,
   stale revisions and unavailable storage with explicit failures.
4. Run full Linux/macOS/Windows CI, build Windows installer, publish scoped PR.
5. Stage the verified Windows artifact, retain old data, restart the desktop and
   inspect actual UI behavior. Real provider smoke test only with an available
   user-authorized credential; never embed a key in source or CI configuration.

## Current verification constraints

WZU_Server closed SSH during the initial read-only check. Use GitHub CI as already
authorized; no local cargo build/check/test/clippy. CI results and local packaged
UI verification are required before describing this feature as complete.
