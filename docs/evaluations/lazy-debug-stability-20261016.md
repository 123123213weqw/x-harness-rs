# Lazy debug payload stability acceptance — 2026-10-16

## Decision: draft, not a memory stability certificate

The scoped lazy-payload change passes its functional and ownership regressions. Broader Host memory acceptance **failed**. Keep the PR draft and do not merge/release it as a comprehensive memory fix. No installed application or user conversation was modified.

The unrelated composer UI commit was removed from this branch. The optimization is rebased onto current `master` (`fc7897dd60846d16016d04256a3f3674a6bf564c`). Its production code commit before added acceptance tests is `977bd81ceff23bd2886ed2c7e2700ca6c17ec74f`.

## Passed checks

- 277 optimized Rust tests on WZU_Server across Debug, Core and OpenAI provider, including 17 real-HTTP recovery tests.
- 30 architecture checker self-tests; dependency/freeze checks; formatting and diff checks.
- Remote Clippy for all targets of the three affected crates with `-D warnings`.
- 2,048 disabled-payload calls: zero evaluations, all owned captures dropped, no remaining capture ownership.
- Cancelling a pending sink releases the recorder and in-flight sink ownership; checked via a weak reference and destructor counter.
- Sixteen concurrent full-trace producers, a one-event queue, 512 records: exact global sequence, per-producer ordering, redaction and 64 large Unicode/escaped blob digests verified.
- Native Chat Completions and Responses HTTP tests: full/off tracing preserves the large escaped JSON request and the complete normalized event sequence.

## Host soak results: failed resource gates, preserved task results

All verification uses isolated state and a fake loopback provider. Each prompt contains 32 KiB of inert text. Every completed turn checks exact text, reasoning, disjoint token usage and one completed terminal event. No real model or API credential is involved.

| Case | Verified turns | First → last idle Host RSS MiB | First → last FDs | Resource interpretation |
| --- | ---: | ---: | ---: | --- |
| lazy-stability-reuse-off | 192 | 59.9 → 620.5 | 40 → 42 | RSS alarm failed |
| lazy-stability-reuse-full | 192 | 62.7 → 606.7 | 41 → 41 | RSS alarm failed |
| lazy-stability-reuse-old | 192 | 56.0 → 578.9 | 39 → 42 | RSS alarm failed |
| lazy-stability-delete-strict | 24 | 41.2 → 58.1 | 19 → 85 | FD alarm failed |
| lazy-stability-old-baseline | 24 | 38.4 → 55.8 | 19 → 85 | Old pilot: same FD retention; no FD gate then |

Reuse runs keep eight sessions in the same Host for 24 waves (192 turns). Normal history intentionally grows; both old and new builds show large RSS growth. The predeclared 64 MiB idle-drift alarm failed. This is an acceptance alarm, **not** a proof that all growth is leaked memory or caused by JSON. Heap attribution remains necessary. The older binary is from `2f72bdd4`, not the exact current master parent; these runs do not establish a causal memory regression or improvement.

The full-trace reuse run additionally verified all 30,124 JSONL records and 928 referenced blob hashes/lengths/JSON bodies. Data integrity passed while the memory alarm failed.

Delete runs create two fresh sessions per wave, verify their turns, archive and permanently delete them. After 24 deletions both binaries still have 85 FDs versus 19 after the first wave. Captured `/proc` targets include session leases, workspace directory handles and deleted attachment directories. The final strict test fails the predeclared FD-drift limit of eight. Older pilot `passed=true` values did not enforce FD growth and must not be represented as resource acceptance.

## Follow-up findings, not silently fixed here

1. Permanent deletion calls `DurableLoopAgentRuntime::delete_session_data`, which deletes durable storage but does not retire the corresponding supervisor handle. `AgentSupervisor.handles` retains handles until Host-wide shutdown. A proper fix needs coordinated worker retirement, lease release and tool/session cache cleanup, with admission/recovery race tests; do not simply erase a map while a worker can still run.
2. Growing-session RSS needs a heap/retention profile separating history, projection/cache state, per-step request material and allocator retention. No heap profiler was installed on V100, and this probe is not a heap profile.
3. The previously discussed JSON improvements (selective control-field copying, typed feature extraction, streaming hashes/lengths and byte-budgeted full trace spilling) are not implemented by this lazy-payload PR.

No evidence here certifies Windows/macOS memory behavior or an overnight workload. GitHub CI is required for cross-platform functional acceptance.

## Reproduction (remote Linux only)

```sh
cargo test --locked --release -p xharness-debug -p xharness-core -p xharness-provider-openai
cargo clippy --locked -p xharness-debug -p xharness-core -p xharness-provider-openai --all-targets -- -D warnings
python3 scripts/regression/test-debug-payload-stability.py \
  --binary /absolute/path/xharness-host --output /absolute/path/new-reuse-evidence \
  --trace off --lifecycle reuse --waves 24 --concurrency 8
python3 scripts/regression/test-debug-payload-stability.py \
  --binary /absolute/path/xharness-host --output /absolute/path/new-full-evidence \
  --trace full --lifecycle reuse --waves 24 --concurrency 8
python3 scripts/regression/test-debug-payload-stability.py \
  --binary /absolute/path/xharness-host --output /absolute/path/new-delete-evidence \
  --trace off --lifecycle delete --waves 12 --concurrency 2
```

The resource probes currently exit nonzero for the documented alarms. Do not raise thresholds or omit these failures to claim completion. The scripts stop only the isolated Host process group they created. Full traces remain in the isolated evidence directory; the probe checks them after shutdown.

Machine-readable summaries are in `docs/evaluations/lazy-debug-stability-20261016.json`. Full local command logs and resource samples are retained outside the repository in `/Users/wangyue/codex-build/xharness-runtime-perf-20261016/comprehensive/`. Synthetic histories and production secrets are not committed.
