# Safe History Restore Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Start the Host without projecting durable history into Web JSON, while preserving exact metrics and lazy access to every old conversation.

**Architecture:** Treat the append-only Session as the only startup source of truth. Rebuild metrics directly from typed `LoggedEvent`/`EventData`, register each durable session with an empty Web-event cache anchored at `next_seq`, and let the existing `session.history` endpoint materialize bounded pages only when a client opens a conversation. Live events after the anchor continue through the existing projection and publication path.

**Tech Stack:** Rust, serde/serde_json, Tokio, Axum Web API; remote Cargo tests on `WZU_Server`; Windows release validation through CI and the isolated copied-history reproducer.

---

## Design decisions

- Do not delete, rewrite, sanitize or migrate any journal event.
- Do not replace JSON-RPC in this change. The crash occurs before the transport listens; transport migration is a separate compatibility project.
- Do not merely lower the 2,048-event/16 MiB cache. Startup must call no Web history projector at all.
- Keep live projection behavior and the `session.history` wire contract unchanged.
- Do not rely on `catch_unwind`; a Windows access violation is not a recoverable Rust panic.
- If typed startup restoration still produces a native access violation, use the Rust 1.97/1.98.1 differential build and process isolation as follow-up containment rather than hiding an unreadable event.

## Task 1: Typed metrics restoration

**Files:**
- Modify: `crates/xharness-host/src/metrics.rs`
- Modify: `crates/xharness-host/src/restore.rs`

1. Add tests that build representative durable events for request context, usage, first-token timing, tool timing, step/turn counts and model changes.
2. Project the same fixtures through the legacy Web event path and assert that typed restoration produces identical `tokenUsage`, `sessionStats` and `contextPressure` values.
3. Add a whole-log typed rebuild entry point that consumes `&LoggedEvent` values without creating public projection updates or Web JSON on each event.
4. Keep the existing `apply(&Value)` path for live Web events; share normalization helpers so restored and live metrics do not drift.
5. Run remotely:
   `cargo test -p xharness-host metrics::tests --lib`
6. Commit the independently verified metrics change.

## Task 2: Zero Web projection during Host restore

**Files:**
- Modify: `crates/xharness-host/src/restore.rs`
- Modify: `crates/xharness-host/src/state.rs` if an explicit empty authoritative-tail constructor is needed

1. Add a restore regression asserting that an authoritative session starts with an empty event cache, `event_base_seq == next_seq`, zero cached bytes and the exact typed metric snapshots.
2. Replace the full-history `restored_web_event` metrics loop with typed metrics restoration.
3. Remove `project_session_event_tail` from `restore_from_store`; initialize a cold authoritative cache at the durable `next_seq`.
4. Preserve ephemeral-runtime compatibility, queue/admission recovery, approvals, questions, titles, goals, permissions and model selection.
5. Update tests that assumed startup eagerly populated `SessionRecord.events`; verify complete history through `session.history` instead.
6. Run remotely:
   `cargo test -p xharness-host restore::tests --lib`
7. Commit the independently verified cold-restore change.

## Task 3: Prevent resumed work from rebuilding cold history

**Files:**
- Modify: `crates/xharness-host/src/driver.rs`
- Modify: `crates/xharness-host/src/state.rs`
- Test: `crates/xharness-host/src/dynamic_projection_tests.rs`

1. Add a regression for a restored session whose runtime resumes before the HTTP listener: synchronization at the current authoritative cursor must not rebuild the old projected tail.
2. Preserve an empty cold cache when the authoritative cursor is already current.
3. For events appended after that cursor, project only the new range, publish it once, and retain it under the existing event-count and byte budgets; do not rescan the old journal tail.
4. Keep gap repair explicit: a stale/missing cursor must return a recoverable synchronization error or use `session.history`, never silently replay model/tool work.
5. Run remotely:
   `cargo test -p xharness-host dynamic_projection_tests --lib`
6. Commit the independently verified incremental-sync change.

## Task 4: Product and incident verification

**Files:**
- Modify tests only as required; do not copy private journals into Git.

1. Run local non-compiling checks:
   `cargo fmt --all -- --check`
   `git diff --check`
2. Sync the worktree to a dedicated `WZU_Server` directory, excluding `.git`, `target`, `node_modules`, `.env` and `.env.*`.
3. Run remotely:
   `cargo test -p xharness-host --lib`
   `cargo test -p xharness-host-app --test restart`
4. Run existing Node history regressions locally, including atomic history and session history cache tests.
5. Build the Windows release artifact in CI, then run the copied real-history cold-start reproducer for at least 100 iterations with no model calls, tools or original-journal writes.
6. Open the affected conversation, page through old history, send a new message, restart, and verify the message plus metrics remain durable.
7. Submit the small commits from `yyqdbngt/x-harness-rs` as one PR to `123123213weqw/x-harness-rs`; do not publish a release until CI and Windows acceptance are green.

## Acceptance criteria

- `restore_from_store` does not call `restored_web_event` or `project_session_event_tail` for authoritative sessions.
- A restored authoritative `SessionRecord` contains no projected historical events before a client asks for history.
- Restored metrics exactly match the previous Web-projection reducer for equivalent durable logs.
- `session.history` still returns complete, ordered, paginated old history without modifying the journal.
- Resuming pending work projects only events newer than the restored authoritative cursor.
- One unreadable session remains an isolated startup issue and does not hide healthy sessions.
- The real copied Windows history completes 100 cold starts without an access violation.
