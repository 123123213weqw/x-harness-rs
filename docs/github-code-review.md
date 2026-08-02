# GitHub Code Review: read-only connection

## Boundary

`Code Review → ClientConnection.rpc('/api', 'github/*', {args}) →
BasicHost GitHubBackend → native NativeGitHub → pinned GitHubReader → pooled HTTPS`.

The feature uses the existing RPC envelope, cancellation, slot registration,
Markdown renderer and native Host executable. Core RpcMethod and Agent tool
schemas are unchanged. No PR mutations, model calls, merging or background
review scheduling are enabled.

Native startup installs this feature only on a loopback listener. Public Host
listeners do not implicitly expose the machine's private GitHub account.

## Current authentication

The native adapter reuses GitHub CLI credentials **on the Host computer**.
Install `gh` and run `gh auth login` there; Code Review's Reconnect reloads the
active account and repository list. The native process captures `gh auth token --hostname github.com --user <account>`
once per RPC (active account for `github/auth`), verifies `/user` and binds an
immutable credential snapshot to that operation. Tokens are not returned by RPC,
logged, saved to frontend storage, persisted by XHarness, or copied to a server. The login is not the browser
GitHub session. macOS resolves Homebrew's usual executable locations when the
Finder launch environment lacks Homebrew in PATH.

This is the local-account adapter, **not completed zero-dependency product
onboarding**. A distributed GitHub App Device Flow adapter still needs a
registered App client ID, device-flow enablement and an OS credential-store
implementation. Do not embed a client secret or pretend `gh` is bundled in the
installer. GitHubReader is the replacement seam; model credential settings must
not own GitHub credentials.

## Read endpoints and limits

- `github/auth`: verified login, source `github-cli`.
- `github/repos`: accessible repositories, 50/page.
- `github/pulls`: open PRs for one repository, 50/page; local title/# filtering
  and "Authored by me" apply to the loaded page set, not a complete account-wide
  search.
- `github/detail`: description, branches, current head SHA, mergeability,
  additions/deletions, first 50 files/comments/reviews, current head's check runs
  and combined commit statuses.
- `github/files`, `github/comments`, `github/reviews`: explicit pagination;
  require the selected head SHA. The maximum page is 60. GitHub's file-list cap
  and unavailable binary/large-file patches are visibly reported.

The first 100 check runs and commit statuses are loaded; a count mismatch is
marked incomplete, never interpreted as all checks passing. Check execution
results are not the complete branch-protection merge gate. Check logs and inline
review-comment bodies are not yet loaded; their existence/count and a GitHub
link are shown instead of fabricated logs.

The adapter issues fixed GitHub API GET routes through a shared reqwest client
(rustls TLS and connection pooling). The only subprocess is the fixed `gh auth
token` credential lookup; no shell or per-endpoint `gh api` processes. Credential
stdout is bounded to 4 KiB, stderr to 16 KiB, timeout 10s; both pipes belong to the
same future. Authorization headers are marked sensitive. No redirect is followed
and request URLs must remain on the configured GitHub origin. Production origin
is fixed to `https://api.github.com`; localhost origins exist only in unit tests.

Each HTTP response is capped at 4 MiB, including streamed/chunked bodies without
Content-Length. HTTP connect timeout is 10s and whole HTTP read is 35s; entire RPC
including permit/credential waits remains 120s. At most four operations and four
actual transports run globally; initial credential/identity verification shares
the transport semaphore too. Cancellation drops HTTP body futures and kills the
credential helper. HTTP status/transport errors never return raw bodies, headers,
stderr or secrets. Auth, permission, rate-limit, missing resource, timeout,
transport and size failures remain distinct. No automatic account fallback.

