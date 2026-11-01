# Tool-result projection ablation

This opt-in experiment uses official DeepSeek Chat Completions and synthetic
technical evidence. It does **not** modify installed Host settings, existing
conversations, production projection policies, or the compaction coordinator.

## Experimental unit and controls

- Eight task families: effective configuration, causal diagnostics, unknown
  execution effects, partial writes, paged historical search, stale revisions,
  executable billing-code repair, and two-result joins.
- Three independently generated seeds (24 matched cases); 12 fresh and 12 aged
  result batches. Evidence positions vary; pagination cases exceed 256 KiB.
- All seven variants get identical tasks, original evidence, model, thinking
  mode, temperature, and per-generation output allowance. Variant labels and
  golden answers are never exposed to the model.
- Exact JSON scoring, or 24 executable boundary tests for code repair. No LLM
  judge and no success based merely on a fluent continuation or compact size.
- Every model/tool response is retained in synthetic-only JSONL traces. Costs
  include **all** follow-up generations and reread context, not just the first
  projected prompt. Failed/malformed history calls are counted.
- The runner freezes fixture and script hashes before requests and randomizes
  the paired trial schedule. Resume never silently replaces completed results.
- Provider failures remain failures in the all-attempt denominator, with an
  explicit separate count. Setup/pilot failures are not pooled with the matrix.

## Variants

| Variant | Projection | History |
| --- | --- | --- |
| `full` | Complete observations | Real production tool |
| `current` | Production default: threshold 8192 characters; head 4096 / tail 1024; fresh batch retained within 256 KiB per result | Real production tool |
| `all8k` | Same production pruner; no fresh-batch exemption | Real production tool |
| `all2k` | Production configurable pruner: threshold 2048, head 1024 / tail 256; all batches eligible | Real production tool |
| `typed2k` | `all2k` plus a fixed, bounded metadata allowlist and original archive handle | Real production tool |
| `archive_only` | Body replaced by immutable archive handle; identity preserved | Real production tool |
| `typed2k_nohistory` | Same typed projection, but no history function is exposed (negative ablation) | Unavailable |

The typed projector is an **experimental** deterministic Python projection,
not an implementation already shipped in production. It never sees the current
question when selecting metadata. It retains status/exit/error/effect/receipt,
changed paths, revision, and pagination fields, not oracle-selected answers.

`tool_result_ablation_bridge.rs` imports the actual production history module,
uses `MemorySessionStore` archives and validated event transactions, executes
history through the real `ToolRegistry` / `ToolExecutor`, and calls the actual
`ToolResultPruningContextPolicy`. Thus search is literal and paged (four hits,
256 KiB scan, 128 events), reads use the real 2048-byte pages and 4096-byte output
envelope, and invalid/cross-session requests fail through production checks.
The immutable store is isolated and in memory on the remote build server.

## Run

Rust compilation is remote-only. First rsync the current repository to
`WZU_Server:~/codex-build/x-harness-rs/`, excluding `.git`, `target`,
`node_modules`, `.env*`, key and credential files. Then, on that server:

```sh
cd ~/codex-build/x-harness-rs
cargo build --locked -p xharness-host --example tool_result_ablation_bridge
```

On the orchestration machine:

```sh
python3 experiments/tool-result-ablation/validate.py --output /absolute/outputs/validation
python3 experiments/tool-result-ablation/run.py --output /absolute/outputs/matrix --prepare-only
python3 experiments/tool-result-ablation/run.py --output /absolute/outputs/matrix
```

The default credential is the existing authorized local DeepSeek key file. Its
value is read only into process memory and sent only to the official HTTPS API;
it is not passed to SSH, argv, artifacts, the bridge, or source control. No
credential access controls are changed. The default model is `deepseek-flash`,
thinking enabled / high, temperature 0.2, max output 16384 tokens. Trial bounds
(32 generations / 1200 seconds) prevent an uncontrolled experiment; they are
identical for all strategies and explicitly reported if reached. They do not
simulate a small context window or force a desired outcome.

## Interpretation limits

These are controlled synthetic continuation tasks, **not** a production success
rate. They isolate projection/retrieval effects, not LLM summary quality,
working-set retirement, actual desktop stability, arbitrary unseen tools,
multimodal observations, or reliable preservation of every semantic fact. The
Python model loop is not the full production `LoopEngine`. Small-sample ties
must not be described as proof of equivalence or universal safe deletion.

## Setup defects retained separately

