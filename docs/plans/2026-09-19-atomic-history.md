# Atomic Frontend History Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A failed frontend history mapping must leave the previous usable conversation intact and expose a read-only retry.

**Architecture:** Build replacement windows in a fresh ConversationNodeAssembler, including view materialization, then publish the completed state while retaining the public assembler identity. Session raw events, cursors and buffered live events commit only after mapping succeeds. Preserve the existing per-event streaming path; do not replay model or tool work.

**Tech Stack:** Shipped JavaScript runtime, reproducible product override/patch, Node VM regression tests, existing browser regression suite.

## Design decision

The user approved staged replacement. Catching and ignoring invalid events would hide protocol bugs. Cloning the whole conversation for every streamed delta would add excessive cost. Stage only full-window replacement and low-frequency pagination; leave ordinary streaming incremental. Temporary old/new mappings coexist during staging; this is not a zero-peak-memory optimization or a fix for the independent native Host crash.

## Task 1: Regression first

- Create `scripts/test-atomic-history.mjs` exercising the actual shipped assembler and Session.
- Verify failure before start, reducer failure and view-builder failure preserve the old raw window, cursor, mappings and rendered snapshot.
- Cover successful retry, buffered event deduplication/gaps, failed pagination, resync generations and no prompt/tool replay.
- Run `node scripts/test-atomic-history.mjs`; confirm failure against the original bundle.

## Task 2: Atomic history implementation

- Create `ui/overrides/atomic-history.js` and `scripts/patch-atomic-history.mjs`.
- Stage `replaceWindow` and `prepend`, materialize fresh views before adopting state, and keep assembler object identity.
- Stage Session window plus buffered tail before committing arrays/cursors; leave failed buffers available for read-only recovery.
- Preserve history during `resync`, expose loading/error state, retain generation checks in all asynchronous paths.
- Route history retry through history RPC only; display retry beside the existing localized error message.
- Hook the patch into `scripts/assemble-static-ui.mjs`; regenerate bundle and graph using the patch script.

## Task 3: Verification and handoff

- Add Node regression to `.github/workflows/ci.yml`.
- Run atomic-history, assistant-projection, retry-turn-projection and existing history-cache browser tests where dependencies are available.
- Verify patch idempotence, graph hashes and unchanged Rust sources. No local Rust compilation.
- Document boundaries in `docs/specs/session-history-cache.md` and make atomic Git commits under the current authenticated identity.
- Keep installed App and original journals untouched. Report verification limits; do not claim native crash resolved.

## Execution note

Referenced `superpowers` skills are unavailable in this environment; use the available Code/executing-plans guidance directly without delegation.
