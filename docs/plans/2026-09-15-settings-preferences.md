# Settings preference persistence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix #65: persist the four shipped UI preferences and make failed saves visible.

**Architecture:** Statically register the four known namespaces before control-log replay and reuse the existing fenced, durable settings RPCs. Keep unknown namespaces rejected and remote-browser settings read-only/process-local. Add a signature-checked product UI patch for save-error feedback; do not change models, update feeds or installed applications.

**Tech Stack:** Rust Host/JSONL control log, JavaScript shipped UI patches, Node tests, native process restart tests, GitHub CI.

## Approved design

Use Host persistence, not localStorage or arbitrary namespace registration. Fields match the shipped UI: ui-theme.preference (light/dark/system), locale.preference (zh/en), ui-conversation.busyEnter (queue/steer), agent-presets.default (preset ID). Empty user sections preserve UI fallback defaults. A missing preset falls back to coding without erasing the saved preference. Preset definitions themselves are outside this issue.

Failures are shown as a bounded, dismissible, localized notice with no raw server error or settings values. Superseded writes and disposed scopes must not publish stale notices; failure recovery must not reject an unawaited preference setter. Default-preset UI already has inline error reporting and keeps it.

## Task 1: Host registration and regressions

- Modify crates/xharness-host/src/state.rs; add preference_settings.rs and wire it from lib.rs.
- Validate only these four sections before all settings commits, leaving other namespaces unchanged.
- Add tests in crates/xharness-host-app/tests/restart.rs: three write methods, actual process restart, unset, invalid values, revision conflict, unknown namespaces and unchanged persisted state after failure.
- Check default preset selection/list projection consumes the saved preference; explicit session selection still wins.
- Rust tests: cargo test --locked -p xharness-host -p xharness-host-app. No local Rust compilation. WZU_Server is preferred; SSH currently times out, so CI is the available verification path.

## Task 2: Visible save failures

- Add ui/overrides/settings-save-feedback.js and scripts/patch-settings-save-feedback.mjs.
- Patch settings scope failure/success settlement; use fixed messages, one DOM notice, accessible dismiss action, no HTML interpolation.
- Add scripts/test-settings-save-feedback.mjs covering transport and RPC failure, recovery failure, generation races, disposal, success clearing, memory mode and patch idempotence/anchor rejection.
- Run Node tests before patch refresh (expect failure), then regenerate checked-in dist and graph through the patch script; rerun to green.
- Wire assembly and CI. Verify browser rendering with isolated synthetic settings, never live user data.

## Task 3: Review and submit

- Document persistence boundaries and downgrade caveat: older Hosts do not recognize the new durable namespaces.
- Run formatting, diff checks and regression tests; commit independent changes with the authenticated GitHub identity.
- Push the contribution branch to yyqdbngt/x-harness-rs and open a PR against 123123213weqw/x-harness-rs:master. Include CI results and explicitly state no release/installation change.
