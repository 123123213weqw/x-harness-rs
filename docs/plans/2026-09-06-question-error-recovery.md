# Question Error Recovery Implementation Plan

> Execute task-by-task in this worktree; no subagent delegation is authorized.

**Goal:** Return malformed question calls as recoverable tool errors and recover
older failed journals without fabricating human answers.

**Architecture:** Share request parsing in xharness-interaction. Distinguish
pre-request failure from settled human interaction in xharness-session and reuse
that validation for append-only recovery. Exercise the real Loop/tool path.

**Tech Stack:** Rust, serde, Tokio, existing GitHub Actions platform matrix.

### Task 1: Contract and recovery regression tests

- Modify `crates/xharness-session/tests/session.rs`: missing option ID, pre-request
  error, premature success, pending error, closed-turn repair, second repair empty.
- Modify `crates/xharness-core/tests/loop.rs`: invalid call then corrected call
  through AskUserQuestionTool; replay a synthetic old failed session.
- Run in CI: `cargo test -p xharness-session -p xharness-core --all-targets`.
  New regression tests should fail against the original implementation.

### Task 2: Shared implementation

- Modify `crates/xharness-interaction/src/lib.rs`: factor shared request parsing.
- Modify `crates/xharness-session/src/session.rs`: preserve the settlement guard
  only where a durable request exists, and allow narrowly proven closed-step
  invalid-question recovery errors.
- Modify `crates/xharness-session/src/recovery.rs`: emit deterministic malformed
  question errors; leave uncertain outcomes and genuine questions conservative.
- Commit code and tests in focused commits using the authenticated GitHub identity.

### Task 3: Verification and upstream handoff

- Local: `cargo fmt --all --check`, `git diff --check`; no Rust compilation.
- Remote WZU_Server is unavailable; use CI per the user's established direction.
- Upstream CI: workspace tests/check/clippy on Linux, Windows, macOS; desktop
  compilation and existing question lifecycle/restart tests remain enabled.
- Submit to `123123213weqw/x-harness-rs` from the contribution fork. Report actual
  CI status and do not change installed binaries, signing keys or user journals.
