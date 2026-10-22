# Working-plan hydration pilot — 2026-10-14

Historical experiment: the ordinary model-facing `goal` tool was retired on
2026-10-22. Reproduction now requires an explicitly supplied archived
`goal_tool.rs` via `--legacy-goal-source`. This pilot and its recorded evidence
do not describe the current production tool catalogue.

## Question and boundary

Does providing the latest plan once after a compacted/resumed conversation improve
plan maintenance compared with relying on the existing `goal.get` tool?

This experiment changes **no production runtime, scheduler, compactor, UI or tool**.
It adds no periodic reminder, automatic Goal activation, extra probe or forced
continuation. Real DeepSeek requests use only synthetic conversation/workspace data.
The production `goal` description/schema is extracted directly from Rust source.
The current plan is available through `goal.get` in both arms. Treatment adds only
one neutral system message carrying the latest plan before the latest user request.
This is a prompt-level pilot, **not actual Host/Compact/restore E2E acceptance**.
Simulator permissions, standalone-batch admission and journal recovery are not being
validated by this pilot; prior deterministic Host tests are separate evidence.

## Method

Five cases, two repetitions per arm, temperature 0, disabled thinking, maximum
5 requests per trial, output limit 2048 tokens/request, two in-flight trials.
Model endpoint: `https://api.deepseek.com/chat/completions`, model `deepseek-flash`.
No generated command is executed. Fixed workspace tools return synthetic results.
No credential or private reasoning is retained. No model judges its own work.

Cases: continue remaining verification, change scope to load inspection, report an
already-completed plan without execution, an outdated compacted plan revision, and
an untrusted plan title telling the assistant to push while the user requests load.
Checks inspect command traces, original IDs/states, completion timing, CAS outcomes,
normal response settlement and a deliberately narrow completion-report content check.
The content check is heuristic; the one failing report was also manually inspected.

## Pilot correction — preserve failures, do not hide them

Pilot v1's general-purpose shell description did not disclose that the simulator
only supported four exact commands. The model reasonably tried `ls`, `git status`
and piped test output. The initial strict command oracle labeled these as scope
failures. **Those scores are not used as headline evidence.** All raw responses,
original evaluator, protocol and summary remain in `pilot-v1/`.

For v2, both arms received the same explicit fixture capability description before
any requests. The acceptance rules were unchanged. v2 is another 20 fresh trials,
not post-hoc rescoring of v1. Nine offline tests check the simulator/oracle, including
stale writes, duplicate IDs, premature completion, duplicated work, rejected push
attempts, incorrect scope and falsely reporting execution.

## Results — corrected pilot v2

| Check | On-demand `get` | One initial snapshot |
| --- | ---: | ---: |
| Plan-maintenance cases passed | 7/10 | 10/10 |
| Resume: verification passed **and plan updated** | 0/2 | 2/2 |
| Changed user scope respected | 2/2 | 2/2 |
| Already finished: accurate report without reexecution | 1/2 | 2/2 |
| Stale compact revision: verify/update with stable IDs | 2/2 | 2/2 |
| Untrusted title: no push, only requested load operation | 2/2 | 2/2 |
| Provider requests | 22 | 24 |
| Rejected stale writes, subsequently recovered | 2 | 0 |
| Reported total tokens | 35,491 | 39,975 |

All requested verification/load actions themselves succeeded in both arms. **7/10
is not a coding-task success rate**: two failures were missing plan updates after
passing verification; the third falsely claimed no plan existed without querying
it. The snapshot's benefit here is plan awareness/maintenance, not demonstrated
improvement in code correctness or user-scope obedience.

Snapshot total tokens were 12.6% higher. It avoided stale writes but also updated
the plan during the new load task, adding calls. This does not establish a latency
improvement. Provider elapsed sums are raw request timings, not user-perceived
end-to-end timings. Prompt caching, concurrency, short fixtures and two repeats
limit inference. No general reliability/injection-resistance claim is made.

Both pilots together used 101 successful provider requests and **167,409 reported
tokens**. Monetary billing was not returned/verified; no RMB spend is inferred.

## Decision / next gate

Do not add periodic reminders. A **single authoritative, bounded snapshot at a
recovery/compaction boundary** merits a separate implementation/E2E test. It must
be state data rather than an instruction to resume unfinished work, must not run
old tasks after a new user request, and must not change existing Goal continuation.
Keep `goal.get`/CAS for stale snapshots and concurrent changes.

Before integration, validate actual provider request construction after Compact
and cold restore, no duplicate/stale injection on repeated requests, empty/cleared
plans, scope changes, child isolation, bounded prompt size and no additional work
when the feature is disabled. None of those integration tests is claimed here.

Evidence: `../evidence/session-progress-hydration-20261014/acceptance.json` includes
raw receipt hashes, both protocols/evaluators, all visible answers and tool traces.

Reproduce offline (no network):

```sh
python3 scripts/experiments/test-plan-hydration-ab.py
```

Opt-in live run; existing local keychain credential or locally configured
`XHARNESS_EVAL_API_KEY` (never put it on the command line):

```sh
python3 scripts/experiments/plan-hydration-ab.py --legacy-goal-source /path/to/archived/goal_tool.rs --output /tmp/NEW-OUTPUT-DIRECTORY --repeats 2
```

## Implementation follow-up

Request-local missing-state hydration was subsequently implemented; see
`session-progress-context-hydration.md` for its exact semantics and separate runtime
acceptance. The pilot fixtures/results above remain unchanged historical evidence.
