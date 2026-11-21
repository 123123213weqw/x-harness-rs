# Project PR and CI badges

The grouped workspace sidebar has an on-demand GitHub badge per registered
workspace. It is independent of the retired Code Review product, model tools,
chat history and background agents. It never merges or edits a PR.

## Data flow and authentication

The browser sends **only a workspace ID** to `github/project-status`. The Host
resolves that ID from its live workspace registry and delegates to its installed
native GitHub backend. Paths, commands, repository names and tokens cannot be
supplied by that RPC. Existing `GitHubBackend` implementations retain a default
unsupported method, so older compositions need not implement this addition.

The existing composition safeguard is preserved: a public non-loopback Host
does not install the local-credential GitHub backend. Such Hosts show unavailable
unless their trusted composition provides a backend; this feature does not relax
that boundary.

The native backend invokes fixed argument arrays without a shell. Git discovers
the current commit, branch, tracked remote and remote branch (falling back to
origin/local branch). `gh repo view --json nameWithOwner` resolves repository
renames; `gh pr list --json` finds candidate PRs; a fixed `gh api
graphql` query obtains the selected PR's head and commit checks. This path never
calls `gh auth token`, login, checkout, fetch, push or a GitHub mutation. It reuses
the **Host machine's** gh authentication, not the UI machine's credentials. No
new dependency, OAuth application or model-tool registration is needed.

First-version remote formats: `https://github.com/owner/repo[.git]`,
`git@github.com:owner/repo[.git]`, and
`ssh://git@github.com/owner/repo[.git]`. GitHub Enterprise, remotes embedding
credentials and automatic cross-fork/base-repository discovery are not supported.
An exact head repository/branch match is required. Detached/unborn/non-Git
workspaces show unavailable; they are not errors indicating a failing CI.

## Freshness and status semantics

- Queries run when the grouped sidebar mounts, a project opens/becomes active,
  the window regains focus, the document becomes visible, or Refresh is clicked.
- There is **no interval, scheduled retry, webhook or remote push channel**.
  A CI finishing while the window stays focused does not update automatically.
  The details panel shows the last query time; it is a snapshot, not a live feed.
- PR state (open/draft/closed/merged) and CI state are independent. Merged does
  not imply passing. No checks is not passing; skipped/neutral checks have their
  own state. Unknown, incomplete, failed or cancelled checks are never green.
- CI comes only from the selected PR head. If local HEAD differs, display the
  commit mismatch instead of reusing an older green check. Git metadata is read
  again after the network query before accepting a ready result.
- Multiple matching open PRs, a full bounded 20-candidate result, or an incomplete
  check page (over 100 contexts) do not produce a green claim. The badge is not a
  merge-admission policy and does not prove that every required workflow ran.
- Opening the badge does not expand/collapse or drag a project. The panel has
  keyboard Escape dismissal, a validated GitHub link and explicit Refresh.

## Ownership, limits and failure behavior

Requests have a single-flight UI lifetime scoped to workspace ID, path and Host
connection generation. Reconnect/replacement/unmount aborts that lifetime;
late responses cannot overwrite another Host or workspace. There is no durable
or cross-account response cache. Hidden documents do not refresh. A failed
refresh replaces, rather than preserves, an old green result.

Native operations share the existing four-operation GitHub semaphore. An entire
project query, including permit wait and child commands, has a 45-second deadline.
Commands have no stdin, capped stdout (1 MiB) and stderr (64 KiB). Cancellation,
timeout or oversized output terminates and reaps the direct child. Diagnostics,
remote error bodies and tokens are not returned or logged. Authentication,
missing CLI, permission/network failure and unsupported old Hosts remain visible
as unavailable/error states; the application does not silently log in or install
anything. Existing session/model execution is unaffected.

## Verification

- Native unit tests cover fixed command sequences, remote parsing, PR selection,
  matching SHAs, local changes, malformed responses, CI aggregation, cancellation,
  actual process timeout/overflow, and workspace-ID routing without model work.
- `scripts/test-project-github-status.mjs` tests the wire parser and request
  lifecycle, including stale disposal and error replacement.
- `scripts/test-project-github-status-browser.mjs` runs the production project row
  in Chromium and WebKit: manual/focus/visibility/open refresh, idle no-polling,
  late Host replies, keyboard/click behavior, dark/narrow layout and cleanup.
  Both browser variants and the contract test are enrolled in the existing CI
  plan; existing workspace business tests and frozen-source expectations remain.
