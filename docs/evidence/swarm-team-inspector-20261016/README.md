# Right-hand Swarm team inspector

Frontend-only extension of the previously validated live monitor. The right rail
opens on Team and shows the objective, coordinator, lifecycle/dispatch state,
worker count, and accepted/total progress. Worker rows expand into role, runtime
state, delivery, inbox, blockers, latest recorded public activity, and bounded
result previews. Monitor cards select the inspector; opening a conversation is
an explicit separate button. The coordinator chat remains mounted.

Data provenance:

- Overview/counts/results: existing `swarm/manage inspect` durable task snapshot.
- Activity/blockers: existing worker observations, never inferred task success.
- Last used model/public tail: existing parent-addressed `subagent.history`, only
  for the expanded worker with `maxMessages: 1`. Model route comes from reported
  throughput metadata; a configured route without a request is not guessed.
- No provider probes, model prompts, worker creation, scheduling changes, Rust
  changes, RPC/schema additions, or installed-app replacement.
- Preview text is bounded to 2,000 characters, rendered as text. Reasoning parts
  are not decoded into inspector state. Full histories are not retained there.
- Canceled/stale reads are discarded on worker/owner/team changes. Detail errors
  retain same-worker stale data with an explicit label and read-only retry.

Validation results and real Web observation are recorded in acceptance.json.
This reuses the already completed 12-worker DeepSeek test for real data; it does
not claim another paid model run or additional orchestration acceptance.

Two real-data issues found during validation were corrected in this frontend
slice: first-time child inspection must derive its exact address from the healthy
parent catalog rather than requiring previous navigation; public history messages
use `data.message.content`, not a flattened `data.content`. Fixtures/regressions
now match those production contracts.

The real browser showed the team overview (12 workers, 13/13 accepted), role,
inbox, last turn and recorded checksum. After the final decoder correction, the
in-app browser webview stopped attaching. Final worker model/public-tail decoding
was therefore verified against the real V100 RPC with the compiled source client,
not claimed as final visual/browser acceptance. `live-rpc.json` records the actual
model route, activity, bounded public answer and unchanged model usage/turns.
The existing preview URL remains healthy; reopening the panel was queued. No
screenshot was captured. `verify-live-rpc.mjs` is a local operational record using
`/tmp/swarm-scale12-live.json` from this test, not a generic CI or model test.

Final local checks on the last source/build passed: 51 contract/navigation/type
checks, Chromium, WebKit, deterministic build, 27 architecture unit tests and
whitespace checks. During the last preview refresh the V100 connection also stopped
responding: the local-forward readiness read timed out after 5 seconds and a
bounded static-asset rsync timed out. The earlier corrected decoder deployment
and actual RPC check succeeded before this outage. No fallback Rust build or
installed-app change was attempted; final preview freshness remains unverified.
