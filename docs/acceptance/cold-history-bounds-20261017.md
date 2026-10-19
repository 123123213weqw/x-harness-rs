# Cold history: bounded-resident maintenance

## Contract

Display readiness does not certify execution readiness. Verified idle history,
model-directory and static skill reads may avoid Agent hydration; mutations,
explicit capability refresh and execution keep their recovery gates. Existing
history response fields, sequence cursors, pagination and frontend reading
position behavior do not change. Goal and working-plan baselines are preserved.

No authoritative journal or existing catalogue/checkpoint format is migrated.
An optional source-bound presentation sidecar is separate from startup metadata.
Unknown, changed or damaged journal sources retain semantic recovery validation.

## Maintenance

When an idle catalogue and presentation match the source but the offset index
is missing, stale or corrupt, one maintenance operation reads batches in order
and rebuilds only the disposable index. It checks the header, CAS chain, event
coordinates, source fingerprint and unchanged catalogue before publication. A failed optional index write still serves the verified in-memory
index; unexpected filesystem objects are not replaced.
The scan never creates a Session, runtime, executable checkpoint or recovery
publication stamp. Failures do not fabricate an empty successful history page.

Missing catalogue metrics use the same reader with an application-owned reducer;
only a complete snapshot against the identical source is atomically published.
Other Store implementations can decline this optional optimization and retain
their original full-load behavior.

Maintenance is serialized per Store, independently of ordinary indexed reads.
Index construction retains the existing entry/byte limits and decoding retains
the existing 128 MiB physical/expanded per-record limit. This bounds resident
transcript data to a batch, not an entire conversation. It is **not** a constant
latency promise: oversized/unindexable sources retain their original fallback; an index miss still requires one linear source scan; a single
very large batch can still produce a substantial allocation peak.

## Parsed-index cache

The default cache has at most four entries and an 8 MiB accounted-byte budget.
Accounting includes owned collection capacities/node overhead and charges at
least four times serialized size; it is not a process RSS limit. Journal and
sidecar fingerprints/cursors must match for reuse. Entries are shared via Arc,
not deeply cloned. Tiny indexes below 16 KiB bypass this cache to avoid extra
fingerprint I/O. Disabling the cache does not change history contents.

## Verification

Run Rust only on V100 after synchronizing all source changes. Verify source
hashes, and use a private `CARGO_TARGET_DIR` when testing concurrent checkouts
(the acceptance directory is `~/codex-build/x-harness-rs/history-bounds-20261017/target`).
A shared target produced inconsistent dependency artifacts in an initial
follow-on build; that run is not the final integration qualification. Required suites:

- Session, JSONL, Projection and Host tests; production Job continuation tests.
- Missing/corrupt indexes, byte/entry eviction, replacement invalidation, failed
  publication, compressed batches and concurrent source/catalogue changes.
- Full-replay versus streaming usage equality, no runtime loads or Session cache
  residency after cold reads/metrics repair, working-plan/Goal preservation.
- Chromium and WebKit history-open-target, pagination, scroll-follow, atomic
  history and lifecycle recovery regressions.
- Architecture/freeze checks, formatting and Clippy.

Opt-in cache A/B (same typed events and page coordinates, mirrored run order):

```sh
cargo test --locked -p xharness-session-jsonl --test cold_history \
  parsed_index_cache_ab_benchmark -- --ignored --nocapture
```

Synthetic benchmarks must use isolated state and a loopback provider, never
installed conversation files or live credentials. Record build type, warm/cold
OS cache, Host-only versus whole-app memory, and distinguish UI data readiness
from first paint. Passing these tests is not native Windows/macOS qualification.

## Results (2026-10-17–18)

- V100 private target: 633 passing Rust tests (620 Session/JSONL/Projection/Host,
  plus 13 production Job continuation cases). Existing opt-in/credentialed cases
  stayed ignored; the cache benchmark was additionally run explicitly.
- Clippy passed with `-D warnings`; source hashes, formatting, architecture/freeze
  checks and 30 architecture checker unit tests passed.
- Chromium and WebKit source regressions passed both locally and on V100
  (Node 22.23.3, locked Playwright dependencies). The Linux suites cover history
  open targets, page intent, cache eviction, atomic replay, conversation layout,
  scroll-follow and lifecycle recovery. A real V100 WebKitGTK
  2.50.4 window opened the packaged UI against the accepted Host and paged all
  1,808 projected events in eight older-page requests, with unique cursors,
  no UI errors, unchanged journal bytes, no model requests and the Agent still
  cold after both opening and pagination. The bookmark browser tests preserve
  event 125 at an offset of -35 px and reopen latest with one tail page.

Mirrored-order parsed-index A/B: 2,000 synthetic turns, 60 sequential pages,
329,073-byte index, same typed events and coordinates in both modes:

| Cache | Two runs (ms) | Accounted cache bytes |
| --- | --- | --- |
| Disabled | 3908.154 / 3911.042 | 0 |
| Enabled | 270.852 / 270.887 | 1,316,292 |

A separate same-debug-binary Host restart probe enlarged only old assistant
bodies in a generated 58,912,653-byte journal; the newest page stayed identical:

| Opening mode | Tail RPC (ms) | Sampled Host peak RSS (MiB) |
| --- | --- | --- |
| Valid presentation/index | 290.6 | 65.4 |
| Missing index, streaming repair | 5532.9 | 65.6 |
| Forced original full-recovery fallback | 14489.4 | 123.1 |

One sample per opening mode, warm OS disk cache (physical read bytes were zero),
Host-only memory, not whole-app memory or first paint. A missing index still
reads the source once (about 59.7 MB logical reads in this probe). Streaming
metric repair reproduced the full public metric snapshot without hydrating an
Agent; it also stayed around 66.4 MiB sampled Host RSS. Its reported RPC interval
is not the complete metric-repair duration because repair starts during startup.
All synthetic probes used isolated state and zero real model calls. These are
controlled observations, not a release SLA or native Windows/macOS acceptance.
