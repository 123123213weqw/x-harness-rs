# Multi-turn tool-result coding ablation

Follow-up to the first projection experiment. This run removes its main validity
limitations: model replies and tool results really enter the append-only JSONL
journal; a production `LoopEngine` drives the real OpenAI-compatible DeepSeek
adapter and `ToolExecutor`; the model actually reads, writes and tests Python
source in a new remote directory. Final prose/JSON style is **not** the score.

## Frozen matrix

- Four generated project families: duration/retry configuration, billing,
  pagination/cursors, and record normalization/deduplication/aggregation.
- Each project has three actual continuation turns in the **same journal**.
  Stage 1 repairs `app.py`; stage 2 implements `utils.py`; stage 3 integrates a
  new feature while retaining all earlier behavior.
- Stage 1 exposes an archived contract document (22–65 KiB). It is removed from
  the current filesystem before stage 2. Its original tool result remains in
  immutable session evidence. New stages depend on exact earlier constants.
- Tests and stages cannot be edited by model tools. Public test output is long,
  with authoritative process exit/source-hash receipts. Hidden assertion suites
  enter only after each model turn, never in its prompt, read allowlist or files.
- Each family has normal service, one transient history failure, and persistent
  history-service outage cases. All strategies see matched fixtures and fault
  conditions. Fault injection starts only at stage 2; original journal evidence
  is not deleted. An outage result is **stress evidence**, not a production rate.
- Twelve cases × six strategies = 72 sessions, 216 continuation turns. Randomized
  trial order; fixed official DeepSeek `deepseek-flash`, thinking enabled/high,
  temperature 0.2, 16384 output reserve. No whole-session compaction or working-set
  retirement: the independent variable remains tool-body projection/recovery.

## Strategies

1. `full`: no tool-body clipping; same completed-turn reasoning policy as other
   arms (not an unrelated extra-reasoning advantage).
2. `current`: unchanged production default context policy.
3. `typed_all`: always eligible for a short excerpt, pin typed status/error/path/
   receipt/source SHA and archive handle. Already-bounded history pages are not
   recursively clipped. Missing source handle fails closed to the full result.
4. `typed_fresh`: same, but keep the latest unconsumed batch within the normal
   per-result execution limit.
5. `typed_pressure`: same fresh pin; activate clipping only above an experimental
   65536 UTF-8 message-content-byte threshold. This is a **soft experimental
   projection trigger**, not native token counting or a replacement admission
   rule. Hard request admission remains the separate normal token guard.
6. `typed_recover`: same fresh pin; if history fails, promote original tool bodies
   already eligible in the current source surface for the remainder of this
   turn. Do not cross sessions, invent receipts, rerun effects or bypass access
   restrictions. This coarse recovery is an experimental arm, not shipped code.

## Objective scoring

Primary session success requires **all three stages** to:

