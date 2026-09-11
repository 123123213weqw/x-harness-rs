# Real DeepSeek history-recovery pilot — 2026-09-11

Four **real API** sessions using `deepseek-flash`, not mocked provider output. Independent acceptance executes a tightly restricted Python AST with 11 deterministic checks. The offline runner-plumbing test is separate and is not counted as model evidence.

## Source and protocol

- Baseline: `54e7d4b` (parameter-integrity fix already included; before durable tool archives).
- Candidate: `a3ba8f383c6d461833173925dee3a50a4a11b7cf` (PR #54 implementation).
- Identical `history_live_eval.rs` compiled against both sources on WZU Linux. Candidate binary SHA-256 `91ec1d6a44aa3b5c6476ec8ef0a87093730883294c797868db09582173e4871e`; baseline `8b79ab5de84cb84b3128f50bf5282e60564fca41bdd3c07484d2725ca71b59ce`.
- Real DurableLoopAgentRuntime → Core → OpenAiProvider → JSONL path. Candidate uses the runtime's real session-bound `history` tool, not an evaluator replacement.
- Custom in-memory `read`/`write` capability only exposes one Python source file; `diagnose` returns one observation and subsequently reports expiration. No shell, arbitrary paths, child agents or model-accessible credentials.
- IdentityContextPolicy, no compaction, no UI, no production prompt assembly. Therefore this isolates Core result archival/projection and history recovery, **not the default App's complete context stack**.
- Both use the same provider-default reasoning/sampling and per-request output ceiling; cumulative runtime output ceiling 131072 tokens. The runtime constructor's `2048` is event capacity, **not** a generation limit. External deadline 300 seconds; cancellation on the first event beyond step 16. No run reached either external limit.
- Manual pilot order: candidate ordinary, candidate recovery, baseline ordinary, baseline recovery. One sample per cell, no seed or counterbalancing. The reusable runner provides C/B ordinary, B/C recovery for subsequent pilots.
- API key supplied only through process stdin/memory, not environment, arguments, files or source. Reports contain only synthetic task data. No App replacement, release or production-session mutation.

## Results

Input below includes cached and uncached tokens **summed across requests**, not unique context size. Output includes visible output plus reasoning. These are token counts, not a billed-cost calculation.

| Case | Version | Acceptance | Input tokens | Output incl. reasoning | Tools | Seconds |
|---|---|---:|---:|---:|---:|---:|
| Ordinary code repair | Baseline | 11/11 | 1,938 | 417 | 2 | 3.555 |
| Ordinary code repair | Candidate | 11/11 | 2,760 | 302 | 2 | 3.643 |
| One-shot diagnostic recovery | Baseline | 2/11, failed | 785,447 | 38,093 | 20 | 194.313 |
| One-shot diagnostic recovery | Candidate | 11/11 | 20,185 | 1,188 | 8 | 10.829 |

Provider usage components:

| Case/version | Uncached input | Cache read | Cache write | Visible output | Reasoning |
|---|---:|---:|---:|---:|---:|
| Ordinary baseline | 914 | 1,024 | 0 | 263 | 154 |
| Ordinary candidate | 1,224 | 1,536 | 0 | 206 | 96 |
| Recovery baseline | 58,023 | 727,424 | 0 | 1,347 | 36,746 |
| Recovery candidate | 4,185 | 16,000 | 0 | 790 | 398 |

Ordinary repair had **822 more input tokens (+42.4%)**, consistent with the added history-tool schema, despite unchanged tool count. Do not claim universal token savings.

The synthetic recovery task deliberately places `base_ms=173 cap_exponent=6 ceiling_ms=7301` in the middle of a roughly 444 KB repetitive diagnostic. Its middle is omitted even by baseline's 256 KiB Core projection; candidate archives the complete envelope and projects roughly 8 KiB. This is a deliberately hostile recoverability test, not representative production-log sampling.

Baseline called expired `diagnose` **6 times**, repeatedly read/wrote the same file, and reasoned about missing-text lengths. It finally guessed `200 / 6 / 10000`; only the two negative-input checks passed. Runtime status was `Completed` despite incorrect code—why independent acceptance matters.

Candidate called `diagnose` once, `history` four times (three searches and one archive read), wrote the correct function and read it back. Actual history operations searched `RETRY_POLICY`, `base_ms`, then read the archive at byte offset 227900, then searched `ceiling_ms`. No expired-diagnostic rerun. Within this one stress sample, total input fell 97.4% and correctness improved. Extra searches show that recoverability does not imply minimal tool use.

## Limits and next work

This establishes that a real model can use the production recovery mechanism and that missing evidence can trigger expensive, unsuccessful repeated reasoning. It does **not** establish average agent quality, multi-file performance, restart/compaction behavior, long-running coding success, Windows runtime performance or all causes of thinking stalls. Compile/test coverage and these live measurements are separate evidence. The synthetic one-shot fixture structurally favors a recoverable design; larger realistic, repeated and counterbalanced tasks are required before tuning defaults from these numbers.

## Reproduce

1. Copy the same example into each selected source snapshot; compile remotely with `cargo build --locked -p xharness-host-app --example history_live_eval`. Keep two separate resulting binaries (shared Cargo targets overwrite the example executable).
2. Run `python3 scripts/history-eval-acceptance.py --self-test` and `python3 scripts/test-history-live-ab.py` (Linux offline plumbing test).
3. Run `python3 scripts/history-live-ab.py --baseline /absolute/before --candidate /absolute/after --output /absolute/NEW_DIRECTORY --baseline-revision SHA --candidate-revision SHA`. Supply JSON containing `api_key` and `model` through protected stdin; never use a key in argv or checked-in files. Runner clears child environments, alternates version order, applies deadlines and writes protocol/binary hashes plus checked results.
4. Inspect each run's `sessions`, `work/retry.py`, `metrics.json`, `checked.json`, and aggregate `report.json`. The initial pilot's evidence is retained in the isolated `history-pilot-*-1` directories on WZU and in a local private evidence directory; credentials were not found in the copied artifacts.

The first pilot used direct binary invocations; the new orchestrator is covered separately by an offline fixture test. Remote candidate example compilation and warning-denying Clippy passed. PR #54's pre-evaluator CI run `34553063434` passed all listed Windows/Linux/macOS, UI and updater checks; newly added evaluator files require their own subsequent CI run.