The native session validates the token's `/user` identity once and answers its
internal before/after identity checks from that immutable verified snapshot.
An external `gh auth switch` cannot change an already running request's credential;
subsequent reads target the UI's explicitly selected account. Reconnect resolves
the current active account anew. A mismatched/expired credential fails visibly;
no stale token is used as a fallback. Credentials are reacquired each RPC, not
cached indefinitely. PR head SHA is still checked before/after reads and current
head checks/statuses are validated. Injected readers without session pinning
retain the original before/after `/user` checks.

There is no backend response cache; bounded front-end warm entries are described
below. There is no credential-copy migration into XHarness's model settings.

Each UI request lane has an AbortController and generation fence. Switching PR
or repository invalidates old success/error replies, including transports that
ignore AbortSignal. Failed refresh retains same-PR last-good data with an explicit
stale marker. New-PR selection never shows another PR's details; it uses only a matching account/head-scoped entry, otherwise shows the listed PR summary while details load. Pagination verifies head SHA;
head changes require refresh. Unknown mergeability/pending/neutral/unknown checks
never render as success. Typed decoders accept unknown transport data only after
runtime field checks; no `any`, ordinary `as` or non-null assertions are used.

## Regression

Local JavaScript/TypeScript only:

```sh
npm run build --prefix ui
npm run check:build --prefix ui
node --test scripts/test-code-review.mjs scripts/test-github-review.mjs
UI_TEST_BROWSER=chromium node scripts/test-code-review-cache-browser.mjs
UI_TEST_BROWSER=webkit node scripts/test-code-review-cache-browser.mjs
```

Rust runs on WZU_Server after syncing the complete current source, excluding
`.git`, `target`, `node_modules`, `.env*`, keys and sensitive files:

```sh
XHARNESS_GITHUB_WIRE_FIXTURE=/tmp/github-wire.json \
  cargo test -p xharness-host-app --lib github_service
cargo clippy -p xharness-host-app --all-targets -- -D warnings
```

Copy only the generated non-secret wire fixture back; then:

```sh
XHARNESS_GITHUB_WIRE_FIXTURE=/tmp/github-wire.json \
  node --test scripts/test-github-review.mjs
```

CI includes both the UI tests and the real Rust-serde → TypeScript wire decoder
check. The test fixture is explicitly not a real PR acceptance result.

## Isolated live acceptance (not shipped authentication)

`github_review_acceptance` uses the actual Host RPC/service/owned UI but no model
tools or personal chat state. `github-review-acceptance-bridge.mjs` invokes the
workstation's existing `gh` login, restricts reads to the public
`123123213weqw/x-harness-rs` repository and returns only login for `/user`.
Private repository entries are filtered from this acceptance-only list.
A random temporary nonce authenticates the loopback bridge; SSH uses loopback
forwarding and **no agent forwarding**. No GitHub token leaves the workstation.
Compile the example on the remote server, not locally. The bridge and SSH session
must both remain running for this temporary page; this does not replace 3184 or
upgrade the installed application. Tests/preview do not merge or publish code.

## Bounded warm loading (2026-10-04)

The client module schedules bootstrap through a cooperative idle queue, without
awaiting it during application mount. It fetches identity, the first repository
page and **only the first repository's PR list**. It may prefetch at most two details from that loaded first page (recently viewed
PR first). It does not walk pages or preload all repositories/PRs. Warmup failure stays quiet; foreground requests retain the
visible error/retry flow. Each opening still verifies the current GitHub account.

- Bootstrap/list freshness is 60 seconds; detail/check freshness is 30 seconds.
  Reads do not renew timestamps. Fresh entries avoid repeat API reads; expired
  entries remain available for up to 24 hours as explicitly stale while refreshing.
  Explicit Refresh bypasses freshness for that request only, not all later clicks.
- At most 3 first-page lists (each estimated <=512 KiB), a <=128 KiB repository
  bootstrap, and 3 LRU details under a combined estimated 2 MiB detail budget live
  in memory. Observed new head SHAs invalidate the old diff immediately. Additional
  pagination pages are not retained in the cache.
