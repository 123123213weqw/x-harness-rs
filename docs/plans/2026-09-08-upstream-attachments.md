# Upstream Attachments Implementation Plan

> Execute sequentially in this worktree; no subagent delegation was requested.

**Goal:** Make shared XHarness attachments durable and genuinely available to compatible models, with upstream-style text-only fallback.

**Architecture:** Typed optional content blocks extend existing messages without changing legacy text fields. A shared attachment store owns validated bytes. The host admits references and authorizes reads; provider request projection resolves images only for explicitly image-capable routes.

**Tech Stack:** Rust, serde, SHA-256, bounded image decoding, Tokio; existing upstream React module bundle; Node test runner and cross-platform Rust CI.

---

### Task 1: Session references and attachment store

Files: `crates/xharness-session/src/message.rs`, `crates/xharness-session/src/lib.rs`; new `crates/xharness-attachment/`; workspace manifest.

1. Add failing tests for old message JSON, ordered mixed content, digest validation, corrupted image, sanitized names and reopened storage.
2. Implement typed references and bounded, atomic immutable storage.
3. Run focused session/store tests remotely and format locally. Commit this independent boundary.

### Task 2: Admission and replay

Files: `crates/xharness-host/src/rpc.rs`, `driver.rs`, `restore.rs`, `lib.rs`, `state.rs`; `crates/xharness-host-app/src/main.rs`.

1. Add host tests for mixed admission, failed batch, cross-session read refusal, restart and queued/steered input.
2. Replace memory-only image admission with store references, preserve blocks through runtime messages, and authorize retrieval from durable history.
3. Exercise focused host tests and commit.

### Task 3: Capability-aware provider input and tools

Files: `crates/xharness-provider-openai/src/protocol.rs`, `provider.rs`; host runtime/model settings; native composition; token meter; read-image tool.

1. Add wire fixtures for image-capable and text-only routes, both protocols, missing images and retained references.
2. Persist explicit `inputModalities` configuration and project references at the model boundary; account for images in budgets.
3. Add route-gated `read_image` using existing filesystem permissions; persist its reference before publishing the result.
4. Run focused tests remotely and commit.

### Task 4: Shared composer and history UI

Files: deterministic patch/source scripts under `scripts/`, existing `ui/dist/plugins/` attachment/conversation/model modules, Node tests.

1. Add tests for ordered image/file selection, clipboard images, retry/draft preservation and historical rendering.
2. Adapt upstream-style file cards and upload controls without updating unrelated UI modules or changing native shell behavior.
3. Run Node tests and an isolated browser preview when a tested host artifact is available. Commit.

### Task 5: Integration and delivery

1. Run full Rust CI on Windows/Linux/macOS as supported by existing jobs; inspect failures and fix on the same branch.
2. Record actual tests and known compatibility differences in `docs/specs/attachments.md`.
3. Submit one upstream PR using the current authenticated GitHub identity, per the user's standing repository preference. Do not merge or release automatically.
