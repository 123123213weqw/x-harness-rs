# Controlled cross-machine source synchronization v1

Status: opt-in native owner participant and explicit Node coordinator. Not an
installed App update, Web route, background sync daemon or session migration.
No external dependency/lockfile upgrade. Rust builds/tests run on WZU_Server
and the dedicated remote macOS CI job; never on the developer Mac.

## Scope and tools

- OpenSSH authenticates the owner-selected machine and runs an isolated stdio
  participant. Existing host verification, aliases and keys stay unchanged;
  agent forwarding is disabled. The readonly HTTP bearer is not write authority.
- rsync copies only native-selected SHA256-named objects between **private spool
  roots**. It never targets a live workspace or the control store. Names, hosts,
  executable and roots come from native owner configuration, never wire replies.
- The Rust participant owns registration, three-way plan validation, full hashes,
  native exact/inode witnesses, staging, prepare/commit and durable recovery.
- No Mutagen, watcher, public listener, database or new runtime dependency is
  installed. Node is an explicit development/owner CLI requirement, not bundled
  into the desktop app or automatically launched.

Both sides may produce source changes. The owner must drain managed writers and
quiesce external editors before a sync round; this port does not yet obtain task
execution ownership or coordinate the main Host factory. Directory/control
flocks exclude cooperative participants, not arbitrary same-user processes.
Only supported native local macOS/Linux filesystems are in scope. Windows fails
closed; network-mounted filesystems have not been certified.

## Registration and native configuration

Create distinct workspace/control/spool directories. Control and spool must be
owner-private; new spools must be empty. The control root remains outside source
and spool. Provisioning binds a random 256-bit registration to native root
identities. Native `bind` pins both descriptors, pair, epoch and exact capture
policy. No stdio request can provision/rebind a pair or select roots/executables.

Bootstrap writes `pair-init -> base(0) -> pair -> idle`, durably. Replay only
finishes the same incomplete bootstrap; missing earlier records, changed epoch,
root replacement, lost base or old executor format are not a new pair.
Existing `WorkspacePair` registrations are deliberately not imported.

Owner CLI (already-built native binary on the corresponding machine):

```text
workspace_sync_peer provision WORKSPACE CONTROL SPOOL REGISTRATION local|cloud
workspace_sync_peer bind      WORKSPACE CONTROL SPOOL REGISTRATION local|cloud
workspace_sync_peer serve     WORKSPACE CONTROL SPOOL REGISTRATION local|cloud
```

`provision` prints a descriptor. Construct the binding with version 1, pair ID,
nonzero safe-integer epoch, local/cloud descriptors and the exact policy returned
by `workspace_inventory::policy_ref()`. `bind` reads that JSON from stdin; the
native owner explicitly invokes it separately on both machines. The only other
normal mode is bounded newline-delimited stdio, not an HTTP service.

The coordinator's owner-only (0600, regular single-link, no symlink) JSON has:

```json
{
  "sshHost": "WZU_Server",
  "local": {
    "binary": "/absolute/path/workspace_sync_peer",
    "workspace": "/absolute/private/local-source",
    "control": "/absolute/private/local-control",
    "spool": "/absolute/private/local-spool",
    "registration": "64-lowercase-hex-native-registration"
  },
  "cloud": {
    "binary": "/absolute/remote/path/workspace_sync_peer",
    "workspace": "/absolute/private/cloud-source",
    "control": "/absolute/private/cloud-control",
    "spool": "/absolute/private/cloud-spool",
    "registration": "64-lowercase-hex-native-registration"
  }
}
```

Then `node scripts/workspace-sync.mjs /absolute/owner-config.json`. Registration
identities are not API bearer secrets, but the configuration is still private
native authority and must not be model/browser-provided. v1 transport paths are
restricted ASCII absolute configuration paths without whitespace/shell syntax;
**source filenames may contain Unicode**. The process holds all native leases
until EOF. Errors are structured static codes; no payload/raw error logging.

## Durable protocol

1. Both registered idle bases/archives must agree. Capture bounded full-content
   manifests plus native witnesses. The existing pure three-way planner blocks
   all changes on any conflict or propagated deletion. Preflight aliases,
   directories and metadata before intent. Unchanged sync does not create a round.
2. Local intent is durable before peer Begin. The peer independently validates
   the whole pure plan and its own exact capture; neither side trusts a proposed
   manifest as write authority. Both active records fence managed workspace use.
