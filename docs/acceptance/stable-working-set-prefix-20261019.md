# Stable working-set continuation

## Problem

Once working-set pressure was activated, each subsequent step selected retired
history again from the full transcript. Additional retirement changed the early
history-reference message and invalidated reusable provider prefixes, even when
the currently projected request was well below its admission threshold.

## Change

- Freeze retired message ranges between actual pressure decisions. Reconstruct
  the same history reference from those immutable retired transactions; append
  new work without moving the earlier boundary.
- Rebalance only after counting the current projected request against the existing
  pressure threshold. Preserve the existing lower target, complete-wire admission,
  protected user/system nodes, whole tool transactions, unknown-outcome guards,
  and compaction fallback. Never reintroduce earlier retired results on rebalance.
- Persist a versioned, body-free selection in existing request-header options:
  ranges, covered-prefix length and SHA-256 of messages plus provenance. No RPC,
  event schema, new tool or external dependency is introduced.
- Cold continuation validates that fingerprint before reusing the selection.
  Changed instructions, rollback/compaction or provenance invalidate it. Missing
  or invalid optional metadata falls back to full input plus ordinary admission,
  not an unchecked request or permanent conversation failure.
- An admitted compaction candidate carries its exact retirement selection into
  the committed live context, preserving candidate/recount identity.

## Acceptance

All Rust commands run remotely on WZU_Server from an isolated synchronized
checkout. No installed application, real conversation or running agent is mutated.

- Positive control: run the new integration tests with the baseline engine restored in a separate remote checkout. Both fail on history-reference changes; both pass with the candidate engine. This is a deterministic old/new runtime comparison, not model self-evaluation.
- Context tests compare frozen reuse with the old per-step projection, verify
  byte-identical early messages across appends, permit a deliberate later
  reduction, and reject partial/protected/unknown/out-of-bounds ranges.
- Core integration exercises repeated real tool rounds through the loop, then
  recreates a fresh store and Runner from serialized metadata-only journal events
  and sends `continue`. The first resumed request preserves the earlier prefix
  without first expanding and re-trimming the full transcript.
- A fresh-pressure integration verifies that subsequent reduction remains safe,
  does not resurrect old raw results, and never sends an oversized request.
- Existing compaction candidate/commit sequence and complete-request recount
  regressions remain unchanged.
- JSONL acceptance reopens a real metadata-only store twice and verifies that
  selection metadata survives while full request bodies remain absent.

This fixes avoidable working-set prefix churn; it does not guarantee a provider
cache hit. Model/tool/system changes, other deliberate context policies, and
provider cache eviction can still change reuse. No paid live provider A/B or
post-release cache-hit improvement is claimed by these deterministic tests.
