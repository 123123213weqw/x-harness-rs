# Durable tool results implementation plan

**Goal:** Persist large tool results before publishing a reduced observation, with bounded session-scoped history search and paging after restart.

**Architecture:** Reuse the session Store boundary for immutable content-addressed result blobs. Core saves the complete result envelope before reducing it and journals a reference. One read-only Host history tool exposes original event text and archived results only for its bound session. Keep the argument-integrity fix and existing balanced compaction planner.

**Tech stack:** Shared Rust session/core/host crates, JSONL plus immutable local blobs, SHA-256, existing tool executor and remote Cargo tests.

## Decisions (accepted scope from user)

- Prefer cold blobs over inline full journal results (avoids hot replay growth) or external databases/services (unnecessary operational dependency).
- No automatic cross-session access, raw filesystem path inputs, retention deletion, release, or installed-App replacement.
- Store the tool-returned envelope including errors and upstream truncation status; cannot recover bytes a tool itself never returned. Old lost output is not reconstructable.
- Publish only verified, durable references. Storage failure stops the turn with an explicit diagnostic; never rerun a side-effecting tool to recreate its output automatically.
- Small observations remain unchanged. Large ones use a bounded excerpt plus reference. Preserve call/result identities, native replay and pending interactions.
- History searches return bounded excerpts and continuation positions; retrieved text is historical evidence, not new user authority.

## Task 1: Archive storage

Files: `crates/xharness-session/src/store.rs`, new `tool_archive.rs`; `crates/xharness-session-jsonl/src/lib.rs`, new `results.rs`; archive integration tests.

1. Add default-unsupported Store archive/read seams and an in-memory test implementation.
2. Write tests for restart, deduplication, wrong-session access, malformed references, corrupted content and failed publication.
3. Implement bounded, digest-verified, private, no-overwrite publication; reject linked paths.
4. Run tests on WZU_Server; commit independently.

## Task 2: Core publication and context retention

Files: `crates/xharness-core/src/engine.rs`, `tool.rs`, core integration tests; `crates/xharness-context/src/lib.rs`.

1. Test that a large tool result is archived before the next provider call and readable after restart.
2. Save before reduction; attach archive reference to result envelope and journal metadata. Keep small outputs and tool arguments unchanged.
3. Preserve references through request-side pruning. Explicit failure on unsupported/failing stores, no false success/reference and no implicit tool retry.
4. Verify balanced compaction and pending-question regressions; commit.

## Task 3: Bounded history tool

Files: new `crates/xharness-host/src/history_tool.rs`, host `lib.rs` and `runtime.rs`.

1. Bind tool to session at construction; do not accept a session/path argument.
2. Expose search over conversational events and full archived tool envelopes, plus bounded UTF-8 paging by event sequence/reference.
3. Test middle-content lookup, pagination, limits, restart, no cross-session access and read-only execution.
4. Register in the shared Host runtime; commit.

## Task 4: Verification and upstream handoff

Update context/tool docs with exact guarantees and limits. Run local `cargo fmt --all -- --check` and `git diff --check` only. Sync source to an isolated directory under `~/codex-build/x-harness-rs/` excluding `.git`, `target`, `node_modules`, `.env`, `.env.*`; execute remote targeted tests followed by workspace tests and Clippy. Submit upstream PR with dependency on PR #53 (still open), no merge or release.
