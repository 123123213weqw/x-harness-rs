# Queue receipts and long-loop work: isolated acceptance

Base: `76a4b35e5c6c8776c7921387ed1ccaabaf948886`.
Validation completed on 2026-10-28 on the user-selected external V100.
The installed app, its sessions and other running tasks were not changed.

## Corrections

- A late observer can settle its own completed or explicitly cancelled input
  from durable receipts while a successor is busy. Reconciliation uses an
  absolute deadline that survives cancelled receive futures and unrelated
  event traffic. An old receipt must not clear the active successor's status.
- Journal validation borrows pending identities and updates membership for
  changed identities, rather than cloning pending bodies and rescanning all
  pending IDs for every historical splice. Full structural validation remains.
- Safe local queue/start/user/header deltas use the existing incremental tail
  update. Checkpoints, reused consumed IDs, cold routes and unknown events
  retain canonical replacement. JSON, weights and resident byte accounting
  are checked against the canonical full fold.
- Inbox projection replay borrows immutable historical messages, materializing
  only the inputs still pending at the final cut. No durable history is dropped
  and no new persistent cache or scheduler is introduced.

The validator is compared against the original algorithm in 6,000 deterministic
cases, including exact first-error ordering. Append, restore and failed-batch
rollback retain their original rejection behavior.

## Same-machine performance and resources

These are debug-build, synthetic-provider tests through real Host/Agent RPC
with `MemorySessionStore`. They are **not** live UI, real LLM or production
storage latency measurements.

304-input admission took 71,402 ms on the exact old base versus
3,435 / 3,426 / 3,432 ms on the candidate (mean 3,431 ms, about 20.8x faster
for this phase only).

The original long-test gate was retained: 1,001 inputs, 20 stop calls and a
120-second internal deadline per run. All three predeclared candidate runs
passed without increasing that deadline:

| Run | Elapsed ms | Journal events | User CPU s | System CPU s | Peak RSS KiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 98,363 | 11,014 | 98.42 | 1.23 | 352,656 |
| 2 | 98,046 | 11,020 | 97.97 | 1.36 | 362,984 |
| 3 | 98,697 | 11,014 | 98.67 | 1.26 | 365,908 |

Each run asserts every admitted input ID appears exactly once in the complete
durable history; both pending queues are empty and the Host has `running=false`
and no control handle. The default test suites passed 802 unique tests with
12 explicit ignores. The long stress is one of those opt-in tests and was
executed separately, not counted as a default-suite pass.

## Reproduction

Run Rust commands only on a remote server after synchronizing the current
source, per `AGENTS.md`. The completed acceptance used the unchanged lockfile.

```sh
cargo test --locked -p xharness-session -p xharness-projection --all-targets
cargo test --locked -p xharness-host -p xharness-agent -p xharness-session-jsonl --all-targets
cargo clippy --locked -p xharness-host -p xharness-agent -p xharness-session -p xharness-projection --all-targets -- -D warnings
# Run three independent times; keep failures rather than retrying for green.
cargo test --locked -p xharness-host long_queue_handoff_preserves_every_input_once -- --ignored --nocapture
```

Root and nested desktop formatting, diff checks and the Git-backed architecture
boundary/freeze checks passed. No wire format, event schema, permission or
executor/process behavior changes are intended.

## Failed attempts and limits

The initial observer-only candidate and exact old-base comparator both failed
the unchanged 120-second stress gate during admission. Timing instrumentation
then measured 104.9 seconds in append/validation. Fixing validation reduced
304-input admission to 11.1 seconds but the stress still failed; incremental
tail preparation reduced it to 3.8 seconds but the stress still failed after
862 completions. Borrowed historical inbox replay produced the final three
passing runs above. All failed attempts and raw logs were retained locally;
they are not counted as passes.

The original live loss-of-observation trigger remains unproven. Controlled
late-observer convergence defects and CPU amplification were reproduced and
corrected; this is not proof that every online trigger, memory leak or
overnight stability issue is resolved. Native macOS/Windows and all relevant
checks for the exact PR head must pass before merging. No installation,
restart, deployment or release is part of this change.
