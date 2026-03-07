# History Argument Integrity Implementation Plan

**Goal:** Prevent history compaction markers from being copied into executable file mutations while preserving strict validation and durable session history.

**Architecture:** Make the lightweight context policy output-only for tool data: all tool arguments and provider-owned replay items remain byte-for-byte intact. Continue using the existing durable compaction coordinator for whole-history summaries. Reject old projected write/edit invocations before schema validation, approval, resource locking or handlers, with an explicit read-and-regenerate diagnostic.

**Tech Stack:** Rust, xharness-context, xharness-tools, existing OpenAI-compatible adapters, native filesystem integration tests; compilation only on WZU_Server or CI.

## Decisions and trade-offs

- Do not allow extra tool properties or strip `_xharness_history_projection`: omitted file contents cannot be reconstructed from a marker/hash.
- Stop rewriting both provider-neutral arguments and Responses function_call arguments. Keep existing reasoning/output pruning, hard token guards, immutable logs and the independently framed durable summary mechanism.
- Retain the old public threshold constant and serialized edit-count field for compatibility, but no longer apply argument pruning. Increment the context policy version so audit records identify the behavior change.
- Add narrowly scoped legacy recognition: the root internal property on write/edit, or an entire mutation field matching the exact old marker grammar. Do not reject arbitrary documents/code merely mentioning the marker, and do not silently retry a mutation.
- Large write-heavy histories cost more input tokens and may compact sooner. Remove the old 5x argument-pruning performance assertion; replace it with byte-for-byte argument integrity plus still-measurable reasoning pruning.
- Already logged failed model calls are retained as evidence, not rewritten or replayed. The new execution error directs recovery; old request snapshots remain untouched.

## Task 1: Context and wire regression

Change `crates/xharness-context/src/lib.rs`, `tests/multi_tool_ablation.rs` and `crates/xharness-provider-openai/tests/protocol.rs`. Assert successful long write/edit calls remain exactly unchanged, including provider items; current/failed/unresolved calls and images retain behavior. Run focused tests against the old implementation to reproduce the violation on WZU_Server.

## Task 2: Remove unsafe projection

Remove completed-argument rewriting and its hash machinery, retain output/reasoning pruning and legacy serialized fields. Update current context documentation and annotate historical benchmark evidence instead of overwriting its measurements.

## Task 3: Legacy execution guard

Add a small private compatibility validator in xharness-tools before schema admission. Cover root marker, marker-only write content and edit old/new, with/without metadata, wrong tools, normal documentation/code mentioning the marker, and invalid unrelated fields. Add real coding-tool tests proving no creation/overwrite/edit occurs and a subsequent valid read/write/edit can succeed.

## Task 4: Verify and submit

Use a separate snapshot directory under `~/codex-build/x-harness-rs/` (exclude .git, target, node_modules and .env files). Run context, tools, provider and coding-tool tests remotely plus the existing compaction regressions. Run local cargo fmt only. Commit with the active GitHub identity and submit an upstream PR via the contribution fork. Do not merge, publish or touch the running desktop App/data.