- pass actual hidden assertions against the saved code (including previous
  stages' regression checks);
- finish the real engine turn successfully;
- have a successful **actual public test run for the final source hash**, not an
  old green log or an unverified assistant claim.

Code correctness, final-stage recovery, test-proof failures, generation counts,
actual normalized upstream input/cache/output usage, history errors/fault
activation, and total latency are reported separately and by fault stratum.
Failure cases are retained. A 32-step/900-second turn bound prevents runaway
experiments and is identical across arms; hitting it is failure, not exclusion.
The templates and golden implementations have independent positive/negative
controls before live model calls. The schema, fixtures and source hashes are
frozen in `protocol.json` before the scored matrix.

## Execution and limits

All Rust compilation/tests/Clippy run on `WZU_Server` after filtered rsync to
`~/codex-build/x-harness-rs/`. The official API key travels once per job through
verified encrypted SSH stdin and provider memory: not argv, files, logs, child
environment or source. The workspace is an isolated disposable **directory**,
not a claim of a new OS security sandbox. Model tools expose no general shell.

Run the fixture validator with Python, then remotely build/test/lint
`xharness-host-app --example tool_result_coding_eval`. From the orchestrator:

```sh
python3 experiments/tool-result-coding-ablation/run.py --output /absolute/output/matrix --prepare-only
python3 experiments/tool-result-coding-ablation/run.py --output /absolute/output/matrix
```

This is still a small set of generated projects, not edits to a user's actual
repository, real historical private sessions, desktop acceptance or a measured
production success rate. Fault cases must not be pooled into an implied field
failure probability. Small paired differences are not proof of equivalence.
During the scored runs, no production setting/policy was changed and no PR was
merged or version released. Committing these opt-in examples does not enable
their experimental strategies in production.

## Completed 2026-10-31: first coding matrix

All 72 sessions / 216 turns completed, with 5,616 hidden-assertion executions and
1,552 completed real provider streams. No provider-error/pending ledger rows.
Each success below requires **all three** stages' code and fresh test proof.

| Strategy | All stages verified | Normal | One transient failure | Persistent history-channel outage | Mean total input/session |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full observations | 12/12 | 4/4 | 4/4 | 4/4 | 254,093 |
| Current production projection | 8/12 | 4/4 | 4/4 | 0/4 | 215,721 |
| Typed short projection, all batches | 8/12 | 4/4 | 4/4 | 0/4 | 170,865 |
| Typed short projection, fresh batch pinned | 8/12 | 4/4 | 4/4 | 0/4 | 217,873 |
| Fresh pin + volume-triggered projection | 10/12 | 4/4 | 4/4 | 2/4 | 205,436 |
| Fresh pin + whole-source promotion after failure | 12/12 | 4/4 | 4/4 | 4/4 | 234,448 |

The injected outage is deliberately severe and overrepresented. Do **not**
quote 8/12 as a measured production success rate. Failure tokens remain in the
cost totals: early failure is not an efficiency improvement. Success-only paired
costs are reported separately in the JSON receipts. Whole-source recovery used
7.7% fewer total input tokens than full in this cohort, but mean session latency
increased from 39.3 to 49.2 seconds. Recovery was possible because original
storage remained healthy and the complete surface still fitted the hard guard.

### Independent-seed targeted-recovery follow-up

A second, separately fingerprinted runtime tests `typed_targeted` against a fresh
full-observation control on **12 new factual fixtures each** (24 sessions / 72
turns). It combines fresh pin, the same soft volume trigger, typed state and
bounded **targeted** backend recovery:

- The model-facing history route may fail; the coordinator still has a healthy,
  session-bound backend route. It executes the actual production history
  handler, including selector validation and evidence restrictions.
- A read recovers the bounded page. A search may prefetch at most two tool-result
  hit pages. Stored runtime evidence is capped at 12 KiB and reset each turn.
- Recovered data is a clearly marked transient runtime control observation,
  **not** a fabricated successful tool response, a new user task, authorization,
  or a modified System prompt. The original failed call remains failed.
- Original bodies remain clipped; the normal complete-request admission guard
  counts the added evidence before generation.
- Missing backend evidence remains an error. This is not recovery from a lost
  journal/archive, access denial, another session or corrupt originals.

| Follow-up strategy | All stages verified | Normal | Transient | Outage | Mean input/session |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full control (new seeds) | 12/12 | 4/4 | 4/4 | 4/4 | 280,368 |
| Volume trigger + bounded targeted recovery | **11/12** | 4/4 | 4/4 | **3/4** | 179,019 |

On the **11 jointly successful matched cases**, targeted recovery used **36.8%
less input**. Its full-cohort mean latency was 44.6 seconds vs control 40.4.
The failed case is retained, **not rerolled, removed or rescored**:
`pagination-outage`, stage 3. The retired target contract was recovered verbatim,
including its exact policy tag. The model interpreted its unspecified return
container as a tuple, put the policy tag in a module global, and rejected the
public test's dict requirement as a contract conflict. The contract said return
items, next_cursor and policy but did not explicitly spell out `dict`. Public
tests actually failed, no fresh passing test proof existed, and hidden tests
rejected the saved code. The final reply disclosed the test failure/conflict.
This is a **return-shape interpretation failure**, not evidence that the target
text disappeared. It still fails the declared task-completion criterion; the
small comparison cannot establish that clipping caused or did not cause it.

This is why the targeted optimization should **not replace a complete recovery
fallback** on the evidence of this experiment. A proposed next integration is
bounded evidence first, then explicit escalation/attention if verification fails
and whole-request admission permits more original evidence. That combined
escalation policy has **not** been production-integrated or proven here.

### Validation, retained failures and scope

Total scored coding evidence: **96 sessions, 288 continuation turns, 7,488 hidden
assertion executions, 1,951 completed actual provider streams**. Native artifacts
and local phase/usage receipts match. Both datasets/runners/runtime fingerprints
were frozen before their scored calls. Both golden fixture sets passed positive
and negative controls. Remote Rust tests passed 19 + 21 executions, strict
Clippy passed for both examples, and formatting/architecture checks passed.
The detailed aggregates are in `results-20261031.json` and the task outputs.

An initial targeted prototype attempted to append evidence to the assembled
System message. Unchanged Core correctly rejected it. That failed pilot remains
recorded separately; the fix uses a transient runtime-control observation,
**not** a weaker System-prompt guard. The scored targeted matrix uses only the
corrected frozen runtime.

The largest first-matrix actual input was 36,040 tokens under a configured
1,048,576-token window. This is **not a near-capacity/overflow experiment**, and
the 64-KiB soft trigger is not native token counting. No LLM-summary, recursive
compaction, working-set retirement, multimodal, desktop or private production
session acceptance is claimed. The scored runs left production
policy/configuration and installed apps unchanged; merge/release status in the
dated receipts is a historical experiment snapshot, not a current GitHub status.

## Offline CI

`python3 -B scripts/experiments/test-tool-result-ablation.py` validates both
fixture sets with actual Python execution, scorer positive/negative controls,
credential-free preparation and retained result aggregates. The existing
workspace `--all-targets` Rust gates compile, test and lint all three examples.
CI does not invoke the live experiment runners, SSH or a paid model endpoint.

For the follow-up, remotely build/test/lint the separate
`tool_result_coding_targeted` example, then run:

```sh
python3 experiments/tool-result-coding-ablation/run_targeted.py --output /absolute/output/targeted-matrix --prepare-only
python3 experiments/tool-result-coding-ablation/run_targeted.py --output /absolute/output/targeted-matrix
```
