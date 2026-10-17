# Live Swarm monitor and 12-worker real-model acceptance

## Implemented

The selected Swarm workspace now keeps a compact agent monitor above the native
coordinator chat. Each linked worker has a name-sorted card showing observed
runtime activity, current task title, accepted/rejected counts, and pending inbox
count. Cards open the existing worker conversation. This no longer depends on
opening the narrow right rail or selecting its Team tab.

Read-only inspection refreshes every 1.5 seconds during active/assigned work and
5 seconds when idle. It skips hidden documents, stops on unmount, aborts stale
owner/team reads, and never invokes a provider. A separate live snapshot avoids
resetting task drafts, pagination errors, or uncertain-write guards. No new RPC,
Rust/runtime behavior, default worker count, or ordinary-chat polling was added.

## Frontend validation

- Repository UI build and deterministic build check: 60 modules / 190 assets.
- Contract/navigation/type-policy tests: 48 passed, including compact worker fact
  decoding and malformed/crossed identities. No `any` or type assertions.
- Actual source component with synthetic RPC: Chromium and WebKit passed. Twelve
  cards are visible in the DOM; status changes without focus/manual refresh.
  Lost task-write acknowledgement remains guarded through a polling interval;
  closing Swarm stops reads. Existing mobile/layout, scope, pagination, draft,
  assignment, safe-text and pause semantics tests remain green.
- Architecture: 41 crates / 9 processors; 27 architecture unit tests passed.
- `git diff --check` passed.

Fixture browser tests are not real-model evidence. The following test is separate.

## Real V100 / DeepSeek acceptance

The already running isolated V100 Host served the new UI through the existing
local forward at http://127.0.0.1:3293/. Only its generated static assets changed;
the Host was not restarted and the installed desktop app was not replaced.
Existing test/user teams were left untouched. A separate root conversation named
`Swarm · 12-agent live test` was created for this test.

- Provider/model: `deepseek` / `deepseek-flash`, existing remote credential only.
- The coordinator started exactly 12 workers, Range 01 through Range 12.
- Human test driver created the isolated root/team, linked those workers, and
  enabled dispatch after the board was prepared. It did not add, assign, send,
  or review work. Worker creation/linking is not claimed to be an autonomous
  production onboarding flow.
- Coordinator created 12 independent integer-range tasks and one checksum task
  depending on all 12 exact task IDs, then reviewed the native results.
- All 13 task outcomes were independently verified from the exact assignment-
  consuming durable turns. Each delivery was consumed once. The checksum claim
  followed all 12 accepted Control events. Answer: `CHECKSUM=7260`.
- Dispatch-to-final-idle stage: 75.6 seconds. Root: 27 turns / 61 steps.
- Two-second status sampling saw 11 workers marked Running plus one Queued.
  Journal timestamp intervals overlapped for at most four assignment turns.
  These are different observations; neither establishes 12 simultaneous provider
  requests or an inference-concurrency benchmark.
- Test guardrails: 12 workers, 13 tasks, 600 seconds, 60 coordinator turns.
  Successful completion ended the test driver; no recurring model loop remains.
- Final real Web UI showed 12 idle cards, Range 01 with two accepted tasks,
  the other 11 with one each, and all 13 completed tasks in All tasks. The
  expanded checksum showed its real dependencies/result. Live UI was verified
  through the browser accessibility surface. Screenshot capture was unavailable
  because the in-app browser reported a zero-width capture surface; no screenshot
  or image proof is claimed.

`acceptance.json` contains public worker answers, delivery/turn identities,
Control ordering, coordinator tool counts and journal hashes. Raw journals and
credentials remain on the server. `verify.py RUN_DIRECTORY` regenerates the
record from the isolated run. `test-state.json`, `control-observations.jsonl` and
`reported-usage.json` retain the bounded test state and measured observations.
Driver scripts are operational records and use the existing untracked local RPC
helper `/tmp/swarm-live-rpc.py`; they are not portable CI tests.

This validates a bounded arithmetic orchestration and visibility case, not coding
quality, broad autonomy, hundreds of workers, or a peak-memory benchmark. No
commit, push, PR, merge, release, installed-app replacement, or normal-chat
restart was performed for this change.
