# Lazy debug payload construction — 2026-10-16
**Later acceptance update:** broader Host resource checks failed; see `docs/evaluations/lazy-debug-stability-20261016.md`. The initial benchmark below is not a memory stability certificate.

## Change

Full trace payloads were eagerly materialized before `record_lossy` checked its sink. With full tracing off, Core still serialized prepared context, loop events and final history; the OpenAI provider still copied request bodies and stream deltas into disposable JSON.

`DebugRecorder::record_lossy_with` accepts a payload closure. A full sink evaluates it once and retains existing redaction, spill, ordering and deferred-error behavior. A disabled sink skips it; an attached bounded runtime observer still receives the same layer/event/step metadata without message content. Core and OpenAI hot paths use this API. The existing eager API remains compatible.

Model choice, reasoning effort, request encoding, context budgets, streaming parsers, usage accounting, persistence, cancellation, retries and tool scheduling are not changed. The fallible compaction tools hash is still evaluated at its existing boundary, preserving error behavior.

## Linux controlled A/B

Baseline: `2f72bdd4d616d5bf81ab22237d2892f27bea528e`. Optimized Host binaries built remotely on WZU_Server (V100). Five alternating-order repetitions per case and binary, fresh isolated state/workspace, warm OS cache, shared server. Trace payloads off; runtime metadata observer explicitly enabled for both binaries. No credentials, real model, TLS or browser are used by this fixture.

All 30 trials preserved exact body text, reasoning, disjoint usage counters, one-step completion and the completed terminal reason.

| Fixture | Task latency ms, old → new | Host CPU ms, old → new | Peak Host RSS MiB, old → new |
| --- | ---: | ---: | ---: |
| small | 91.4 → 89.4 | 40 → 30 | 32.7 → 32.6 |
| large_context | 609.4 → 602.3 | 830 → 840 | 148.2 → 144.2 |
| streaming | 393.6 → 317.4 | 800 → 670 | 70.2 → 67.2 |

Values are medians. The large-context fixture sends a 2 MiB user input. The streaming fixture emits 4,096 frames with both text and reasoning. Its runtime and CPU medians improved by approximately 19.4% and 16.3%. Large-context latency did not meaningfully improve, and its CPU median increased; RSS savings and tiny-request timing are noisy. This does **not** demonstrate a comparable end-to-end DeepSeek speedup.

CPU is Linux process accounting (10 ms resolution); RSS is process high-water, including startup, excluding WebKit/tool children. Task latency ends at authoritative `turn/end`, excluding observation polling tail. Python loopback fixture work and shared-server contention still affect wall time. No confidence interval, p95, long-run leak, macOS or Windows performance claim is made.

Fixture binary SHA-256:
- Baseline: `c3eb6b3c2caf4ecfc67c0e999ab60da9c2dfd052ddc98f9c9b9236a50111a23f`
- Candidate: `3fd81be9fbd8c95181a5c848f4a5b16cdf1f5e79c4201dc136a518ebffe4d324`

An earlier pilot and first cohort are excluded from the accepted observer-enabled result: the initial driver did not set runtime-diagnostics environment variables. Their timing data was not substituted into this table.

## Real DeepSeek behavior smoke test

Three isolated native-transport coding tasks used `deepseek-flash`, the existing `xhigh` profile mapped to upstream `max`, and the existing 65,536-token output ceiling. No installed configuration was changed. All three passed visible tests, independent deterministic checks, protected-file and task-completion checks. Two of three met the exact final-marker formatting requirement; the intervals run failed that strict formatting gate despite passing functional checks. Successful model-invoked test receipts were independently decoded and matched by call ID to the expected suites (6/8/5 tests).

In a separate preliminary smoke cohort, the first driver marked the intervals task unsuccessful because its test-command detector recognized shell `command` but not the valid `program` + `args` form. Its original result remains unchanged; the independent receipt audit confirmed exit 0, the expected six test names, `Ran 6 tests` and `OK` from that actual tool result. This was an experiment-detector gap, not a product failure. No timing comparison against other real-model cohorts is claimed.

## Regression coverage

- 273 remote optimized Rust tests across Debug, Core and OpenAI provider: passed. Includes disabled lazy payloads, exact full event, payload-free observer delivery, bounded queue overflow, deferred writer errors, full redaction/spill, both native wire protocols, completion and transport recovery.
- 27 architecture checker self-tests with Python 3.11: passed. The system Python 3.9 cannot run existing freeze tests using `Path.write_text(newline=...)`; no product workaround was added.
- Architecture dependency/freeze check, local formatting and diff checks: passed.
- Final remote Clippy (`--all-targets -- -D warnings`): passed.

## Reproduction

Retain the old optimized Host before rebuilding the candidate. Synchronize current source to an isolated remote directory excluding `.git`, `target`, `node_modules`, `.env`, `.env.*` and secrets. Run Rust commands **only on the remote Linux server**:

```sh
cargo test --locked --release -p xharness-debug -p xharness-core -p xharness-provider-openai
cargo build --locked --release -p xharness-host-app --bin xharness-host
cargo clippy --locked -p xharness-debug -p xharness-core -p xharness-provider-openai --all-targets -- -D warnings
python3 scripts/regression/benchmark-debug-payloads.py \
  --baseline /absolute/path/old-xharness-host \
  --candidate /absolute/path/new-xharness-host \
  --output /absolute/path/new-evidence-directory --repeats 5
```

Local evaluation evidence is outside the repository at `/Users/wangyue/codex-build/xharness-runtime-perf-20261016/lazy-debug/` (`final-fixture/` histories/metrics, `final-live/` receipt audit and full remote command logs). No production history or API key is committed.

This change is isolated on `perf/lazy-debug-payloads-20261016`; no installed application was replaced, restarted or released.
