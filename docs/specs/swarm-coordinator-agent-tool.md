# Swarm coordinator through the existing Agent tool

## Explicit session scope, not a global tool expansion

Creating a durable team through `/swarm` opts its root conversation into the
coordinator role. `AgentTool::for_session` adds `action=tasks`, the owned non-closed
team IDs and their command schema only to that coordinator's tool catalogue.
Ordinary conversations and delegated workers retain the original Agent tool
name, description and parameters. No additional tool is registered.

The session's saved team establishes scope, not the visibility of a panel.
Hiding the panel does not stop durable work. Closing every owned team removes
task commands on the next catalogue projection. A paused team still supports
reads and result acceptance, but cannot admit new work. A stopped owner loses
model-side board access until the existing user-resume mechanism resumes it.
The production Host-app factory uses the session-aware projection. The legacy
`for_host`/`spec` constructors remain unchanged for ordinary integrations.

A cached schema is not authorization: every invocation rechecks the caller's
root journal, team ownership, deletion, stop state and non-closed team scope.
Caller identity and invocation identity are Host-bound, not model arguments.
No provider availability probe or extra model request is made for projection.

## Model-facing commands

```json
{"action":"tasks","swarm_id":"saved-team-id","command":{"action":"list"}}
```

- `list`: optional `include_settled`, `after_task_id`, `limit` (default 20,
  maximum 50). Returns board revision and page metadata, task rows, linked worker
  observations, and `attempt` evidence for the exact consuming assignment.
- `add`: `expected_revision`, `title`, `instructions`, optional `dependencies`.
- `assign`: `expected_revision`, `task_id`, `worker_session_id` from the linked
  worker list. Creates one durable claim and queues inbox delivery. Do not also
  call `agent.start`/`send` for the same assignment: start already submits work.
- `review`: `expected_revision`, `task_id`, `execution_ref`, `outcome`
  (`completed` or `failed`) and `summary`. Copy `attempt.execution_ref`; do not
  supply a caller identity, delivery identity, arbitrary turn or approval flag.

Command variants are typed and reject cross-action fields, invalid limits,
missing references and malformed text before admission. Worker eligibility,
team lifecycle, dependency policy and exclusive ownership are checked by the
same backend used by the UI. A revision conflict requires a fresh read, not a
blind repeated mutation.

## Shared service and durable receipts

Both the existing `swarm/tasks` RPC and the Agent adapter call
`swarm_tasks/service.rs`. There is no loopback HTTP, generic RPC dispatcher in
the model interface or duplicated mutation policy. Existing UI RPC argument and
response shapes remain valid. Shared journal/worker observations moved out of
the RPC module into `swarm_tasks/access.rs`.

Model calls derive a namespaced receipt ID from the bound caller and durable tool
execution ID. The original reference-based review is fingerprinted before it is
resolved. Retrying that exact invocation after settlement or a cold restart
returns its original receipt; changing its payload is rejected. No second task,
claim, delivery message or acceptance record is minted by receipt replay.

## Evidence and acceptance

`swarm_tasks/evidence.rs` locates the journal turn containing the assignment's
exact delivery message, or a recorded failure for that message before a turn.
It does not substitute a worker's most recent, potentially unrelated result.
The returned reference deterministically binds worker, delivery, turn and
settlement sequence. It is a correlation handle, not an authorization secret.

Visible answer text is bounded to 4096 UTF-8 bytes and marked when truncated.
References do not include hidden reasoning. Review recomputes the reference,
then uses the shared acceptance checks: matching consumed assignment, actual
TurnEnd, successful execution for `completed`, and no open turn or unresolved
tool effect. A coordinator can reject a normally ended but insufficient result.
Only accepted completion unlocks dependent tasks. Semantic correctness still
requires actual evidence review; a reference is not proof of quality.

Existing child settlement notifications drive the coordinator's next normal
turn. Their durable payload and fingerprint are unchanged. There is no polling
loop added to the coordinator, automatic task picker, new worker creation path,
Goal activation, replacement worker for an unknown effect or tool-effect replay.
Task-aware multi-turn retry/reassignment and creation of idle workers remain
outside this first integration. It operates on already linked workers.

## Acceptance

Validate remotely on WZU_Server after syncing source. Tests cover normal/worker
schema equality, direct and cached-schema authorization, stop/pause boundaries,
ToolExecutor add/assign/review, shared UI state, exact evidence versus unrelated
turns, rejection semantics, duplicate receipts and cold restart. A scripted fake
provider also emits actual Agent tool calls through the existing durable model
loop and checks ordinary model requests receive no Swarm commands or prompt text.
This deterministic acceptance is not a real commercial-provider or native
Windows/macOS release test. Automatic pickup remains disabled.
