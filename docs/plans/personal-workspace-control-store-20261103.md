# External workspace control store and read-only machine transport

Status: opt-in native library + isolated acceptance endpoint. **Not enabled in
Host/session switching, the installed app, or the Web UI.** No dependency or lock
update. Rust compilation and native tests run on WZU_Server, not the Mac.

## Authority and lifecycle

Each workspace has a distinct native-owner-configured control directory outside
both paired workspaces. It must belong to the effective user and have no group
or other permission bits; records must be owner-only regular single-link files.
Opening a controlled workspace requires a pinned 256-bit registration identity
and an immutable registration binding both native root identities. A copied or
moved directory, missing registration, lost base or changed root is not a new
pair. No browser/model request supplies these capabilities.

Provisioning the native control root and registering a **new pair** are explicit,
separate owner operations. Incomplete registration can resume only the same
binding and empty generation-zero base; ordinary synchronize never bootstraps
from missing records. Existing prototype worktree records are rejected, not
silently imported. There is intentionally no automatic metadata-loss repair.

`active`, `base`, `prepared`, immutable pair registration and committed round
archives now reside in the external store. Worktree `.xh-sync-active` is only an
old-participant fail-closed hint. Removing or forging it does not clear private
admission. Native workspace users retain shared workspace/control leases; sync
and read export require nonblocking exclusive leases. Cached platforms and live
process supervisors continue retaining their admission guards. The native
executor still requires both filesystem endpoints mounted in the same process;
the new HTTP endpoint does not make that executor cross-machine.

Controlled NativePlatform configuration rejects FullAccess and configured read
roots overlapping the control root, including canonicalized aliases. A Linux
restricted-process regression verifies that a shell can write its workspace but
cannot rewrite the external base. **Owner-only POSIX modes are not isolation
from arbitrary same-user processes.** Advisory locks do not stop old clients,
editors, escaped children or other FullAccess tasks. They must be independently
quiesced/fenced before enabling product handoff. macOS Seatbelt currently blocks
external writes, not general external reads: do not place production credentials
in this store or claim it is a secret vault. The probe token is disposable.

## Checkpoints, not revert

Both stores retain identical immutable committed round metadata before releasing
admission. A round archive includes the prior/proposed manifests, operations,
native witnesses and decision. Missing/different current archives block the next
round. `committed_checkpoint(generation)` inspects both copies without granting
write authority. The temporary bound is 128 generations; reaching it rejects a
new intent without deleting any history.

These are **metadata checkpoints only**. Retained preimage inodes are still in
worktree transaction siblings, not an immutable content-addressed backup store.
An external cleanup can destroy them. No automatic revert, named checkpoint,
archive GC, deletion propagation or durable backup guarantee is exposed.

## Read-only cross-machine acceptance port

`workspace_export` exposes only loopback `/identity`, `/snapshot` and `/blob`.
The native owner pins the workspace/control capability, a fresh random token,
endpoint host and scope. Identity is HMAC-SHA256 with a separate protocol domain,
fresh client nonce and scope, verified before sending the bearer. This supplements
rather than replaces **SSH host verification and tunnel security**; do not treat
a challenge proof as protection against an active credential-relaying proxy.
Browser Origin/Fetch headers, wrong/duplicate Host, proxy headers, duplicate
Authorization and missing/wrong bearer are rejected before body extraction.
There are no cookies, CORS grants, root-selection, pair-registration or apply RPCs.

Snapshots use the existing strict exclusion/path/Unicode/inode/full-hash policy.
Blob reads require the snapshot's exact native witness, length and full SHA256;
changed files, symlinks, hardlinks and excluded paths do not yield bytes. Authority
and admission are rechecked on every read. Responses are `no-store`. This is a
bounded v1 probe: at most 256 files, 4096 entries, 1024 directories, 1 MiB metadata,
16 MiB per-file and aggregate snapshot bytes, 8 KiB request JSON. Exceeding a limit
fails the whole request, not a truncated successful snapshot. Synchronous native
IO uses a dedicated acceptance runtime with no detached workers; integration
into shared Host requires its observed/cancellable native work queue.

The example `workspace_export_probe` creates a new isolated fixture with a
524,299-byte Unicode-path binary and an excluded `.env`. The Node regression
starts only this fixture on WZU_Server and an owned SSH tunnel, verifies identity,
full bytes/hash, exclusions, 401/403 rejection, stale-version 409 and missing apply
route, then observes graceful probe and tunnel exit and removes the fixture.
It never reads existing user credentials or touches an actual project workspace.

Remote preparation (after policy-compliant rsync of current source):

```sh
# WZU_Server only:
cargo build --locked -p xharness-host-app --example workspace_export_probe
```

Then from the Mac (Node only, no Rust compilation):

```sh
node scripts/regression/test-workspace-read-transport.mjs \
  codex-build/x-harness-rs/runs/personal-workspace-control-store-20261103 \
  /absolute/path/to/cross-machine-read.json
```

The remote run directory must exist, and the example must be in the configured
remote `target-personal-handoff` directory. The probe is not a deployment command.

## Remaining product gates

1. Authenticated two-end write protocol, durable prepared/decision replay and
   lost-reply/reconnect acceptance across independent machines/processes.
2. Native pair/config persistence and observed session drain, wider write-authority
   fencing, and end-to-end actual task handoff before exposing the environment UI.
3. Protected preimage/content store, rollback semantics and bounded verified GC
   before promising user-visible revert.
4. Windows native synchronization and platform-specific acceptance. Current sync
   primitives fail closed on unsupported platforms.

Current local evidence is stored outside the repository in
`outputs/personal-workspace-control-store-20261103/`. Publication and GitHub CI
remain separate from remote acceptance; do not infer a published PR from these
local/remote tests.
