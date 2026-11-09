# Personal environment Gateway v1

Status: opt-in macOS/Linux connection/independent-task MVP. **Not workspace synchronization
or same-session handoff.** The catalogue advertises `workspaceSync: false` and
`sessionMigration: false`; the UI never calls a connection a takeover.

## Invariants

- The original native Host owns models, credentials, journal recovery, tools,
  permissions, receipts and shutdown. The Gateway runs no Agent Loop, changes
  no native execution permit and starts/stops neither Host.
- Catalogue discovery belongs to an optional Connection capability installed
  only by the production wire root. Fixture carriers install none; UI never
  issues its own out-of-band Host HTTP requests.
- Each environment has an immutable upstream and a **different browser origin**.
  Selecting another environment opens another tab; it does not hot-swap the
  current API URL or reuse its session/draft/history/IndexedDB/event generation.
  The current task continues in its original environment.
- Only owner-configured literal `127.0.0.1` HTTP upstreams and loopback listeners
  are supported. Remote Hosts are reached through separately managed verified
  SSH tunnels. No public listener, arbitrary browser URL, proxy discovery,
  agent forwarding or automatic server selection is supported.
- The upstream must enable the existing desktop launch-token boundary. A fresh
  domain-separated identity challenge is verified **before** sending its token
  on each RPC/downlink. A health response cannot substitute for this proof.
- The Gateway uses a separate `xharness_environment` HttpOnly cookie, not the
  installed desktop shell's cookie. Host/Origin/Fetch-Site checks reject
  cross-origin API/WebSocket access. Ordinary root document navigation may
  open another environment tab. This is a single-owner loopback deployment,
  not a multi-user/public authentication service.
- Upstream/model credentials never appear in the catalogue, browser URLs or
  debug recorder. Client cookies/headers cannot replace the upstream token.
  Config/token files must be private regular files, not symlinks. Windows
  deployment fails closed until native ACL validation is implemented. Do not reuse
  a listener origin/ID for a different Host identity or state directory.
- Unary envelopes/RPC IDs and business/transport HTTP status are preserved.
  A failed/uncertain operation returns HTTP 502, `outcome: unknown`,
  `retried: false`; the Gateway never replays it or falls back to Local.
- Event streams retain the existing downlink-only protocol and backpressure.
  Closing the Gateway closes carriers, not upstream tasks. Background accept
  loops and cancellation/cleanup outcomes are observed.

## Start

Build Rust remotely under the repository policy. macOS CI retains
`personal-environment-gateway-macos-arm64` for local no-compile acceptance.
No application replacement or production Host restart is needed.

Prepare two already-running native Hosts, with separate state/workspace
roots and their existing strong desktop launch-token boundaries. Keep model
credentials on their owning Host. Put only the API launch tokens needed for
these explicitly selected Hosts into private token files on the Gateway
machine. For a remote target, create a verified loopback-only tunnel first:

```sh
ssh -N -T -o ForwardAgent=no -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:34001:127.0.0.1:24001 WZU_Server
```

Private JSON config example (substitute real absolute owner paths/ports; no
inline credentials). Give this config and each token file mode 0600 on Unix.
The same Gateway launch token authenticates all its configured environment
origins; keep it distinct from upstream/model credentials.

```json
{
  "version": 1,
  "launchTokenFile": "/absolute/private/personal-gateway.secret",
  "environments": [
    {"id":"my-mac","label":"本机","kind":"local",
     "listen":"127.0.0.1:4185","upstream":"http://127.0.0.1:33080/",
     "tokenFile":"/absolute/private/mac-host.secret"},
    {"id":"my-cloud","label":"云端","kind":"cloud",
     "listen":"127.0.0.1:4186","upstream":"http://127.0.0.1:34001/",
     "tokenFile":"/absolute/private/cloud-host.secret"}
  ]
}
```

Run the built binary with the config path and production `ui/dist` directory:

```text
xharness-environment-gateway /absolute/private/gateway.json /absolute/ui/dist
```

Authenticate once through `/environment/bootstrap?token=<gateway-launch-token>`
on one configured origin; do not publish/log that private launch link. The
redirect drops the token, sets the private cookie and disables referrer/cache.
Thereafter use New Session and the blank-task environment picker. Existing
chat headers show the bound environment without a switching control. Local has no lower cloud strip; Cloud reports native connected/
disconnected state only after the generation-scoped Host handshake. The strip
explicitly says that workspace sync/session transfer are not enabled.

Ctrl-C stops the Gateway. Stop SSH forwards and test Hosts separately. There is
no “stop cloud task” or VM ownership acknowledgement inferred from transport
closure. Installed desktop startup and default Local behavior remain unchanged.

## Required acceptance

1. HTTP + both real WebSockets + session export route to the exact selected
   native Host. Both sides can have identical RPC/session IDs without cache or
   stream contamination. Client/upstream tokens must not leak across boundaries.
2. Invalid identity, bad permissions, duplicate IDs/origins, non-loopback URLs,
   client-supplied credentials and partial listener startup fail closed.
3. Real Cloud model/tool round-trip writes and reads a disposable Cloud file;
   the Mac workspace remains unchanged. A separate test must cover Mac model
   configuration before claiming both environments can generate answers.
4. Create a new chat in a selected environment, retain the source draft, reload an old native session, continue
   its history and disconnect/reconnect without an automatic resend.
5. The production source graph/typecheck, architecture mutations, remote
   compiler-negative mutations, affected tests and strict Clippy pass. Do not
   replace fixtures with false “live success” states.

## Remaining handoff work

The next phase must add an idle-session admission/quiescence boundary, complete
native journal/receipt/attachment/archive portability, workspace base/manifests/
conflict checks and path relocation, and durable bidirectional ownership
receipts with crash reconciliation. It must reject active tools/Goals/children
or unknown outcomes. Existing one-way Prepared/Active/Sealed permits, ordinary
`session.import`, UI `running=false` and presentation checkpoints are not a
substitute for those guarantees.

## Create-only execution choice

A configured Gateway now starts a new chat **before** allocating a native
Session. On the blank new-task page, choose the execution environment, then
choose a workspace belonging to that Host. Workspace/session/model/tool/terminal
traffic stays on that environment's immutable origin. Creating a chat fixes its
backend even when the chat is still empty; existing-chat headers show a read-only
environment label, not a switch menu. The global New Session action returns to
the choice page without creating an unused Session on the previous Host. Direct
Local startup without a configured Gateway retains its existing behavior.

A cross-environment choice opens the registered origin with the navigation-only
`#new-task` fragment. Before connecting, the destination consumes it once and
clears **selection only**, so its last-used old chat is not accidentally opened.
It sends no prompt, imports no history and transfers no draft. Ordinary reloads
without the fragment restore the selected chat in that same environment.

This uses the real Gateway/SSH/Host setup above, not the synthetic UI preview.
A missing catalogue does not enable Cloud, and a failed upstream never falls
back to Local or automatically resends a request. Neither the picker nor the
Gateway provisions servers, installs Hosts, changes SSH authorization or performs
workspace synchronization/session migration. Use a remote workspace that already
exists; source upload remains a separate operation.
