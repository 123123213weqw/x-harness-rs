# GitHub Webhook → project PR/CI refresh (opt-in)

This is a stacked addition to the on-demand project badges. **It does not
resume Agents, send chat messages, grant merge permission, merge PRs, install a
service or configure a real GitHub webhook.** No dependency or lockfile changes.

## Boundaries

```text
GitHub POST (signed raw bytes)
  → dedicated loopback receiver behind an HTTPS reverse proxy
  → fsynced bounded revision ledger (no raw payloads or CI conclusions)
  → authenticated outbound HTTP event stream on the project Host
  → existing host/remote-event downlink, closed invalidation event name
  → visible matching project badge invokes the existing readonly gh query
```

The receiver does not expose `/api`, tools, files, OAuth credentials, arbitrary
RPC or model work. It is **not** attached to the desktop Host router or the mobile
relay. Reuse the existing `hmac`/SHA-256 dependencies in `xharness-server` for
`X-Hub-Signature-256` validation; do not hand-roll crypto or disable TLS checks.

This first version watches GitHub Actions workflow events and PR events; third-party
check-run/legacy-status events are not subscribed automatically.

The project Host still resolves a registered workspace and invokes `gh`. It
adds the stable GitHub repository node ID to ready/no-PR results (old clients
ignore it; new clients accept old results without it). Repository renames do
not break matching. Webhook bodies, PR text, logs, conclusions and supplied SHAs
never become UI status facts or model instructions. A signal merely invalidates
a snapshot; the existing current-local/PR-head gate remains authoritative.

## Operator configuration (not enabled by this PR)

Build `xharness-github-webhook` on the authorized remote Rust build server. Run
it separately behind a trusted HTTPS proxy; it intentionally only binds loopback.
No new listener is started by the desktop, updater, normal Host or default config.

Use independent random secrets (for example 32 random bytes encoded as 64 hex
characters), stored in private regular files, never in a URL or repository.
Configuration and secret files must be absolute, non-symlink regular files;
on Unix they must have no group/other permission bits (`0600`). Windows
operators must apply the corresponding private account ACLs. Paths/contents,
headers and raw transport errors are never logged by this feature.

Private receiver config, for example `/private/github-receiver.json`:

```json
{
  "bind": "127.0.0.1:9447",
  "state_dir": "/private/github-receiver-state",
  "hooks": [{
    "route": "use-a-unique-opaque-route-id",
    "repository_id": 1339214111,
    "secret_file": "/private/github-webhook-secret"
  }],
  "hosts": [{
    "token_file": "/private/github-stream-token",
    "repository_ids": [1339214111]
  }]
}
```

Command: `xharness-github-webhook --config /private/github-receiver.json`.
Expose only this dedicated receiver through your HTTPS proxy. Keep certificate
verification enabled and do not rewrite/decompress the signed request body.
Turn off proxy response buffering for `/github/events`; the receiver also sets
`X-Accel-Buffering: no`. The two routes are:

- `POST /github/hooks/<route>`: GitHub HMAC signature, JSON content type,
  delivery GUID and exact numeric repository ID required. The route ID is not
  authentication. Select `pull_request` and `workflow_run` in GitHub; only
  relevant PR actions and requested/in-progress/completed workflow runs invalidate. Ping/irrelevant
  authenticated events return 204 without changing state.
- `GET /github/events`: separate `Authorization: Bearer …`, not GitHub's token
  or the desktop API token. URL/query tokens, cookies and browser Origin are
  not accepted. Each stream is filtered by that Host token's repository IDs.

Private Host config, for example `/private/github-events.json`:

```json
{
  "url": "https://hooks.example.com/github/events",
  "token_file": "/private/github-stream-token"
}
```

Opt in for a future Host startup with
`XHARNESS_GITHUB_EVENTS_CONFIG=/private/github-events.json`. Ordinary startup
without this variable performs **no event-service IO**. Public/non-loopback
and hosted compositions ignore the opt-in and do not read the secret. The
existing local-credential GitHub boundary is not widened. This PR does not
restart the installed Host to enable it. Config/token changes require a fresh
explicitly authorized startup; authentication/protocol/config failures disable
the connection rather than retrying indefinitely.

