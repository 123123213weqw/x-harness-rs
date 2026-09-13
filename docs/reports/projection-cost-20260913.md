# Host projection allocation and lock-scope validation

Base: upstream `931d875`. Scope is the shared Rust Host, not Windows-specific code.

## Changes

- Move the owned data tree and event-type String into the Web envelope. Preserve seq/time/data/surface operation contracts.
- Count exact serde_json output bytes through a checked IO sink instead of retaining a temporary encoded Vec. Existing tail eviction policy and serialized-size error fallback stay unchanged.
- Capture published cursor, creation identity and all four model route fields. Prepare newly projected events, tool views and the turn-presence scan outside the global write lock. Retain the per-session gate through publication; verify inputs under the write lock before modifying state or metrics. Retry from a fresh authoritative snapshot up to three attempts if inputs changed, then report explicit contention rather than publish stale data. Session disappearance returns SessionNotFound instead of panicking.
- Mutable metrics application and cache replacement remain under the write lock. This does not eliminate every allocation/destructor under that lock or make synchronization fully incremental.

## Executed validation

All Rust compilation/tests ran on WZU_Server using an isolated source directory; no Rust compiled on the Windows workstation.

- Red/green envelope test: the old json! implementation produced equal JSON but changed the owned nested String allocation pointer, failing the new test. Moving the payload passed the same test.
- Four allocation/size tests passed: envelope identity/content, Unicode/escaping/numbers/nesting/1-MiB payload exact byte counts, checked counter overflow, exact-limit and one-byte-short tail boundaries.
- Five publication/preparation tests passed: stale cursor and every model field/creation identity, preparation while the global write lock is held elsewhere, invalid/end cursor boundaries, synthetic PowerShell call/result card and argument equivalence, 16 concurrent synchronizers publishing the single new durable event exactly once.
- Full `cargo test -p xharness-host --lib --quiet`: **120 passed, 0 failed, 3 ignored**, 123 discovered; test execution 2.10 seconds (not a performance benchmark). The three existing opt-in incident stress tests were not run. New tests use synthetic snapshots and do not execute tools or call models.
- Local `cargo fmt --all -- --check` and `git diff --check` passed.
- Cross-platform GitHub CI is requested through the upstream PR; this document does not claim its outcome before completion.

## Boundaries

No original journals, model-message projection, history pagination protocol, tool arguments, release configuration or installed App were changed. Existing complete replay, permission/question lifecycle and live/restart history regressions passed.

No measured end-to-end latency/RSS improvement is claimed. Exact-size counting still traverses the JSON; oversized payload construction and the raw Arc<Vec<LoggedEvent>> history remain separate concerns. This is **not** a proven fix for the unexplained production access violation and does not establish long-running memory safety.
