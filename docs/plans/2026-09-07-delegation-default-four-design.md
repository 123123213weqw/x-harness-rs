# Delegation Default Four Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Default to four concurrent child turns, with startup-only choices of 2/4/8 shared across desktop and Web Hosts.

**Architecture:** Keep the existing durable queue, whole-turn semaphore ownership and cancellation paths. A validated Host type selects semaphore size at construction, while existing constructors retain their signatures and use the new default. Host-app exposes CLI/environment configuration; no process-global environment reads in the reusable runtime and no live resizing.

**Tech Stack:** Rust/Tokio, Host library and native Host-app, existing cross-platform CI.

---

## Approved design

- Default four is based on the 2026-09-07 isolated 2/4/8 experiment, not a claim about real-model code quality.
- Main turns bypass this child-only semaphore; all conversations in one Host share child capacity.
- CLI `--delegation-concurrency` overrides `XHARNESS_DELEGATION_CONCURRENCY`; accept only 2, 4 and 8. Invalid values fail startup before state ownership/writes.
- Preserve admission cap 16, parent catalog cap 128, inbox cap 32, direct-child authority and no-grandchildren rule.
- Do not change running Apps, updater channels, release version or session data. Do not add UI or a second scheduler.

## Task 1: Runtime and default regression

**Files:** `crates/xharness-host/src/delegation_concurrency.rs`, `crates/xharness-host/src/runtime.rs`, `crates/xharness-host/src/lib.rs`, `crates/xharness-host/src/delegation.rs`.

1. Define a validated 2/4/8 capacity type with default four and parsing tests.
2. Preserve `new` and `from_registry`; introduce a constructor with an explicit capacity, allocating the semaphore once before activation.
3. Change default peak regression from two to four; change queued cancellation target from third to fifth. Use explicit fixture gates instead of timing assumptions.
4. Verify configured two/eight and default four, queued cancellation/input retention, slot release, and parent bypass while child slots are full.
5. Format locally; compile/test in authorized CI because WZU_Server currently closes SSH.

## Task 2: Shared startup configuration

**Files:** `crates/xharness-host-app/src/main.rs`, `docs/specs/agent-delegation.md`.

1. Add parsed startup setting, explicit constructor wiring and non-secret startup debug metadata.
2. Test absent value, valid environment/CLI, CLI precedence, invalid/zero/overflow and missing argument.
3. Document four as default, startup-only overrides and unchanged safety limits.
4. Run existing workspace/desktop CI on an upstream PR; do not change release or installed App.

## Evidence baseline

The isolated experiment at commit 0b70f63 passed on Windows/Linux/macOS in run 34128016475 and was repeated locally using the CI-compiled test executable. Keep that experimental branch separate from this focused production change.
