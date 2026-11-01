# Durable Swarm lifecycle: phase one

## Boundary

A Swarm is persistent control-plane metadata owned by an existing root chat.
It is not a Goal, progress checklist, new Agent, work queue or scheduler.
The existing delegated sessions retain their identity, model settings, permissions,
conversation, durable inbox, execution leases and recovery rules.

This phase adds no model-facing tool actions, slash commands, UI, autonomous
continuations, peer messages, cloud ownership transfer or new dependencies.
Ordinary chat prompts, tool registration and execution paths are unchanged.

## Persistence and lifecycle

`xharness-control` stores incremental `swarm_changed` events in its existing
CAS/flush/receipt protocol. Creation records a stable Swarm ID, owner session,
objective and the owner's canonical cwd. Workspace is metadata, not an arbitrary
execution directory supplied by the client. Membership stores existing delegated
session IDs and their original journaled assignments. Neither messages nor
worker transcripts are copied into the Control log.

Status is `active`, `paused` or terminal `closed`. It is independent of whether
any member is running. A paused/closed team rejects new membership. Transitioning
team metadata **does not stop or resume existing conversations**, cancel tools,
or arm a Goal. Use the existing worker/session controls for those operations.
Future automatic team dispatch must enforce this lifecycle before admission.
There is no autonomous dispatch in this phase.

Each mutation of an existing team requires its current per-Swarm revision. The generic RPC receipt
is committed with the event, making a lost-response retry return the original
response. Reusing a mutation ID with another payload fails. A worker can belong
to only one Swarm; this phase has no detach/reassign or objective editing.
Only an existing root session can own a Swarm. A member must be a direct,
journal-proven delegated child, not an ordinary chat or unrelated worker.

Ownership here is the same authenticated local-client session scoping used by
existing Host RPC. An owner ID is not a remote tenant credential. Do not expose
this endpoint directly to model-supplied RPC payloads or unauthenticated clients.

## Additive RPC

Endpoint: `swarm/manage`, using the existing dynamic RPC transport. The frozen
unary method catalogue and envelopes do not change. Requests are strict typed
objects; unknown fields/actions are rejected.

```json
{"ownerSessionId":"root-chat","command":{"action":"create","objective":"Maintain the parser"}}
```

Mutation response: `{"swarmId":"swarm-...","revision":1}`. Inspect also returns
the current revision.
Use a fresh RPC ID for a new operation and the same ID/payload for a retry.

Commands:

- `list`: returns `swarms` owned by this root session.
- `inspect` with `swarmId`: returns `swarm` and read-only `workers` observations.
- `attach_member` with `swarmId`, `expectedRevision`, `childSessionId`: associates
  an already-created worker; it does not assign new work or submit any prompt.
- `set_status` with `swarmId`, `expectedRevision`, `status`: lifecycle metadata only.

Start work using the existing `agent.start` action, then attach its returned
`agent_id`. This deliberate two-operation boundary cannot create an orphaned
running worker via Swarm: a crash before attachment leaves an ordinary delegated
worker under its original owner. Retry attachment with its receipt ID.

`inspect` and `list` read journals/control state without hydrating actors. They
must not trigger queued prompts, model requests, history repair or tool retries.
Worker observations are timestamp-free inspection cuts, not an atomic team-wide
execution snapshot. They contain journal revision, last turn-end reason and
unresolved tool-call IDs, not a second mutable task/result state machine.
An idle worker or completed turn is not evidence of objective acceptance.
Deleted/missing workers are reported as unavailable; no replacement is spawned.
Owner deletion retains metadata but makes the owner-scoped API unavailable.

## Restart and interrupted work

Control restoration reconstructs the team and membership using the existing
Host startup path. Reading a Swarm never adds execution or recovery behavior.
The native product's existing `PauseIncompleteTools` policy keeps interrupted,
non-authoritative tool outcomes parked. Swarm inspection reports
`needs_reconciliation`; it does not pretend the tool failed or did not execute.
Explicit continuation through existing session controls uses the existing
outcome-unknown recovery and external-state verification requirements.

Embedded callers choosing `ResumeIncompleteTools` retain their existing policy;
this metadata feature does not silently change it. Team `active` is not authority
to resume an interrupted member or override a user stop.

Old logs without Swarm events restore with an empty team map. Reading new events
with an older binary is **not** guaranteed: preserve the Control log before a
binary downgrade. There is no rewrite or migration of existing chat files.

## Acceptance

Run all Rust validation remotely after synchronizing the current source:

```sh
cargo test --locked -p xharness-control -p xharness-agent
cargo test --locked -p xharness-host swarm -- --nocapture
cargo test --locked -p xharness-host
cargo clippy --locked -p xharness-control -p xharness-host --all-targets -- -D warnings
```

The new deterministic integration tests use the real durable Agent runtime,
a fake provider, independent JSONL store instances and a cold reconstructed Host.
They cover settled worker/result recovery, all lifecycle states, exact receipt
replay/conflict (including a lost flush acknowledgement), stale/concurrent revisions, owner/member scoping, unchanged
normal chat journals and a usable ordinary prompt after restart. The crash-cut
fixture simulates an external effect followed by process loss before ToolResult;
inspection leaves it untouched and explicit continuation records outcome unknown.
This is not a live-provider quality test, an OS-level kill test, a cloud failover
test, a UI test or proof of autonomous team scheduling.
