# Swarm task board — first backend slice

This follow-up builds on PR #320 without changing that PR's branch. It adds a
shared durable task board and explicit task assignment through existing Agent
inboxes. It does not yet add model-facing task actions, automatic task picking,
a coordinator Goal, role-specific tool profiles or a task-board UI.

## Ownership and completion

A task has a stable identity, title, instructions, earlier task dependencies,
and one of these durable states:

- `pending`: unassigned; ready only when the team is active and every dependency
  is settled successfully.
- `assigned`: exactly one member owns it. `delivered` means inbox admission was
  acknowledged, not that a model started or completed the assignment.
- `settled`: retained result with worker, delivery identity, optional turn,
  outcome (`completed` or `failed`) and an owner-provided acceptance summary.

There is no destructive task deletion, claim expiry or automatic reassignment.
One worker can own one unfinished task in its team. Claims must reference an
idle, unpaused, reconciled, direct delegated member. Task dependencies can only
reference existing immutable task identities; cycles and duplicates are rejected.
Completed tasks are never claimed again. Failed dependencies do not unlock work.

Only the owning root conversation's trusted RPC client can add, assign or accept
work in this slice. This is the existing local Host ownership scope, not a new
remote tenant credential. Workers cannot use an owner ID to bypass this boundary
through a newly added model tool: no model tool is added here.

Successful acceptance must reference the exact settled worker turn that consumed
that task's stable delivery message. An unrelated prior answer, an idle worker,
a tool call or a finished turn without that claim cannot complete the task. An
observed pre-turn `AgentDelegationFailure` for that exact message can be recorded
as failed with `turn:null`. Open turns and unresolved tool outcomes prevent
acceptance. The Host verifies execution facts, not the semantic truth of a
summary: the coordinator/user still judges the substantive result and may reject
an attempt even when its model turn ended normally. This first slice correlates
acceptance to the turn consuming the assignment; task-aware multi-turn correction
and retry attempts are not implemented yet.

## Inbox and restart protocol

1. Append the claim and RPC receipt in one existing Control CAS batch.
2. Reconcile undelivered claims through the existing delegation listener.
3. Use the existing deduplicated Agent admission with a stable message ID,
   `source.kind=swarm-task`, and queue mode, never interrupt/steer.
4. Record a delivery marker in Control after inbox admission succeeds.

The same assignment text/fingerprint is reconstructed from immutable task input
and completed dependency result references. Dependency instructions and worker
transcripts are not copied into every task. A crash before inbox admission leaves
an undelivered claim. A crash after admission but before its marker retries the
same identity, including after consumption; it does not reexecute the assignment.

This is at-least-once delivery with deduplicated admission, not an exactly-once
guarantee for external effects. An interrupted or uncertain operation stays with
its worker under the existing recovery rules. No replacement worker is spawned.
Missing/deleted workers leave parked work for explicit reconciliation.

The team admission gate serializes pause/close against new deliveries, before
the short global Control gate. It is never held for a model turn. Pause blocks
new admissions but does not cancel already admitted work. Result acceptance can
still be recorded while paused. Closed teams remain immutable. Neither task
reads nor a team with no explicit claims invokes a model. User stops and ordinary
chat admission remain authoritative; internal task messages cannot resume a
stopped worker.

## RPC

Use the existing dynamic `/api` transport with endpoint `swarm/tasks`:

```json
{"ownerSessionId":"owner","command":{"action":"list","swarmId":"swarm-id"}}
```

Mutations:

- `add`: `swarmId`, `expectedRevision`, `title`, `instructions`, optional
  `dependencies` (task IDs). Returns the generated `taskId`.
- `claim`: `swarmId`, `expectedRevision`, `taskId`, `workerSessionId`.
  Returns stable `deliveryId`; success acknowledges the durable claim, not delivery.
- `settle`: `swarmId`, `expectedRevision`, `taskId`, `messageId` (the delivery ID),
  `turn` (integer or null for recorded pre-turn failure), `outcome`, `summary`.

Every mutation uses the existing RPC-ID/fingerprint receipt protocol. Replay the
same ID and payload after an uncertain response; do not silently create a new
claim. The per-team revision may advance when an outbox delivery is recorded, so
read the latest board before a new mutation. List returns `revision`, `hasMore`, `nextCursor` and rows
containing `task` and a derived `ready` flag. Settled work is hidden by default,
not deleted: use `includeSettled:true` for history. `limit` defaults to 50 (valid
range 1–200) and `afterTaskId` continues the ordered page. This bounds response
size, not the number of tasks or mission rounds. Old Swarm snapshots lacking `tasks`
decode with an empty map. Session/inbox formats are unchanged; older binaries
cannot necessarily read new Control event variants.

## Acceptance boundary

Deterministic tests use fake providers, real durable Agent loops, real JSONL
stores and cold Host reconstruction. They verify exclusive claims, exact-turn
acceptance, dependency unlocking, retained results, foreign-owner rejection,
paused recovery, delivery-marker acknowledgement loss and unchanged unrelated
chat journals. Fault injection is not a real OS process-kill test. Do not report
real-model orchestration, role specialization, UI interaction or cloud takeover
as complete based on these backend tests.

All Rust validation must run on WZU_Server after synchronizing source. Run the
architecture check with the follow-up base commit `8a1fe4b2` until this stacked
branch is rebased onto the merged parent; regenerate its content-bound record
after rebase. No foundation gate is weakened.
