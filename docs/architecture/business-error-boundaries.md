# Recoverable business errors

## Enforced scope

The scope is computed, not a hand-maintained list of exceptions:

- Every `managedModules[].source` in `config/architecture-host-modules.json`.
- Every extracted business seam in `SOURCE_BOUNDARIES` in
  `scripts/regression/check-architecture.py`.
- The Host event publication and RPC/task observation boundaries.

At introduction this is 32 source modules across Host, Remote, Telegram and
native Host composition. New managed processors automatically inherit the rule.
This is **not** a claim that every legacy crate, platform FFI module, dependency,
macro, array indexing operation, allocation failure or explicit panic is panic-free.
Other modules retain existing checks; expand the strict scope through reviewed
architecture declarations rather than mass-changing their behavior.

Every guarded module unconditionally denies `clippy::unwrap_used`,
`clippy::expect_used`, `clippy::let_underscore_must_use` and `unused_must_use`,
and applies a second `cfg_attr(not(test), forbid(...))` fence in production.
The production `forbid` prevents a child module or local `allow` from overriding
these rules. Test compilation remains at deny because Tokio's test macro itself
emits `allow(clippy::expect_used)`; Clippy's two explicit test settings allow fatal
assertions inside tests, not in production. Both compile-time-constant exemptions
are explicitly disabled too, so the business policy has no implicit const escape. No feature/release/debug conditional
may replace the exact non-test fence. The existing unconditional unsafe-code
forbid continues to include tests. No type-wide exemption, blanket `allow`, baseline of new violations,
or generated-source text substitution is permitted.

## Error ownership

1. A business operation returns a meaningful `Result`; preserve the typed code,
   source/context and caller receipt. Never acknowledge a failed operation as
   successful. `?` propagates; it does not log by itself.
2. Observe once where the result leaves its owning RPC/task boundary. Current
   Host typed and dynamic RPC paths observe all returned failures, including
   early hydration failures, without changing their wire errors.
3. Boundary diagnostics contain a closed operation/category and a hashed request
   correlation tag. The tag is for correlation, not authentication. Do not log
   request payloads, prompts, raw request IDs, credentials or arbitrary error text.
   This closed schema is not a global redaction guarantee for third-party panic
   hooks, older logs or UI error messages.
4. Detached session drivers, recovered turns and background projections have a
   monitor which awaits the real child JoinHandle. Panic/cancellation is logged
   and forwarded through the existing session-scoped `host/agent-error` channel.
   The real ChatView renders `lastAgentError` as a persistent accessible alert.
   Do not fabricate `turn/end`, clear a newer driver's state, replay admission,
   or mark the session idle: a stopped projection worker does not prove that
   authoritative runtime work was rolled back or completed.
5. If a monitor is explicitly aborted, its owned child is aborted too. Dropping
   the monitor's JoinHandle does not cancel observation of the child. The handle
   is a monitor lifetime, **not** a successful business-operation receipt.

## Intentional degradation is not accidental swallowing

Do not replace `expect` mechanically with `.ok()`, `unwrap_or_default()`,
`drop(result)`, an empty `Err` arm or an invented URL. Distinguish:

- Validation chains ending in an explicit typed rejection are not swallowed
  errors merely because they use `Option` internally.
- Setting/unsetting the root path has explicit replacement semantics; unsetting
  an absent setting is intentionally idempotent. A set through a non-object is
  a BadRequest and the namespace snapshot/revision stays unchanged.
- Telegram callback acknowledgement is informational **after durable admission**.
  A failure/deadline is reported as a closed category, but must not advance again,
  retry admission or reverse a committed operation.
- Broadcast send failure means zero current subscribers. A live frame is not a
  durable record and reconnect reads authoritative history. This is expected,
  not a storage error; do not log every disconnected client as a fault or imply
  the frame was delivered. Malformed framing, in contrast, emits `stream/error`
  plus a payload-free diagnostic instead of disappearing.
- JSON `Value` compact display and closed account identity construction preserve
  the old persisted digest bytes. Compatibility tests compare the old encoding;
  there is no fallback hash, changed request identity or data migration.

## Proof, not keyword counting

Architecture tests reject missing/downgraded/conditional/spoofed guards and
production type exemptions. CI's Linux job additionally runs
`test-business-error-compiler-guard.py`: an isolated source copy receives actual
unwrap, expect, discarded Result, unused Result, const unwrap/expect and
local-allow mutations in each
protected module. The expected compiler diagnostic must name **every** module;
an unrelated build failure does not count. Crates are mutated separately so an
upstream error cannot hide downstream coverage. Original bytes are restored and
all affected targets pass positive Clippy afterward. Receipts and full compiler
logs are retained as CI artifacts.

Regression tests also cover error propagation/no commit, unchanged digest
identity, malformed stream visibility, task panic/abort ownership and the emitted
UI's persistent alert without false success or automatic retry. All existing
native/Windows/wire/session gates remain enabled.

All Rust compilation, tests and Clippy run on WZU_Server or repository CI, never
on the developer Mac. The full remote regression suite enrolls both compiler
mutation proof and the production UI failure outlet. `cargo fmt` is the only
locally allowed Cargo command.
