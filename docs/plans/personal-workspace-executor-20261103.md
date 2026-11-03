# Personal workspace: native recoverable executor (steps 1–4)

Stack base: `48ef7be90c27de87039bdb315981c2cd8a1959fc` (#433).

## Scope and product status

The opt-in synchronous native port `WorkspacePair` implements cooperative
admission, retained single-file publication, durable restart reconciliation and
bidirectional file convergence/common-base commit. It operates on **two native
owner-created FsServices in one process**. It does not turn a remote URL into a
filesystem capability, mount a remote directory, or certify remote filesystem
locking/fsync semantics. The `cloud` endpoint name is a role, not proof of a
network transfer.

**No cloud sync RPC/SSH transport, UI capability flag, automatic session drain,
session migration, deletion, automatic rollback or preimage GC is enabled.**
Real local-Mac ↔ cloud-Linux transfer is still a separate integration acceptance;
two isolated Linux directories are not reported as that acceptance. Existing
installed App/Host and real workspaces are not changed by testing this port.
Windows explicitly rejects sync admission (ordinary filesystem use remains
supported). macOS requires the native CI results, not Linux inference.

## 1. Admission: cooperating processes, not a universal OS freeze

Each workspace lease uses an independently opened directory FD and nonblocking
POSIX flock. Ordinary FsService write/edit workers hold shared admission inside
the blocking closure, so cancelling the awaiting future cannot release it early.
An exclusive sync lease conflicts across service clones, separately constructed
services and processes on that directory inode. Lock failures retain typed errno;
EINTR gets three bounded attempts, never an unbounded loop. FD close releases the
lock; no fallible/panicking unlock happens in Drop.

NativePlatform retains a shared lease on the **actual session workspace**, even
when FullAccess's filesystem root is `/`. Cached idle sessions intentionally keep
admission busy until their native owner retires them. ProcessRuntime receives an
opaque generic lifetime guard (no new Process→Fs crate edge). Spawn setup and
child supervisors and escaped filesystem service clones retain it beyond
caller/platform drop. Incomplete setup or
aborted/error supervision quarantines that guard until owner process restart and
emits a static diagnostic; it never certifies quiescence from a lost future.

CLOEXEC does not prevent the brief pre-exec FD inheritance window of a
concurrent fork. A nonblocking busy reply is a safe admission failure, not a
content retry or proof of a permanent lock leak. Tests that deliberately spawn
crash subprocesses isolate fixture lifetimes so this unrelated window cannot
invalidate immediate lock-release assertions.

The owner must drain sessions and independently quiesce editors, external shells,
escaped FullAccess descendants, old binaries and other uncooperative writers.
Admission is scoped to the matching workspace inode, not a hierarchical or
global write-authority registry. Parent-workspace tasks and FullAccess sessions
from other workspaces also need owner quiescence. flock does **not** prevent
those actors from writing. No new UI auto-drain promise
or automatic task termination is made. Owner restart after quarantine also
requires checking remaining external writers; it is not automatic recovery.

A durable `.xh-sync-active` fence blocks new cooperating use after failure or
process death. Only an exclusive native recovery owner can finish it. Structured
model writes/edits cannot target reserved `.xh-sync-` components. This is not an
OS security boundary against a same-user shell: workspace control files and
preimages must not be modified externally. Owner-controlled filesystem access is
a trust boundary, not a browser JSON or bearer-token grant.

## 2. Safe file application

Every source and destination precondition uses a whole-file SHA-256 plus native
inode/device/size/mode/link/mtime/ctime witnesses, not the model tool's large-file
sample. A second full read/open must match; links, special files, mount traversal,
foreign/overlapping roots and rebindings fail closed. Persistent witnesses do not contain a
process-local service ID, so restart can reconcile the same native root.

Content streams through bounded buffers (512 MiB/file maximum); it is not a JSON
byte array. New parent directories are created under checked descriptors and
synced. A sibling `.xh-sync-<operation>.new` is exclusively created, full-hash
verified and fsynced. Only its execute-bit semantic crosses platforms; new file
permissions are private 0600/0700. Old ownership, ACLs and arbitrary xattrs are
not represented by the portable manifest.

The controller journals the staged inode witness before publication. Replacing a
file uses two **no-replace** moves:

1. Move the expected old inode to `.xh-sync-<operation>.old`, sync the parent and
   verify its retained full identity.
2. Move the staged inode into the now-absent destination with no-replace, sync the
   parent and verify the published inode/full hash.

This deliberately retains old bytes and refuses a foreign arrival, even with
identical bytes. It is **not** atomic replacement: the destination may briefly be
absent, or remain absent after interruption until recovery. POSIX offers no
arbitrary content-version compare-and-rename primitive. External uncooperative
writes are not claimed to be strongly isolated. Unexpected edits never trigger
unconditional overwrite, automatic fallback, blind retry or successful receipt.

A partial unreceipted private stage is retained as `.partial-<nonce>` and rebuilt
only against the original source witness. A staged receipt is never replaced by
"same content on another inode" after publication. No user content is unlinked.
Retained data is not automatically garbage-collected; disk exhaustion fails the
transaction and keeps recovery fenced.

All internal artifacts are excluded before native opens. Capture policy is
explicitly bumped to `v2-sync-reserved-unicode16-fold-unicode17-nfd`; old policy
bindings cannot silently resume under changed exclusions.

## 3. Durable intent and restart

The native journal binds pair ID, both environment IDs, both canonical root
identities, exact capture policy, old generation/base, complete proposed manifest,
ordered operation IDs and exact source/destination/staged witnesses. A fresh
32-byte OS entropy value names the round. Operation IDs are hashes of that round
and sequence; the same journal is resumed instead of building a fresh plan.

The complete intent is fsynced before any stage, new directory or user-file
operation. A remote-role busy marker fences the other root before effects. Every
private metadata update is temp-file write → file fsync → atomic rename → directory
fsync. Symlink/hardlink/oversized or non-private existing control records fail.
Unknown outcomes remain pending, including errors after a filesystem effect.

Recovery checks the actual destination, staged and retained inodes/full hashes:
not-yet-published, old-retained/new-pending and published-but-unacknowledged are
distinct cases. A foreign inode is not an idempotency receipt. Root/pair/policy/
generation mismatch and corrupted journals are explicit errors, not empty state.

Admission is bounded to 128 changes/round, 512 MiB/file and 16 MiB/control record.
Before the first effect, admission checks the combined file/empty-directory tree
for aliases and reserves inventory entries/metadata/directories for new parents,
stages, retention and private records. It also encodes the worst-case journal including all
stage receipts **and** the eventual base decision. Oversized workspaces/batches
fail without partial application; there is no silent truncation. There is no
claim of transactional rollback across all files: a pending round can contain
already-published files until recovery finishes.

## 4. Bidirectional convergence and durable common base

The existing pure three-way planner compares old common base, fresh local and
fresh cloud-role full manifests. Any conflict blocks the entire batch. **Any
proposed deletion also blocks the entire batch before intent**, including otherwise
safe unrelated changes. New folders containing files can be created; empty-only
directory propagation is not part of the file manifest.

After per-file reconciliation, both roots are freshly captured, compared to the
complete proposed manifest and revalidated. Only then:

1. Persist the same prepared base receipt on both endpoints.
2. Persist the controller's commit decision in its durable active journal.
3. Finalize the cloud-role base, then the local base to that exact decision.
4. Release both busy fences only after both bases are durable.

A crash between the two base writes leaves a durable decision and no successful
completion receipt. Restart finalizes that same decision; it does not resend
content or reinterpret an ahead generation as a fresh base. Release itself is
not distributed-atomic; cloud-role use can resume after both bases are committed
while controller cleanup is still pending. A common base records a verified
point in time, not a claim that external writers can never diverge afterward.

## Acceptance plan / evidence

All Rust compilation/tests/Clippy are remote-only on WZU_Server after rsync of
uncommitted source. The remote run lives under
`~/codex-build/x-harness-rs/runs/personal-workspace-executor-20261103/`.
No package/dependency version or Cargo.lock update is required.

Coverage includes:

- Unicode/nested/binary bidirectional create, executable mode, retained replacement.
- Full hashing outside ordinary tool sample windows; hardlinks/links rejected.
- Both native namespace-move interruption points and foreign arrival in the gap.
- Partial stage retention/rebuild; stable staged inode on replay.
- All eight durable controller checkpoints, including **actual child process exit
  without Rust destructors**, reopened services and recovery from on-disk state.
- Conflict/deletion all-or-nothing admission, changed destination/source tree,
  wrong pair/swapped roots, pending marker and reserved-path model writes.
- Cached-platform/child lifetime admission and aborted-supervisor quarantine.
- Actual isolated LD_PRELOAD flock faults (positive, EINTR-once, repeated EINTR,
  busy, EIO, unknown errno 300), typed errors and FD cleanup; additive Linux CI.
- Existing directory fault probes, architecture content records + mutation suite,
  strict affected all-target Clippy and actual business compiler-negative gate.

Results are recorded outside source in the task's `outputs/personal-workspace-
executor-20261103/`. A plan, successful compilation or Linux directory test alone
is not claimed as production or cross-machine cloud acceptance.

## Gates before product enablement (not claimed by this native port)

- Bind each remote lease/receipt to the authenticated environment and native
  owner root; add bounded binary transfer and lost-reply/disconnect acceptance
  across an actual Mac and Linux endpoint. Never accept browser-selected paths.
- Put authoritative pair registration/journal/checkpoint archives outside the
  model-writable worktree before exposing task-driven automatic sync. The current
  isolated port trusts owner-controlled control files; ordinary shell authority
  can remove them. Both missing base files are only suitable for an owner-created
  new pair, not an inference that previously registered history never existed.
- Add explicit session drain/fencing and observe all wider FullAccess write
  authorities before handoff. Do not interpret this per-root advisory lease as
  global task suspension.
- Retain named committed checkpoint metadata and implement reviewed rollback/GC
  before promising transaction revert or unbounded checkpoint history. Keeping
  preimage bytes alone is not a complete checkpoint/revert API.

These gates keep the UI/Host capability disabled; they are not bypassed by a
passing native test, successful CI, or a plan/prototype screenshot.

## Final pre-commit remote result

WZU_Server acceptance passed: **187 Rust tests, zero failed/ignored, 22 new**.
Actual process-exit recovery passed at all eight durable checkpoints; the full
15-test executor suite passed five additional controlled runs. All six native
flock failure/errno/FD probes (including preserved raw EINTR after retry
exhaustion) and seven directory failure probes passed. Strict affected all-target
Clippy passed. The real business compiler-negative gate passed all **49 cases
across 45 protected files**, then passed its restored-source positive Clippy.
Architecture freeze/content records, 34 architecture mutations, ten CI-tier tests,
fmt and diff checks passed. **767 compile/policy input hashes** matched local and
remote source after validation. Cargo.lock is unchanged.

These are remote isolated native-port results, not a local Rust build, production
Host run, actual network-cloud acceptance or macOS/Windows feature certification.
No installed App/Host was changed; no merge/release or UI flag was enabled.
