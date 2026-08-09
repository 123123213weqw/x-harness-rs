# GitHub Code Review: read-only evidence and model review

## Boundary

`Code Review → ClientConnection.rpc('/api', 'github/*', {args}) →
BasicHost GitHubBackend → native NativeGitHub → pinned GitHubReader → pooled HTTPS`.

The feature uses the existing RPC envelope, cancellation, slot registration,
Markdown renderer and native Host executable. Core RpcMethod and Agent tool
schemas are unchanged. User-initiated, tool-free model review/question requests reuse the configured provider runtime. No PR mutations, merging or background review scheduling are enabled.

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
results are not the complete branch-protection merge gate. Actual threads and Actions jobs/logs are loaded on demand, separately from the first-page detail request. Non-Actions checks keep their native source links.

The adapter issues fixed GitHub API GET routes and read-only GraphQL POST queries through a shared reqwest client
(rustls TLS and connection pooling). The only subprocess is the fixed `gh auth
token` credential lookup; no shell or per-endpoint `gh api` processes. Credential
stdout is bounded to 4 KiB, stderr to 16 KiB, timeout 10s; both pipes belong to the
same future. Authorization headers are marked sensitive. API redirects are not followed automatically and API request URLs must remain on the configured GitHub origin. The job-log reader alone accepts GitHub’s signed HTTPS download redirect to vetted Actions/Azure destinations, resolves and rejects private addresses, and downloads without the GitHub Authorization header. Production origin
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
node --test scripts/test-code-review.mjs scripts/test-github-review.mjs scripts/test-code-review-filters.mjs scripts/test-code-review-structured.mjs scripts/test-code-review-p0.mjs
UI_TEST_BROWSER=chromium node scripts/test-code-review-cache-browser.mjs
UI_TEST_BROWSER=webkit node scripts/test-code-review-cache-browser.mjs
UI_TEST_BROWSER=chromium node scripts/test-code-review-filters-browser.mjs
UI_TEST_BROWSER=webkit node scripts/test-code-review-filters-browser.mjs
```

Rust runs on WZU_Server after syncing the complete current source, excluding
`.git`, `target`, `node_modules`, `.env*`, keys and sensitive files:

```sh
XHARNESS_GITHUB_WIRE_FIXTURE=/tmp/github-wire.json \
  cargo test -p xharness-host -p xharness-host-app --lib
cargo test -p xharness-server --test transport github_review_endpoints
cargo clippy -p xharness-host -p xharness-host-app -p xharness-server --all-targets -- -D warnings
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

## Repository and author controls (2026-10-04)

The compact repository trigger opens a searchable popover, not a native select.
Search matches owner and repository names in the loaded accessible list; it is
not an account-wide GitHub search. Load more remains explicit inside the popover.
The last six selected repositories appear first when present in the loaded list.
The full owner/repository is retained in tooltips and accessible option labels.
Arrow keys navigate, Enter selects, Escape dismisses and restores trigger focus;
outside clicks dismiss without stealing focus.

All / Authored by me is a keyboard-operable segmented radio group, scoped to the
selected repository's loaded open PRs. Changing this filter makes no extra API
request. Repository and author choices use a separate small, validated IndexedDB
record after live account verification. They survive same-account Reconnect and
same-origin module recreation; account switches reset them. They do not survive
changes to the native Host origin/port. Corrupt, oversized or foreign records
fail closed; unavailable storage falls back to memory. No credentials or PR
bodies are stored in this preference record.


## P0 evidence and model endpoints

The frozen HTTP transport accepts `/api/{namespace}/{method}`. Feature endpoints
use two segments; no third-level route or core RpcMethod change is required:

- `github/threads`, `github/thread-comments`: fixed read-only GraphQL, actual
  resolved/outdated state, 20-item thread/reply pages and opaque cursors. Replies
  are fenced to the selected repository, PR and head. Outdated locations cannot
  jump onto unrelated current code.
- `github/runs`, `github/jobs`, `github/logs`: head/merge-test provenance, current
  run attempt, steps, and explicitly requested text logs (2 MiB bound). A rerun
  invalidates an earlier attempt. Truncation and missing access remain visible.
- `github/review-models`: configured model catalog; UI does not carry credentials.
- `github/review-start`: review or a question, pinned account/repository/PR/SHA;
  captures paginated files, description and exact supplied patches. Snapshot
  storage limit is 3 MiB, not a model context definition; over-bound scope fails
  before a paid model request. Binary/missing patches remain explicitly partial.
- `github/review-status`, `github/review-cancel`, `github/review-history`: stream
  projection, cancellation, and persisted initial/final receipts. Live polls omit
  the immutable snapshot; the client reuses its captured copy. Account and target
  fences still apply. Interrupted receipts after Host restart become failures.

The Host uses the existing auxiliary model/provider seam and route TokenGuard,
lowest declared auxiliary reasoning level, tools=[], output reservation up to
8192 tokens subject to the existing budget check. It does not create a new Agent
loop or use repository tools. Optional counting observes the route's existing
transient-fallback policy. No automatic paid retry. One active generation per
account/repository/PR, two globally; 300-second generation deadline and 1 MiB
output/received-reasoning bound. Switching pages stops UI polling, not the review;
reopening loads history and reattaches. Provider/reader/store worker panics are
converted to visible terminal failures and release the live review slot; they
cannot leave a permanent Running receipt in memory. No continuous background reviewer yet.

