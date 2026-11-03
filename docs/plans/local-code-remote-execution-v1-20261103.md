# Local code / remote execution v1: native policy and build port

## Delivered scope vs product activation

This change implements an **opt-in native policy/build port**, not a completed
cross-machine workspace service. It does not modify an installed Host/App,
turn the current conversation into a cloud task, or enable automatic file sync.
Gateway can publish the owner-configured desired preset, but its state is always
`pending`, and `workspaceSync` / `sessionMigration` remain false. No executable,
root, environment URL, credential or command can be selected via this UI metadata.

The fixed profile is `local_code_remote_exec_v1`: code is mirrored by the existing
source-only reconciliation policy; processes belong on the remote Linux side;
cache/dependencies are execution-local; artifacts are explicit reads, never a
mirror of the entire build tree. Native adapters, not enum deserialization,
establish actual environment authentication and filesystem authority.

## Local enforcement

`PlatformConfig::local_code_only()` allows structured workspace filesystem
access but refuses process preparation, launch, readiness probing and terminal
preparation. FullAccess is rejected rather than widening file authority.
`ProcessRuntime::without_execution()` is a monotonic per-instance gate: raw
launcher consumers and clones retain it, including calls outside a Tokio runtime.
There is no shell-command classifier or hidden SSH/local compilation fallback.
Existing platforms remain unchanged unless their native owner opts in.

**This is not a global OS/App execution prohibition.** Independent terminal
registries, plugins, other Hosts and FullAccess tasks are not magically fenced by
one NativePlatform. The normal product ToolFactory and terminal routes do not yet
activate this profile. Integration must bind every execution port to the verified
remote adapter or deny it, before making the UI preset active.

## Versioned source snapshot

`WorkspacePair::seal_cloud_snapshot` requires two idle, explicitly registered
native endpoints with equal committed bases and verified committed archives.
The source mirror must exactly match that base, not merely have the same mtime or
Git HEAD. An unpublished private destination must be empty and non-overlapping
with both workspaces and control stores. Existing strict exclusions, portable
Unicode names, no symlinks/hardlinks and complete-content verification apply.

A successful return creates an opaque `PinnedWorkspaceSnapshot` retaining an
exclusive native admission lease, the source manifest and a nonzero pair /
generation / digest checkpoint. Failed copying never publishes this capability.
The v1 bound is **256 files, 16 MiB total source bytes**; oversize captures fail as
a whole. Empty directories are not build inputs. This is deliberately not an
arbitrary-size production repository exporter.

Multiple builds may reuse the same pinned snapshot capability. Local edits can
continue against the source mirror while an older snapshot builds; results keep
the original checkpoint. `BuildCheckpoint::is_current` compares committed pair/generation/digest labels
only. Matching a committed label does NOT prove a live worktree has no unsynced
edits. A future staleness UI must obtain native current/dirty observations, not
use this pure equality helper as a filesystem freshness certificate. Receipts
keep their original checkpoint and no active/fresh diagnostic claim is exposed.
Source validation is still conservative and rehashes; no incremental watcher,
trusted hash cache, reduced-pass capture or zero-overhead claim is made here.

## Remote native build execution

`RemoteBuildRunner` is Linux-only native owner composition. It requires distinct
private journal/cache roots, a pinned environment and nonzero execution epoch.
Provision is explicit and only accepts an empty journal; open validates immutable
registration/root identities. Replaced/lost state is not silently recreated.

The native owner supplies the executable, argv, clean environment, timeout,
read-only toolchain roots and selected artifact list through `NativeBuildCommand`.
No browser command DTO or execution RPC is added. The builder uses NativePlatform
with the cache as its writable workspace and the snapshot as a read-only root.
Source/control trees cannot be selected as cache/journal/read-root expansions.
The existing restricted native sandbox remains mandatory, with no FullAccess
fallback. The timeout is at most 600 seconds and each captured stream at most
64 KiB. Journal capacity is bounded to 64 complete jobs; no implicit GC/reset.

The existing Linux sandbox mounts the native root read-only and provides a
private `/tmp`; it **does not deny all external reads**. Thus this is not a
hermetic/reproducible build or credential vault. Checkpoint identity covers the
synchronized source, not all system headers, external dependencies or mutable
toolchain contents. Arbitrary same-user external writers must still be quiesced.

The durable job intent binds job/environment/epoch/checkpoint and the complete
native command configuration digest before process launch. Duplicate requests
return the recorded receipt or `OutcomeUnknown`, never start another process.
A durable active marker rejects another job after uncertain completion. Completed
lost replies can be inspected and explicitly finalized without executing again.
Unknown intents need explicit owner investigation; there is no unsafe "retry"
button. This is not yet a durable detached cloud-job supervisor or live reconnect
stream API.

Cancellation/timeout waits for native process-tree/output drain. Snapshot and
cache admission guards are appended together and retained in the native
supervisor even if its caller drops/aborts the build future. They are not replaced
by an unrelated extra guard. Source is checked again before recording a result.

## Artifacts and cache

Only owner-selected relative paths under `artifacts/<job hash>/` are recorded.
Missing artifacts are acceptable only for unsuccessful builds; this does not
acknowledge a transfer. A later explicit artifact read must match the recorded
native version, size and complete SHA256, with a 16 MiB file limit. A changed
artifact or arbitrary cache path fails. Neither build caches nor dependency
folders are synchronized into either source mirror. There is no automatic local
execution of a downloaded Linux binary.

## Acceptance and limitations

Rust compile/test/Clippy run on WZU_Server only, after policy-compliant rsync of
current source. The Linux integration suite performs a real `rustc` compile from
the read-only checkpoint and executes its binary on the server, reads the selected
artifact via the native port, then rejects a changed artifact. Optional evidence
is written only to the explicitly selected remote `CARGO_TARGET_DIR` subdirectory.
An explicitly requested artifact can then be downloaded from that remote target
and SHA256-verified on the Mac without compiling or executing it there.

Tests also cover local raw-launcher denial, readonly source protection, edits
while an older version builds, timeout, caller abort/guard lifetime, unknown
intent, epoch/registration loss, lost final reply, real process exit at intent
and completed-result boundaries, nonempty snapshot rejection, and repeatable
bounded native directory counting. Gateway/TS tests retain the exact legacy
catalogue and reject attempts to forge an active preset, fallback, sync or
migration capability.

Before product activation still required: authenticated independent-machine
bidirectional apply and disconnect recovery; native persistent pair/task routing
with every execution port fenced; source snapshot/index scaling and benchmarks;
version-aware diagnostic navigation and live job streams; reviewed artifact/cache
retention and quotas; macOS/Windows certification. The existing Web conversation
and installed Host are deliberately left unchanged.