The initial pilot sent synthetic assistant calls without the thinking-mode
`reasoning_content` replay field; the provider rejected them with HTTP 400.
The fixture bridge also initially used an invalid aged-step boundary and
interleaved parallel call/result audit events. These were corrected in the
experiment fixture **before** the scored matrix; production validators were
not weakened. Original failed setup logs are retained outside the repository.

## 2026-10-31 results

The first matrix (seeds 0–2) and independent-seed replication (seeds 3–5) both
completed: **48 paired cases × 7 strategies = 336 trials**, **1119 unique real
DeepSeek response IDs**. The upstream reported 4,503,183 total input tokens
(including rereads) and 194,722 completion tokens. No scored trial failed at the
provider layer or hit the trial/generation bounds. This is not 336 API calls.

| Strategy | Frozen strict-contract passes | Requested fields correct | Mean total input tokens | Mean latency (s) |
| --- | ---: | ---: | ---: | ---: |
| Full results | 44/48 | 47/48 | 27,125 | 5.85 |
| Current production projection | 40/48 | 47/48 | 15,362 | 9.89 |
| All batches, 8192-char threshold | 41/48 | 46/48 | 16,724 | 15.00 |
| All batches, 2048-char threshold | 41/48 | 47/48 | 11,357 | 13.78 |
| Critical metadata + short excerpt + history | 41/48 | 47/48 | 8,950 | 12.28 |
| Archive handle only + history | 40/48 | 47/48 | 13,443 | 17.74 |
| Typed short projection, history unavailable | 11/48 | 11/48 | 855 | 2.26 |

“Requested fields correct” is a separately disclosed secondary metric. It
ignores extra fields but requires the requested top-level fields and exact JSON
types; it does not replace the frozen primary strict score. The audit was added
after seeing discovery format errors, declared and hash-frozen before replication,
and applied uniformly to both phases without changing any original trial score.
Nested but factually correct answer objects remain output-shape violations.

### What the observations support

- The typed-short candidate used **41.7% fewer total input tokens than current**
  and **67.0% fewer than full**. Excluding the deliberately oversized paged-search
  stratum, savings were **43.5% vs current / 37.0% vs full**. Thus the aggregate
  result is not presented without the ordinary-task stratum.
- It is **not a universal winner**: its strict passes were 41/48 vs full 44/48,
  and its mean latency was higher. This small templated workload does not prove
  statistical noninferiority or absence of downstream effects.
- Blindly applying the default head/tail pruning to every batch used **8.9% more
  total input tokens than current**, despite a smaller initial projection.
  Reread round trips matter. Only retaining links did not save meaningful input
  tokens on ordinary tasks relative to full results (13,949 vs 13,968).
- A generic 2048-threshold result lost a required `receipt_id` in
  `unknown_effect-s3` (returned null); typed metadata preserved it and that
  matched case passed. No modifying operations were executed; these are domain
  execution-evidence fixtures, not receipts for production writes.
- The full-result failure on `paged_search-s3` returned the correct port as a
  string instead of an integer. The archive-only failure returned correct facts
  followed by `</final>`, breaking JSON parsing. These are **format/type**
  failures, not evidence that those facts were removed from the input.
- Recovery is a prerequisite, not a detail: removing history exposed the
  insufficiency of status plus a small excerpt (11/48 task completions).

### Validation and scope

The remote bridge/history, context and compaction tests passed **114 test
executions**; strict example Clippy, local formatting, architecture checks,
archive reconstruction, pagination, invalid arguments and cross-session negative
controls passed. Remote Rust and runner SHA-256 values matched the orchestrator.
No Rust compiler/build/test ran locally. The detailed aggregate is retained in
`results-20261031.json`; synthetic traces and original pilot failures remain in
the task's output directory.

The history tool reads a frozen synthetic prefix. Model replies and history
results are replayed in the API conversation, but are not appended into that
prefix. This avoids conflating retrieval correctness with the full production
journal/LoopEngine lifecycle and is an explicit external-validity limitation.

**Candidate for further integration:** keep authoritative execution status,
receipt, identity and source handles outside the clipped body; use a bounded
excerpt and recover relevant evidence on demand. In production, extract these
from typed execution state and tool-specific structured output—not arbitrary
untrusted JSON or an assumption that every tool shares this experimental shape.
Do not retire a body unless its original evidence is actually recoverable.
The scored experiment did not enable this candidate in installed/production
policy, merge a PR, or publish a release. Committing its opt-in runner and
historical receipts does not enable it. Offline CI validation is provided by
`python3 -B scripts/experiments/test-tool-result-ablation.py`; live API/SSH runs
remain explicit opt-in operations.