Review output must end normally and contain one complete JSON envelope. The
owned typed parser then checks fields, diff coordinates and exact evidence,
rejects invalid findings individually, and displays valid ones as **AI findings /
needs confirmation**. Quotes are not proof of a defect. Empty or all-rejected
reports are never approval. Changed/unverifiable head is visibly stale and code
jumps are disabled. Review/Changes/Summary stay in the same page. Questions use
that PR's snapshot independently; this is not a multi-turn chat-memory feature.
Discussion bodies, job steps and log text mount only in expanded sections. Log
text is retained for at most the three most recently opened jobs (each server
bounded to 2 MiB). Explicit Refresh resets discussion/workflow projections even
when the head SHA is unchanged, so completed/rerun CI is not stuck in old UI state.

Native composition writes bounded initial/final receipts under `state/reviews`
using atomic files and hashed account/repository/PR directories; no tokens are
persisted. History returns the latest bounded records (at most 30 runs/16 MiB),
while older receipts remain on disk. There is not yet automatic disk retention.

Controlled DOM regression:

```sh
node scripts/test-code-review-p0-browser.mjs
UI_TEST_BROWSER=webkit node scripts/test-code-review-p0-browser.mjs
```

## Opt-in paid P0 acceptance

`examples/review_acceptance.rs` and `scripts/review-p0-acceptance-relay.mjs`
exercise the actual Host, NativeGitHub and configured OpenAI-compatible provider
stream. Compile only on the remote server after rsync. A fixed public-repository
reader and loopback SSH relay keep existing GitHub/DeepSeek credentials on the
workstation. The relay is an acceptance fixture, not production authentication:
production still uses pooled native HTTPS, not a per-request `gh api` process.
No local app replacement, merge, push, provider-key transfer or private chat read.
Stop the nonce-authenticated relay and its dedicated tunnel after acceptance.
This fixture uses the configured DeepSeek key/model through Chat Completions
with thinking off; it is not a claim of exact installed Anthropic-route parity.
Real results/usage must be recorded separately from controlled passing tests.

## Global assistant instead of PR chat binding

A fixed top-level X entry (Little X / 小 X) opens one normal durable conversation per Host
state directory (`xharness-global-assistant-v1`). The user chooses its workspace
on first use. It reuses the single resident ConversationRoot, input/draft machine,
model selection, history, tools, queue/steer/cancel and ordinary permissions.
Code Review never embeds or associates a conversation with a PR. Creating a PR
no longer records a source-chat receipt. Old conversation histories and legacy
association files remain untouched; they are not read as active links. Retired
`github/chat-get` and `github/chat-set` fail closed. New auxiliary review requests
with the retired `sessionId` argument are rejected before model use; historical
receipts remain readable.

Ask Little X on a PR, a diff line or a validated finding stages a bounded,
commit-pinned reference. Add to draft is explicit, preserves text and attachments,
and never submits. PR descriptions and whole diffs are not automatically injected.
Task overview reads currently listed Host summaries, not message bodies. Its
bounded snapshot may be explicitly shared into the assistant draft; running,
waiting, idle and turn-finished are distinct, not claims of successful completion.
Opening a task returns to its existing conversation; child routing requires the
existing resolved address. Creating a session after the user leaves this page
must not steal their selection. Missing/ambiguous creation responses reconcile
Host metadata and retry the same id, not create another conversation.

This is a unified assistant surface, not a new privileged supervisor. The ordinary
agent tool retains its existing direct-child scope. Arbitrary global chat control,
cloud execution, automatic GitHub writes/merges or background PR polling-to-fix
are not introduced here. Structured read-only PR review remains an independent,
explicitly requested job.

Controlled tests: `scripts/test-global-assistant.mjs` uses the production service
and original input state machine. `scripts/test-global-assistant-browser.mjs`
mounts compiled Layout/CodeReview/Assistant and original normal conversation,
reasoning, tool tree and model controls on Chromium/WebKit with controlled Host
ports. These are not claims of real model or installed desktop acceptance.

### Global assistant acceptance (2026-10-04)

- Strict TypeScript, repository-only build and generated-asset freshness passed.
- 76 frontend unit/contract cases passed. Compiled assistant/full conversation,
  structured review, cache and repository filters passed on Chromium and WebKit.
- V100: Host 212 passed / 6 existing ignored; native adapter 66 passed; Clippy
  all-targets passed. The final retirement test covers both old binding endpoints,
  malformed requests and rejection before backend/model invocation.
- Real Web at local port 3271 (UI here, isolated Host forwarded from V100): the
  assistant was created through the UI and session.list reports exactly one fixed
  assistant id. Its original composer/model/effort controls and real task summaries
  loaded without changing the old task waiting for approval. No model prompt,
  GitHub mutation or automatic merge was submitted by this acceptance.
- Desktop package and the running isolated Host were not restarted. UI retirement
  is visible now; server-side retired-endpoint rejection/source-capture removal
  requires a later Host replacement. Historic data was not deleted.

Evidence logs are local `/tmp/global-assistant-{final-unit,full-browser,final-browser,
final-build,rust,retirement-rust}.log`. Controlled browser fixtures are explicitly
separate from the live-Web check; no installed desktop or cloud execution claim.
