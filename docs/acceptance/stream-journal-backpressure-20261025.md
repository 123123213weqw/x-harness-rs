# Streaming journal backpressure — V100 acceptance

## Failure and scope

Baseline: `58d894140cb566865023481b49eed437b6ccb5fe`.

The engine awaits durable reception/chunk checkpoints while consuming a provider
stream. Once a session exceeds the resident snapshot budget, each checkpoint
could replay, decode, hash and validate the entire JSONL prefix. Live Host
observers could cause the same replay immediately after an append. This creates
client-side backpressure and can depress reception TPS even with a healthy
provider. It does not establish that every slow response has this cause.

The new oversized-checkpoint regression failed against the baseline: 32 appends
caused 32 full replays rather than zero. All benchmarks use synthetic histories;
no credentials, real conversations or model API credits were used. The installed
macOS application was not replaced or restarted.

## Implementation and compatibility

- Session owns an opaque, non-serializable `StreamAppendCursor`, derived only
  from a validated log. Only `AssistantChunk` and `ModelReception` can advance
  it. Their open-step/coordinates/assistant-message rule is shared with the full
  validator. CAS, sequence and revision arithmetic remain checked. Structural
  and mixed batches retain complete validation. Differential tests use full
  `Session::restore`, not the optimized append, as their independent oracle.
- JSONL retains the tiny cursor and incremental hash in its existing bounded
  validated-stamp map. Reuse requires an exact current file fingerprint, clean
  newline-terminated validated prefix, normal process/advisory locks and secure
  file opening. The opened file, final length and final path cut are checked.
  Missing/stale/replaced sources and torn tails use authoritative loading and
  repair; corrupt input is not silently accepted. Incremental hashes are checked
  against SHA-256 of the actual file bytes.
- Each model round optionally leases the existing operation-scoped snapshot
  cache, shared with Host readers. Admission to that cache precedes ordinary LRU
  admission, avoiding concurrent-session LRU thrash. Completion, failure and
  cancellation release the lease. There is no idle retention or unbounded cache
  increase: resident default **128 MiB**, scoped default **512 MiB / four distinct
  session scopes**, tiny stamp map **4096 entries**. These are logical accounting bounds,
  not process RSS limits. Exhausting a scope budget retains safe full-read
  fallback; stream-only writes can still use the tiny cursor.

Journal bytes, batch schema, compression format, audit contents, pagination,
history cursors, model/tool inputs, flush/fsync policy and recovery/side-effect
semantics are unchanged. No migration or deletion of historical data is needed.
New tests cover stale CAS, external writers, replacement, symlinks, corruption,
torn tails, missing separators, concurrent CAS, mixed batches, closed steps,
compressed prefixes, bounded history and exhausted-cache fallback.

## Paired release pressure

V100 (`WZU_Server`), Linux x86_64, Rust 1.99.0, release profile, four build jobs,
eight Tokio benchmark workers. Each session starts with **48 MiB of synthetic
historical chunk text**, slightly more in JSONL encoding. Each timed frame
appends a text delta plus reception record. Paired runs use 64 frames/session,
no pacing, fresh processes and the same benchmark source on baseline/fixed
implementations. Each process has a 4 GiB virtual-memory ceiling and an external
timeout. The page cache is warm; these numbers are not cold-disk throughput.

| Concurrent sessions | Append P95 before → after | Hot full replays before → after | Process peak RSS before → after |
| --- | --- | --- | --- |
| 1 | 769.020 → 0.166 ms | 64 → 0 | 152.49 → 153.01 MiB |
| 4 | 764.979 → 0.260 ms | 256 → 0 | 450.03 → 354.00 MiB |
| 8 | 782.309 → 0.474 ms | 512 → 0 | 845.16 → 454.97 MiB |

At eight sessions, hot append wall time was 48,464 → 16 ms. Whole-process user
CPU was 383.20 → 22.67 seconds, system CPU 23.89 → 2.05 seconds. Whole-process
CPU/RSS include preparation, structural finalization and independent full disk
replay verification; latency/replay counters cover only the streaming interval.
Resident snapshot accounting stayed zero because these histories exceed the
resident budget. Do not interpret this as a corresponding multiplier in
DeepSeek's server decoding TPS, nor as proof of reduced physical disk reads.

Additional fixed-side runs:

- **Soak:** eight sessions × 4096 frames = 32,768 checkpoints, 5 ms pacing;
  P95 **0.612 ms**, P99 **0.649 ms**, zero hot full replays, 26.728 s hot wall
  time and **504.85 MiB** process peak RSS. Final independent replay succeeded.
