# Projection Cost Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce temporary projection allocations and global state lock work without changing journal or model-history semantics.

**Architecture:** Keep the per-session projection gate and authoritative immutable snapshot. Move owned JSON into the envelope; count serialized bytes through an IO sink. Prepare event ranges and tool views outside the global lock and validate publication inputs before mutating state. Do not replace the projection architecture or deploy an App in this change.

**Tech Stack:** Rust, serde_json, Tokio; remote Cargo tests on WZU_Server; existing cross-platform CI.

---

## Task 1: Owned event envelope

- Modify/test `crates/xharness-host/src/restore.rs`.
- Extract envelope construction; test exact JSON equivalence and preservation of an owned nested String's allocation address.
- Run the regression remotely with the old json! envelope and confirm the allocation test fails.
- Replace envelope construction with `serde_json::Map::from_iter`, moving type and data Values.
- Run focused tests and commit independently.

## Task 2: Allocation-free serialized-size sink

- Modify/test `crates/xharness-host/src/restore.rs`.
- Add a checked `std::io::Write` byte counter; compare to `serde_json::to_vec` for escaping, Unicode, nested values, large payloads and numeric/null values; exercise overflow.
- Use `serde_json::to_writer` with the sink instead of retaining a temporary encoded Vec. Preserve the tail's existing byte-limit/error behavior.
- Verify exact-limit/one-byte-short tail behavior and existing history regressions; commit independently.

## Task 3: Prepare outside the global lock

- Modify/test `crates/xharness-host/src/driver.rs` and focused test module as needed.
- Capture cursor, session identity and full model selection with the snapshot's projection inputs. Prepare projected new events, tool views and blank-state scan before acquiring the write lock. Keep small mutable metrics/state application under the lock.
- Recheck captured inputs before mutation, retry from a fresh snapshot on mismatch with a bounded retry count, and return an explicit error on repeated contention. Never publish a stale result or advance its cursor.
- Keep the per-session gate through publication. Add deterministic stale-cursor/model-input tests and concurrent synchronization coverage. No raw pointers or unsafe code.
- Run Host regressions remotely and commit independently.

## Validation and handoff

- Local `cargo fmt --all -- --check` and `git diff --check` only; do not compile Rust locally.
- Sync source excluding `.git`, `target`, `node_modules`, `.env*`, and secrets to a dedicated remote test location accessible beneath `~/codex-build/x-harness-rs/`; do not overwrite another test checkout.
- Remote: `cargo test -p xharness-host --lib` (bounded build parallelism). Record selected counts, failures and limitations; compile/test on Windows/macOS through repository CI after upstream PR submission.
- Compare event JSON and tail boundaries; preserve control lifecycle, raw journal seq, model input and original tool arguments.
- No claims that this fixes the unexplained production access violation, eliminates full-history memory residency or caps oversized payload construction.
