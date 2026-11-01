# Opt-in automatic Swarm dispatch

## Ownership

The coordinator remains responsible for decomposition, routing and semantic review. The runtime only claims a ready task for an explicitly eligible, idle linked worker, then uses the existing task outbox and durable Agent inbox. It does not create a second model loop, create workers, replay tools, accept results or infer specialist roles.

Automatic dispatch requires two explicit inputs:

- A client enables `swarm/manage` → `set_dispatch` with `swarmId`, `expectedRevision`, and `enabled: true`.
- A task has a nonempty `eligibleWorkerSessionIds` list. The Agent tool uses the equivalent `eligible_worker_session_ids` add-only field. Each entry must be a distinct existing team member; maximum 64. Empty or missing means manual-only, not “any worker.”

The model-facing Agent command cannot enable dispatch. Existing explicit assignment remains available as a coordinator/user override. Routing is immutable in this slice; a manual assignment can handle work that needs a different worker.

## Persistence and compatibility

`SwarmSnapshot.autoDispatch` defaults to `false`. A revision-checked incremental `dispatch_changed` Control event persists explicit changes using existing durable mutation receipts. Missing task eligibility defaults to an empty list. Existing teams and old tasks never start automatic work merely because the application is upgraded.

Disabling prevents new automatic claims. It does not cancel a committed claim or stop already admitted work. Team pause parks new claims and outstanding deliveries; already admitted work follows the existing runtime. Closing the team prevents further dispatch. A stopped coordinator or worker remains stopped across restart. Hiding the Swarm page is presentation only, not a stop command.

## Scheduling and safety

The existing one-second task outbox listener also reconciles automatic claims. Disabled teams have no journal reads or model requests from this path. Each enabled team pass admits at most eight claims. Ready tasks are considered in durable task-ID order; their eligible workers are tried in the specified order. This is deterministic routing, not skill matching or a general fair scheduler.

A worker must be present, owned by this root, idle, unpaused, without queued messages, questions, approvals, open turns or unresolved tool outcomes, and without another unfinished claim. The shared service rechecks policy and the expected board revision under the team admission gate. Worker admission serializes the idle check with native queue/stop operations.

Automatic claim and delivery acquire the existing lineage fence before multiple parent/child admission lanes, matching native deletion/revert ordering. They do not hold the global Control gate while inspecting journals or executing models. Coordinator stop is ordered with claim/delivery admission. A claim committed just before stop remains durable and parked; it is not reassigned.

The stable claim message identity is reused after a crash or lost acknowledgement. No automatic retry, reassignment, worker replacement or uncertain-effect recovery is introduced. A normal worker turn ending does not release ownership: coordinator review of the exact assignment execution is still required. Only accepted completion unlocks dependent tasks. Rejection/failure keeps dependents blocked.

The existing native worker-settlement inbox notifies the coordinator. Automatic dispatch does not force a stopped/blocked coordinator to resume. It cannot make the model review correctly; that remains a model-quality concern distinct from orchestration correctness.

## UI

The Tasks rail has an Auto-dispatch checkbox, initially off, and a compact status line. Add task exposes Automatic routing as an optional disclosure listing linked workers. Existing task and team refresh behavior is unchanged: snapshots refresh after local writes, on focus/visibility, or by explicit refresh. This slice does not introduce live board event subscription or hidden UI polling; background mutations can require a refresh to display.

Ordinary chat navigation and drafts remain mounted. UI removal or disabling Swarm does not change the normal Agent tool schema or native session runtime.

## Acceptance boundary

Remote Rust tests use real Host services, durable Control/session stores, and Agent inboxes with a deterministic provider. They cover opt-in, explicit routing, strict replay, concurrent/manual claims, worker reservation pending review, pause/stop, incomplete turns, lineage admission, cold restart, and the actual listener advancing dependent work after acceptance. UI tests use the production component/client with an explicitly synthetic RPC fixture in Chromium and WebKit.

This does not claim paid-provider quality, native release validation, deployment, or automatic worker creation. See the dated acceptance evidence for executed commands and exact source hashes.
