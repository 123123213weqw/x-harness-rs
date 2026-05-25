# Observable Startup and Safe Recovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make desktop startup observable and bounded, move expensive recovery behind a live Host endpoint, stop automatic replay of incomplete tools, and declare DeepSeek reasoning capabilities explicitly.

**Architecture:** The Host exposes `live` after basic initialization and network bind, then restores durable state behind a server readiness gate. The authenticated desktop bootstrap page waits for full `ready`. A closed progress-file protocol lets the desktop extend an idle deadline only on real progress, under a fixed 120-second cap. Recovered in-flight work is paused rather than executed.

**Tech Stack:** Rust, Tokio, Axum, Tauri, serde, existing JSONL session store, committed provider JSON, GitHub Actions/remote Rust builder.

---

### Task 1: Closed startup progress protocol

Files: modify `crates/xharness-diagnostics/src/lib.rs`, `apps/desktop/src-tauri/src/sidecar.rs`, and `crates/xharness-host-app/src/main.rs`.

1. Add bounded, versioned startup-stage receipts with monotonic sequences and atomic writes.
2. Pass a unique progress path to the Host and publish predefined milestones plus periodic heartbeat receipts.
3. Replace the fixed desktop deadline with an idle deadline that resets only on a newer valid receipt and an absolute 120-second limit.
4. Cover malformed, oversized, regressing, stalled, progressing, and absolute-timeout cases.

### Task 2: Split live transport from restored readiness

Files: modify `crates/xharness-server/src/lib.rs`, `crates/xharness-host-app/src/main.rs`, and server integration tests.

1. Add a shared readiness gate, `/health/live`, and a readiness-aware `/health/ready`.
2. Gate product API/WebSocket/export routes until restoration succeeds.
3. Serve an authenticated, inline desktop recovery page that polls readiness and reloads into the normal UI.
4. Bind and publish the live endpoint before durable session replay and model-route reconciliation; mark ready only after both complete.
5. Preserve explicit failure receipts and orderly shutdown if background restoration fails.

### Task 3: Pause incomplete recovered work

Files: modify `crates/xharness-host/src/restore.rs` and its recovery tests.

1. Classify sessions that require runtime resumption as interrupted work.
2. Rebuild their history and UI projections with dispatch paused, without calling `resume_session` or starting a driver.
3. Preserve the existing explicit user-prompt resume path and ensure it is the only action that reopens the gate.
4. Add a durable-session regression whose final event is `tool/call`; assert startup invokes neither provider nor tool and reports the paused recovery.

### Task 4: DeepSeek reasoning declaration

Files: add `config/providers.deepseek.example.json`; modify model-setting documentation and parsing tests.

1. Restore a first-class DeepSeek example using the current provider-neutral `reasoning` schema.
2. Declare every supported effort and its exact request patch for the configured protocol.
3. Document migration for existing provider files that lack reasoning metadata.
4. Parse the example in tests and verify saved selections remain supported.

### Task 5: Verification and upstream delivery

Files: update relevant specs and CI only if required by the new tests.

1. Run `cargo fmt --all -- --check` locally and all non-Rust UI/config checks.
2. Sync the worktree to the approved remote builder and run focused tests, then the full workspace suite/CI.
3. Keep implementation commits small and scoped; push the branch to the current GitHub fork.
4. Open a draft pull request against `123123213weqw/x-harness-rs`, attach it to the task, and report verified behavior and remaining risks.
