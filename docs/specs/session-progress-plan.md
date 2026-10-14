# Session working plan / Progress — phase 1

## Boundaries

The existing `goal` tool gains `update_plan`; no TodoRead/TodoWrite tool or second
execution loop is registered. A working plan is a session-local record, independent
of a persistent Goal. Writing/clearing/completing plan items never creates, resumes,
pauses, or completes a Goal, and never starts a model turn. Core adds this metadata event to the existing external-control CAS rebase
allowlist and reconstructs missing plan context as described in
`session-progress-context-hydration.md`; it does not change scheduling or the loop
termination algorithm. The existing Goal
report, authorization, cancellation and automatic-continuation rules are unchanged.

The model owns item selection, parallel work and completion claims. The runtime
checks the contract and persists it; a checked item is not an independently verified
acceptance result. The UI is read-only and optional.

## Model interface

```json
{"action":"update_plan","plan_revision":0,"items":[
  {"id":"fix","title":"Fix the parser","status":"in_progress"},
  {"id":"tests","title":"Run regression tests","status":"pending"}
]}
```

- Send the whole current list. `[]` clears the visible list but retains history.
- Preserve item IDs when changing state or wording. Ordering is model-owned.
- Status is `pending`, `in_progress`, or `completed`. Parallel in-progress items
  are allowed. No mandatory sequence, priority taxonomy or per-item judge is added.
- `plan_revision` is 0 before the first update; use the revision returned in
  `result.plan.revision` thereafter. Existing `goal {action:"get"}` also returns
  `plan` alongside the current Goal (which may be null). Stale writes are rejected.
- Item IDs must be nonblank, unique and <=128 UTF-8 bytes; titles nonblank and
  <=2048 UTF-8 bytes; at most 128 items. These are payload bounds, not a task budget.

The additive business RPC is `goal.updatePlan`, taking `sessionId`, `planRevision`
and typed `items`; it returns `{plan:{revision,items}}`, NOT a Goal reference.
The transport envelope and existing RPC signatures are not changed.

## Persistence and projections

`session/plan-updated` carries a validated, contiguous-revision SessionPlan.
The append and its existing session mutation receipt are atomic. Retrying the same
RPC/execution ID and payload replays its original receipt; stale concurrent writers
cannot overwrite each other. It uses the existing admission/CAS path, not an
extra background worker. Child and parent sessions have distinct plan storage.

The read side is the generic `taskPlan` session projection: history page seed and
live `session/projection` frames. A rebuildable whole-plan cache survives bounded
history tails and idle recovery checkpoints. Unrelated streaming events do not
republish the plan. The working plan must not use the preexisting `plan` projection,
which means plan-mode permission state, or the `goal` projection.

The plan event is operational metadata, not a synthetic user/assistant message,
reasoning, or an automatically resumed instruction. Completed ordinary turns may
still end; this phase does not enable autonomous work from pending items.

Old histories without plans load normally and show no card. This is forward
migration support; an old binary that does not recognize the new event is NOT
promised to read newly written histories on downgrade. Do not silently rewrite
or delete unknown events to make a downgrade appear successful.

## UI

The existing Goal UI module also registers a separate read-only input-dock Progress
surface. It shows completed/total, ordered items, completed strike-through, and
in-progress arrows. Native details disclosure supports keyboard folding. It reads
validated generic projection data, escapes titles as text, and has no execution
controls. Empty/absent/invalid plans render nothing.

No fabricated Agents count is displayed. Missing-state hydration after Compact/replay
is now implemented separately in `session-progress-context-hydration.md`. No periodic
reminder is added. Linking the existing real Agent activity surface remains follow-up
work, not a claim of this implementation.

## Acceptance

- Rust: session contract/validation; actual Goal tool executor and ordinary
  Provider -> Core -> Tool -> Host -> Session path; replay/CAS; paused Goal isolation;
  JSONL cold restore; live mux/history seed and no unrelated projection churn.
- UI: strict source types, unchanged legacy Goal behaviors, malformed wire data,
  ordering/counts and escaped titles; Chromium/WebKit disclosure and narrow layout.
- Rust compilation/tests run only on WZU_Server after source sync; no local Rust
  compilation. Browser fixtures are synthetic component/production-artifact tests,
  not a claim of real paid-model task quality or deployment into the running app.
