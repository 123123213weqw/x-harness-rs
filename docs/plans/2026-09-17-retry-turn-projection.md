# Retry Turn Projection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore chat history after model retries without changing durable sessions.

**Architecture:** Convert durable one-based retry turns at the Host's existing Web projection boundary, just like turn/start and turn/end. Keep the frontend's ordering checks and original journals unchanged. Rewriting journals would damage the canonical coordinate system; relaxing frontend validation would hide the wrong association.

**Tech Stack:** Rust Host/session, shipped JavaScript conversation assembler, Node.js, remote Cargo tests and GitHub Actions.

## Task 1: Regression contract

- Modify `crates/xharness-host/src/restore.rs`: extend the existing durable approval/retry projection test through the next turn; assert both retry events use Web turn 0, retain metadata, and agree with full history and paged projection.
- Create `scripts/fixtures/retry-turn-projection.json`: shared expected turn associations for two consecutive turns.
- Create `scripts/test-retry-turn-projection.mjs`: run the shipped assembler and turn-error definition against the shared contract, through live append, full reload, and every pagination split. Prove sensitivity by shifting only retry turns back to the broken numbering.
- Run Node locally; synchronize source without `.git`, `target`, `node_modules`, `.env` or `.env.*` to WZU_Server under `~/codex-build/x-harness-rs/`; run the Rust test there before the fix and require failure.

## Task 2: Minimal fix

- In `restored_web_event`, remove `LlmRetry` and `LlmRetryStarted` from the raw passthrough arm.
- Add a shared arm preserving `tagged_event_data`, setting only `data["turn"] = json!(web_turn(*turn))`.
- Run the regression remotely again, followed by the Host restore tests, Host tests and clippy. Run `cargo fmt --all -- --check` locally (no compilation).

## Task 3: Integration

- Add the Node regression to `.github/workflows/ci.yml`.
- Review the diff, commit with the authenticated GitHub identity, push a contribution branch and open an upstream Draft PR.
- Report exact checks; do not replace the installed app, publish a release, or alter user history.

## Acceptance

Both retry event types use the same zero-based turn as their start/end; next-turn history loading succeeds; retry UI suppresses only its own turn error. Existing session data needs no migration. No local Rust compilation is permitted.
