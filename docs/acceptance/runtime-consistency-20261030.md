# Host runtime convergence and broken-stderr repair

## Scope

- Non-panicking console diagnostics, with closed-category, rotating Host-owned
  failure records independent of desktop pipe lifetime. Diagnostic sink failures
  are observable in `host.describe`; metadata export includes the failure stream.
- Driver ownership uses process-local Arc epochs. Stale callbacks cannot clear a
  successor. Reads repair closed control receivers by subscribing to existing
  work, never replaying prompts or tools; only proved idle work clears `running`.
  Unknown activity fails closed and cannot acknowledge a successful stop.
- Ordered detachable control futures do not own the event cursor. Ack waiting is
  bounded, and controls bound to an old turn cannot interrupt a successor.
- Input-scoped durable terminal reconciliation also runs while the Agent is busy.
  Background processes are not inferred to stop when a model turn ends.

## Regression coverage added

1. Actual task-monitor subprocess with its sole stderr reader closed: callback
   must still run; closed failure metadata must survive without panic payloads.
2. Pending control acknowledgement must not block checkpoints or terminal cleanup.
3. Completed durable session + dead driver: list read clears the stale running bit.
4. A stale failure callback cannot clear a newer epoch.
5. Active orphan observer reattachment + stop: one provider invocation and one
   user message only, with no replay. Stale scoped control is rejected.
6. Lost terminal notification while a successor keeps the Agent busy: the old
   observer settles from its own durable receipt, without waiting for global Idle.

## Validation status at draft creation

- Local `cargo fmt --all -- --check`, architecture/freeze check, 34 architecture
  mutation tests, and whitespace validation passed. No Rust compiled locally.
- V100 source synchronization did not complete after bounded default, IPv6,
  userspace Tailscale, rescue, configured jump and existing-session attempts.
- User explicitly authorized an unvalidated **draft PR** to use repository CI
  for remote Rust and native-platform validation. Rust tests, strict Clippy,
  compiler mutations and native gates are **pending**, not reported as passing.
- No merge, release, installed application replacement, Host restart or replay
  of the user's real tasks is part of this draft.
