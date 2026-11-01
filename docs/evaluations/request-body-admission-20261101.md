# Request-body byte admission and visual-context recovery

## Failure and boundaries

Inline image base64 is approximately 4/3 of the source file size. A raw-image
resource allowance is not an HTTP body allowance, and token usage is a separate
quantity. The official DeepSeek service documents a 48 MiB JSON body limit:
https://api-docs.deepseek.com/guides/vision/#limits.

The regression uses synthetic payload lengths: 46,887,304 encoded bytes fit;
51,130,808 encoded bytes alone do not, even though 38,348,082 raw image bytes fit
the existing 40 MiB resource budget. No conversation contents or real images are
included in fixtures or this report.

## Changes

- Serialize final provider JSON once, check its exact UTF-8 length, and transmit
  those same bytes with the JSON content type. This includes image data URLs,
  message text, tool definitions, profile patches and protocol framing. The
  check applies to generation, auxiliary summaries and native input counting.
- Default the byte limit only on validated official HTTPS DeepSeek routes;
  unknown/proxy deployments can set an explicit adapter limit. A model name on
  an unrelated endpoint is not evidence of that endpoint's transport limit.
- Treat HTTP 413 as byte admission, not token-context overflow or a transient
  network error. Pre-output recovery rebuilds the disposable surface, retires
  older images with explicit session-scoped `read` references, recounts it and
  writes a fresh request header before another model request. Recovery allows
  at most three reductions, checks for real surface progress, and never replays
  a completed tool effect or a committed partial model stream.
- Keep the current genuine user's images pinned, including after runtime notes
  and context-policy composition. Old user images can leave an over-budget
  sending surface without changing the journal. A pinned request that still
  cannot fit fails explicitly rather than silently discarding current images.
- Pin unknown/open/opaque tool units by their call identities. An unrelated old
  unknown outcome no longer vetoes retirement of every later known screenshot.
  The latest visual tool transaction remains available; older observations and
  duplicate observations keep readable references and unchanged text results.
- Auxiliary summaries use the same provider byte check. A 413 first permits
  tool-image retirement, then splits historical input under the existing
  depth, call and transaction deadline bounds. It does not submit the same
  rejected payload as a generic network retry.

## Compatibility and validation

No dependency or lockfile changes, public RPC/Host/UI protocol changes, state
migration, transcript deletion, installation, deployment or Host restart.
Existing token admission and genuine-user provenance remain independent guards.
Tests cover exact byte boundaries (including Unicode/escaping/tools), both wire
protocols, native counting, real loopback HTTP, the synthetic 26-to-27-image
boundary, historical duplicate references, local unknown-outcome protection,
413 recovery before output, current-user pinning, summary splitting and no
side-effect replay. Existing paid/live-model opt-in tests are not run.

Rust compilation/tests/strict Clippy and actual business-error compiler mutations
run only on WZU_Server after a source rsync with sensitive files excluded. A
fresh isolated validation subtree avoids stale test files in the shared remote
checkout. Source hashes and full command output are retained in the task's local
validation output directory, not in user session history.

Validated on WZU_Server against the exact source-file hashes:

- `cargo fmt --all -- --check`: passed with Rust 1.99.0.
- `cargo test --locked -j4 -p xharness-context -p xharness-core -p xharness-provider-openai`:
  412 passed, zero failed, two existing paid/live-model opt-in tests ignored.
- Strict all-target Clippy for those three crates: passed (`-D warnings`).
- Actual business-error compiler mutations: 35/35 rejected the intended forbidden
  operations; original bytes restored and positive strict Clippy passed.
- Local architecture checker against master
  `636bf8c5632f8aecd9e6d0902ece37c9ff8ff5a4`: passed. The body fix changed no frozen boundary; the subsequently authorized workflow addition is bound by the compatibility record below.
  Architecture policy/mutation unit tests: 34 passed.

GitHub exact-head CI and independent review are separate merge requirements;
these remote receipts do not replace them. No running installation was changed.

## Strict protected-branch CI aggregate (separately authorized)

The existing branch protection requires a check literally named `CI`. The
workflow name alone did not produce such a job check. The user explicitly
approved adding a real aggregate to this PR; branch protection is unchanged.

The aggregate directly depends on all 16 original workflow jobs, runs with
`always()` so failure cannot silently skip the gate, and validates the exact
nonempty dependency set and native results. Every applicable job must succeed;
only the existing Unix signed rehearsal is expected to be skipped outside a
push to master. Missing, cancelled, failed, timed-out, neutral and unexpected
skipped results fail the aggregate. UI matrix coverage is still enforced by
its original shard and parity gates, not replaced by this aggregate.

PR and master-push runs expose the required `CI` check. Manual dispatch uses
`CI / manual diagnostics`, so it cannot substitute for PR-only native smoke
admission. The seven aggregate regression tests include all dependency mutations
and actual CLI exit-code cases; they run in the aggregate, early UI build and
native Windows validation. Existing job commands, matrix sizes, runner/action
versions and lockfiles are unchanged apart from those additional test calls.
The frozen workflow change has a content-bound compatibility record against
master. Independent approval and independent workflow checks (such as mirror)
remain separate requirements; this gate posts no status through an API.
