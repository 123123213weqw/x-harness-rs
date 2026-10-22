# Working-plan context hydration

Implemented 2026-10-14 after the prompt-level DeepSeek A/B pilot. This is an
additive context projection, not a reminder scheduler or another agent loop.

As of 2026-10-22, ordinary Host turns no longer register the multi-action `goal`
tool. The existing capability gate therefore disables this projection there;
it must not suggest a retired `goal.get` operation. Persisted plan events,
RPC/CAS and UI remain readable. This change does not introduce a replacement
plan tool or rewrite historical plans. The contract below describes the retained
capability-gated projection, not an always-on current Host feature.

## Integration contract

- Use the latest validated `session/plan-updated` from the **current journal**.
  Reuse the journal load already needed for context provenance; no new read RPC,
  capability probe, model call, worker or timer is added.
- A successful, untruncated visible result of an actual `goal.get` or
  `goal.update_plan` call containing the exact latest plan makes a snapshot
  unnecessary. Link results by the provider call ID; arbitrary user/assistant
  JSON and other tools' results do not qualify. Stale or truncated receipts do
  not hide newer state.
- If the current state is absent after journal replay, Compact or context-policy
  pruning, add **one bounded snapshot** to the disposable provider context.
  No plan, a cleared plan or no registered `goal` tool means no snapshot.
- The snapshot is **user-role state data**, never a new System section. Insert
  before the latest user message, preserving the immutable system prefix and
  assistant/tool pairs. Plan titles are explicitly untrusted data. Pending items
  are not a request to continue; the current user request determines scope.
- Snapshot bytes are capped at 4096. Larger plans use exact revision/total/completed
  counts and `details_omitted:true`, referring to the existing `goal.get` action
  for details. Do not truncate a list and falsely present it as complete.
- Do not change the runner transcript or durable user messages. No synthetic
  history, new event, protocol change, Goal creation or scheduling is introduced.
  Request audit/token accounting still see the exact actual outbound snapshot.
- The snapshot projection is pure: candidate compaction admission, actual calls
  and retries use the same bytes for the same journal/context. An attempted
  budget check never consumes a one-shot flag. The snapshot participates in the
  existing hard input budget; it is not exempt from admission.

### What “once” means for stateless providers

There is at most one reconstructed snapshot in a request, not an accumulating
reminder every N steps. A stateless provider may receive that same snapshot on
later requests until a current receipt becomes visible; otherwise the state would
vanish from its next request. New plan data replaces its request-local representation
and a clear removes it. No timestamps/counters or periodic messages are produced.

A registered `goal` tool is the capability gate. Removing/disabling that tool leaves
provider messages unchanged. Ordinary completed turns can still end while the plan
contains pending items. Existing Goal completion, scheduling, retry and cancellation
rules are unchanged.

## Acceptance on WZU_Server

All Rust compilation/checks ran remotely after source sync. No local Rust compile,
app replacement, service restart, Git push, PR, merge or release was performed.

New coverage (8 tests; several parameterize multiple cases):

1. Missing/cleared/disabled plans and exact current get/update receipts.
2. Stale, forged, failed, truncated and other-tool receipts.
3. Stable bounded JSON, escaped untrusted title, immutable system, latest user
   placement and a 128-item large-plan metadata fallback.
4. Actual LoopEngine journal replay across multiple steps and a retry: one stable
   snapshot/request, no added provider probe/turn and no history pollution.
5. Real tool -> journal append -> CAS adoption -> visible receipt; clearing removes
   old state; a policy hiding the receipt restores revision 2 instead of revision 1.
6. Missing/empty/unregistered/another-session plans leave the request unchanged.
7. Actual Compact candidate admission and live request contain identical snapshot
   bytes; summary input and durable history exclude the transient snapshot.
8. Fresh JSONL store + Host/runtime cold restore: no call on restore, one explicitly
   requested reporting turn, visible pending plan, no implicit Goal/extra work.

Full Core suite: **47 unit + 148 loop integration tests passed**.
Host remainder: **308 passed, 6 existing ignored, 1 explicitly excluded**. The
excluded `first_request_rejections_are_observable_and_parent_driven_retry_reuses_child`
was already reproduced on the untouched base in an isolated target directory during
phase 1; it is not fixed or reclassified by this change. Therefore this report is
**not a claim that all repository CI is green**. Focused working-plan Host suite:
7/7 passed. Clippy Core/Host all targets with `-D warnings`, architecture boundary,
formatting and whitespace checks passed.

These are actual runtime-path tests with deterministic providers, not another live
paid-model E2E run. The earlier paid-model A/B is separate evidence; it used a System
snapshot in its prompt-level fixture. Production uses user-role state to retain the
existing single immutable System contract, and no claim of identical model behavior
between those prompt forms is made. Broad task quality/multi-model testing is not
established by these structural tests.

Evidence: `../evidence/session-progress-context-hydration-20261014.json`.