3. Seal source objects under full native witnesses. Receiver admits only needed
   objects and checks capacity/content before rsync. Transfer only hash names.
   The receiver independently hashes each object and stages new bytes through
   descriptor-relative no-follow native primitives. Partial stages are retained
   and rebuilt, never mistaken for a completed write.
4. Both Prepare receipts bind the exact round and native staged witnesses. All
   original user files and expected directories are revalidated. No live user
   file has been published yet (new parent directories/private stages may exist).
5. The local coordinator persists the decision after both prepares. The cloud
   participant durably accepts that same decision before application starts.
   This is **decision-before-publish**, unlike merely wrapping the older
   same-process executor in a transport.
6. Apply rolls forward by recorded inode and full-content witnesses. Existing
   files move to retained `.old` siblings; publication is no-replace. Replays
   observe the original staged inode rather than writing a second copy. A whole
   capture must equal the proposed manifest before Applied is acknowledged.
7. Only after both Applied receipts may either side archive/install the next
   base. Both Complete receipts precede release; cloud releases first, local
   last. Archive/base/active lost replies are idempotently recovered.

No global atomic filesystem switch is claimed. A partition or external edit can
leave a durable pending/decided round requiring owner recovery. A decided round
must roll forward, not be reset or automatically aborted. Recovery first finishes
that exact prior round; its receipt is a committed checkpoint, **not a fresh/clean
claim about edits made after that checkpoint**. A later sync captures those edits.
SSH disconnect is not proof that an unreachable server process stopped; do not
force-delete its journal or claim completion while admission remains busy.

## Builds and retention

A native owner may seal an idle committed cloud participant into a new private
snapshot (`seal_cloud_snapshot`). It returns the existing opaque pinned build
capability; the native build runner reads fixed source and writes artifacts/cache
outside both source mirrors. There is no command execution RPC in this protocol.
The dedicated Linux build probe verifies an actual remote rustc compile/run after
synchronization. The main Host task/terminal/plugin routing is still not enabled.

Initial bounds: 256 source files / 16 MiB total, 128 changed destinations per
round, 4096 scanned entries, 1024 directories, 1 MiB capture metadata, 2 MiB wire
frames, 128 committed generations. Object admission bounds included spool objects
at 512 files / 64 MiB. These are conservative admission guards, not a filesystem
quota against arbitrary external writers or abandoned partial files. Exceeding
bounds fails; there is no truncation or automatic destructive GC.

Transfer is incremental **at file/object granularity** and deduplicates already
verified objects. A new content hash uses a new object name; this does not promise
block-delta reuse for an edited large file. Full scans/hashes remain conservative;
there is no watch/index/cache scalability claim yet.

The fixed capture policy excludes `.git`, `target`, `node_modules`, `.env`, named
credentials, key extensions and reserved `.xh-sync-*` entries. This is not general
secret detection. Builds use a separate explicit cache/output root; arbitrary
project-specific build directories need an explicit future capture policy. Git
metadata is not migrated. A cloud Git repository needs separate owner setup.

Retained preimages and metadata archives are not protected content backups.
Automatic deletion/rename propagation, revert, concurrent Agent execution,
background sync, UI activation and archive/cache GC remain disabled/unimplemented.
Do not represent this bounded owner CLI as seamless product handoff.

## Acceptance

- Rust participant, native byte-stage, metadata-loss, epoch/root, conflict,
  deletion, Unicode/binary/executable and snapshot tests on WZU_Server.
- Actual independent native processes and rsync: normal two-way sync, 12
  controller disconnect boundaries and 10 native process exits before replies.
- Mac native executable built remotely in the dedicated CI job; downloaded and
  run without local Rust compilation. True Mac -> SSH/rsync -> WZU and reverse,
  three actual SSH interruptions, remote apply crash-before-reply, conflict and
  deletion rejection, then native checkpoint-pinned remote Rust compilation.
- Existing architecture/freeze, strict affected Clippy, actual business-error
  compiler mutations, and native directory/flock fault injections remain gates.

Evidence is external to Git in `outputs/workspace-write-transport-v1-20261103/`.
The fault acceptance targets process/network interruption, not a certified
hardware/power-loss recovery matrix. A listed acceptance procedure is not a claim it passed: consult its receipts and
exact commit/source hashes. No merge/release/App replacement is implied.