- A coalesced IndexedDB snapshot, versioned and limited to an estimated 2 MiB
  UTF-16 JSON payload, survives same-origin browser/module recreation. It contains repository/PR
  data, **never tokens or login credentials**. The browser origin isolates Host
  endpoints. Its account is checked only **after live `/user` authentication**;
  a stored account is not authority to show private data. Permission revocation
  can only be observed on a new server read; freshness is not a permission grant.
  Reconnect/account switch deletes it. Disposal flushes it without deleting it.
- Every restored field passes the same typed wire decoders. Foreign accounts,
  corrupt/oversized/version-mismatched/expired snapshots are discarded atomically.
  Restore generations fence late reads; serialized writes fence pending saves
  against subsequent deletion. The desktop currently uses a new loopback port per
  launch: IndexedDB cannot bridge different origins. Persisting this cache across
  native-app restarts requires a Host/app-data adapter; this change does not claim
  that installed-App behavior. Storage failures/private-mode/quota errors fall
  back to memory. Database work is bounded by a 1-second timeout and closes handles.
- Hover/focus prefetch debounces 350ms and enters the same idle queue with higher
  priority than automatic detail jobs, never the complete repository. A fresh matching detail skips prefetch; stale details can be warmed.
- Selecting a fresh cached PR shows it without an extra detail request. A stale
  cached PR shows immediately with a stale marker and disabled pagination while
  refreshing. Failed network refresh keeps last-good content and a stale warning;
  authentication/permission/account/missing-resource errors clear cached details.
  Cold PR selection shows known title/author/branch before full detail arrives;
  description/diff/checks are never fabricated. The existing aggregated backend
  detail endpoint is unchanged: splitting cold-load sections is not implemented.
- Independent files/comments/reviews/check-runs/commit-status reads run in parallel
  behind a global four-transport semaphore, shared by all four operation lanes.
  Existing account/head fences, bounded collectors, timeouts and cancellation
  remain in place. A failed parallel read drops its siblings; no detached tasks.

The temporary V100 carrier exposed slow uncached static-resource SSH transfer.
The latest acceptance page serves owned static resources locally on port 3242
and proxies API reads to the real V100 Host; this does not change production
loading or authentication. This test-tunnel overhead is not evidence of the
installed native app's startup latency. There is no fixed performance multiplier claim: actual
GitHub latency, response sizes, rate limits and network remain variable.

## Cooperative idle queue (2026-10-04)

- Requires a visible, online document; at least 1.5 seconds without user input or
  foreground GitHub reads; and an idle callback reporting >=8ms remaining. There
  is no forced idle timeout. WebKit without requestIdleCallback uses a deferred,
  frame-budget-measured RAF fallback. This is a responsiveness heuristic, not an
  actual CPU/RSS/network-utilization meter or a global Agent workload controller.
- At most one speculative job is active, with at most six bounded queued jobs
  (normal plan: bootstrap + two auto details + one hover target). No polling.
  Network awaits do not block the UI thread; existing RPC/HTTP bounds remain.
- Pointer/keyboard/wheel/scroll/touch input cancels active speculative reads.
  Foreground GitHub requests increment a shared count and abort speculation before
  entering the RPC. They never await the speculative job. Background work waits
  until the aborted transport settles before launching another background job,
  preventing ignored-abort transports from accumulating parallel work.
- Hiding the document or going offline cancels active work and suspends scheduling;
  visibility/online events can resume the same bounded queue. Cancelled replies
  cannot install data. Account change/reset/disposal clear or stop the queue.
- Rate-limit, auth/permission and network failures stop speculative work with no
  blind retry/polling. A successful explicit foreground read or reconnect reset
  permits future queued work. Missing PR/head-change drops that job rather than
  fabricating data. Foreground reads retain normal visible errors.
- Bootstrap uses a background-only GitHubClient; a separate UI client signals
  foreground acquisition/release in try/finally, including cancellation/errors.
  Neither adds tools, model calls, credentials, RPC methods or backend changes.