- **Observed:** three sessions × 128 frames, 5 ms pacing, a real `Store::load`
  after every append; P95 **0.561 ms**, P99 **0.665 ms**, three full replays
  (one initial snapshot per session), **342.27 MiB** process peak RSS. Final
  independent replay succeeded and scoped snapshots were released.

Raw scalar results and measurement definitions are retained in
`stream-journal-backpressure-20261025.json` next to this document.

## Actual Host / Core acceptance

The Host regression uses the real RPC, durable Agent runtime, Core engine and
JSONL with a synthetic streaming provider. Oversized history is forced by a
1 KiB resident limit. One and four concurrent sessions each receive 128
alternating text/reasoning deltas. Source start/end barriers isolate checkpoint
work from cold admission and terminal structural work.

- One-session emission phase: replay counter **21 → 22**.
- Four-session emission phase: global replay counter **84 → 88** for all workers.
- Independent disk restore contains exact text and reasoning; Host sequence
  cursors reach the same durable cut. Completion, cancellation and permanent
  provider failure all release scoped storage and retain valid history.
- Optimized Host test passed both cases in 3.65 seconds. Whole-RPC duration
  (not pure provider emission) was 1.061 s for one session and 1.325 s for four.

**Remaining gap:** cold admission and structural finalization still replay
history. The optimized run observed 27 whole-RPC replays for one session and
106 for four, almost all outside the source-emission interval. This change does
not claim to solve every cold-start cost or unlimited observer concurrency.

## Regression commands

Run Rust only on V100 **after syncing current sources**, excluding `.git/`,
`target/`, `node_modules/`, `.env*` and credentials. The acceptance source root is
`~/codex-build/x-harness-rs/stream-journal-backpressure-20261025/`.

```sh
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_BUILD_JOBS=4
export CARGO_TARGET_DIR="$HOME/codex-build/x-harness-rs/target"
cargo test --locked \
  -p xharness-session -p xharness-session-jsonl -p xharness-core \
  -p xharness-host -p xharness-agent -p xharness-goal \
  -p xharness-projection -p xharness-session-import -- --test-threads=4
cargo clippy --locked -p xharness-session -p xharness-session-jsonl \
  -p xharness-core -p xharness-host --all-targets -- -D warnings
cargo test --locked --release -p xharness-host stream_performance_tests \
  -- --nocapture --test-threads=1
```

Pressure reproduction (use a new, application-independent fixture directory;
`run` appends another synthetic turn, never point it at user session storage):

```sh
cargo build --locked --release -p xharness-session-jsonl --example stream_pressure
BIN="$CARGO_TARGET_DIR/release/examples/stream_pressure"
"$BIN" generate /tmp/xh-stream-new-fixture 8 48
(ulimit -v 4194304; timeout 180 /usr/bin/time -v \
  "$BIN" run /tmp/xh-stream-new-fixture 64 0)
# Separate fixed-side soak: run ... 4096 5; observed-reader case:
"$BIN" generate /tmp/xh-stream-new-observed 3 48
(ulimit -v 4194304; timeout 180 /usr/bin/time -v \
  "$BIN" run-observed /tmp/xh-stream-new-observed 128 5)
```

Local non-compiling gates: `cargo fmt --all -- --check`, `git diff --check`, and
`python3 -B scripts/regression/check-architecture.py --base
9c9dabe392d29dcaa1d0ddca71b398cd6972fd24`. The content-bound architecture record
preserves the persistence freeze; it is a compatibility/test plan, not a claim
of native Windows or macOS execution. Native desktop smoke tests remain a CI /
platform acceptance responsibility before release.

After integrating master `9c9dabe392d29dcaa1d0ddca71b398cd6972fd24`,
the eight-crate V100 suite passed **1013 tests**, with **11 ignored** and no
failures. All-target Clippy for Session, JSONL, Core and Host passed with
`-D warnings`. Formatting, whitespace and content-bound architecture checks also
passed. Ignored tests and native platform acceptance are not counted as passes.

## macOS CI fixture follow-up

The first macOS matrix exposed a test-only lookup using an aliased temp-root
path rather than the Store's canonical session path. The hash oracle now reads
through the requested directory alias but looks up the validated stamp using
`session_path`. Unix runners explicitly create a directory alias so V100 also
exercises this case. The exact byte-hash assertions remain unchanged. The full
JSONL suite and all-target Clippy passed again on V100 before pushing the fix;
production append/cache code and the pressure measurements are unchanged.