Creating the actual repository webhook and deploying the proxy/service remain
separate operator actions. This version provides no automatic registration,
OAuth/GitHub App flow, permission escalation or promise of one-click deployment.

## Reliability, resource and freshness contract

- Every relevant authenticated delivery commits a metadata revision **before**
  204. A separate state-file lease excludes concurrent receiver processes.
  A small atomic write + fsync + rename is used; Unix additionally syncs the
  parent directory. Process-restart recovery is tested; actual power-loss
  durability on every filesystem/OS is not claimed.
- Keep this standalone service on a local durable volume, not the model Host
  reactor or a slow network mount. Synchronous bounded persistence cannot be
  cancelled halfway through a commit. At most 16 requests are admitted, with
  one writer; admission waits asynchronously up to eight seconds. Storage
  failure returns 503, poisons publication and closes event streams, never
  acknowledging an unknown commit as success. Restart validates committed
  state and discards only its known uncommitted pending file.
- At most 64 repositories, 32 live streams, 2 MiB request/state files and the
  last 512 delivery GUIDs per repository. Duplicates inside that window do not
  change revisions. Older replays can cause another readonly refresh, not an
  Agent effect. No event history or full webhook body is retained.
- The stream carries full bounded revision snapshots, not task commands.
  Watch-channel coalescing, latest-snapshot parsing and a one-pending-refresh
  UI lifecycle prevent event bursts building a queue of gh queries.
- Initial connection/reconnection emits one full invalidation. An offline
  Host receives current durable versions and re-reads current state; it does
  not replay every old event. The client checks TLS, disables redirects,
  bounds NDJSON documents to 64 KiB and rejects unknown protocol fields.
- Empty-line transport keepalives are sent after 15 seconds of inactivity.
  A 45-second stalled-read timeout and 1–30 second **receiver reconnect**
  backoff are connection maintenance, not periodic GitHub queries. Heartbeats
  do not invalidate badges. There is no GitHub polling timer.
- Known repository IDs filter notifications; unknown initial identities get
  a bounded recheck so an event during the first query is not lost. A no-PR
  result retains its ID and can update automatically when a PR is created.
  Hidden pages mark dirty and defer work until visible.
- Disconnect cancels in-flight publication and clears old known-project
  badges; manual gh refresh remains available. Connection generation fences
  drop late Host/mux frames, and old row requests cannot overwrite a new Host.
  Live availability is shown separately in the details panel.
  Cancelling an initial lookup also ends its loading state before repository
  identity is known. A manual retry does not wait for the cancelled transport
  to settle; that old request cannot publish a late result or consume the new
  owner's pending invalidation. An idle unsupported/unknown-identity row is
  not replaced with an unrelated connection error.
- **Not an exactly-once event-delivery guarantee.** GitHub-to-receiver delivery
  can fail without the receiver/Host connection dropping, and GitHub does not
  automatically redeliver every failed webhook. Manual/focus refresh or an
  explicit GitHub redelivery is then required. No hidden polling fallback is
  added. The badge remains a timestamped snapshot, not merge admission.

## Acceptance

Native tests use synthetic secrets and isolated loopback listeners: RFC HMAC
vector/tampering, headers/repository binding, duplicate/out-of-order input,
subscriber isolation, bounds, storage failure/restart/exclusive ownership,
actual HTTP delivery → native client → real Host downlink → readonly query,
redirect denial, fragmented/burst framing and no session creation.

Owned-source tests cover closed metadata envelopes, old connection frames,
100 concurrent invalidations coalescing to one follow-up, and disposal. Real
React production rows in Chromium/WebKit exercise push refresh without focus,
repository filtering, no-PR → new-PR, disconnect/reconnect, hidden-page deferral,
Host switch and existing manual/keyboard/layout behavior. Existing frozen
reference, UI controls and strict conversation pixel parity remain intact.
