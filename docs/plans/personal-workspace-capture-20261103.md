# Personal workspace: native read-only file capture

Status: opt-in native primitive, **not a workspace scanner, synchronization
executor, checkpoint/backup service, or session handoff**. Stacked on the pure
reconciliation core in PR #430, itself based on the connection carrier #428.
No UI capability flags are enabled by this addition.

## Port and invariants

`FsService::capture_file(target, byte_limit)` captures complete binary content,
full SHA-256 and the executable bit through an existing opaque file capability.
`revalidate_capture(target, captured)` reopens and rehashes the current file,
checking private service/target binding, inode/device, size, timestamps, mode and
link count. Capture objects have private construction and no deserializer;
Debug output omits file contents, hash, path and native binding.

- The read is not the filesystem tool's bounded sample, including above 4 MiB.
- Cooperating per-target writers share the existing service lock. Busy targets
  are rejected; capture does not wait indefinitely for that lock.
- Root rebinding, non-UTF-8/oversize paths, symbolic links, nonregular nodes and
  multiply-linked files fail closed. A FIFO is opened nonblocking and rejected
  before reading, so it cannot strand the runtime on a blocking open.
- Linux uses anchored `openat2` with BENEATH, NO_MAGICLINKS, NO_SYMLINKS and
  NO_XDEV (including same-device bind mounts). macOS walks descriptor-relative
  components with NOFOLLOW and checks device crossings. This is not a blanket
  certification of every macOS mount/collation rule; complete capture policy
  and destination filesystem certification remain native adapter duties.
- The final observation compares both the opened handle and a fresh strict
  reopen. Keeping an old descriptor alive is not proof its original name still
  binds it. Replacing a file with identical bytes still invalidates provenance.
- Capture/revalidation never populate the model observation ledger or grant
  later write permission. Existing FsVersion sampling and filesystem tools are
  unchanged. Windows capture is unavailable rather than pretending its path /
  reparse-point / ACL rules have been certified.
- Each call has a hard 512 MiB ceiling and a caller-selected smaller bound.
  Allocation is fallible; an exceeded limit fails, never returns a truncated
  success. Revalidation hashes without allocating a second content buffer.
  A higher-level owner must also bound aggregate memory, concurrency and total
  workspace bytes; do not collect an entire 8 GiB workspace in memory at once.
- The primitive is synchronous and creates no detached worker. An async owner
  must schedule bounded blocking work and observe completion. Cancellation of
  the owner's future is not evidence that such a worker has stopped.

This is a stable observed read, not an atomic filesystem snapshot against all
external writers. Revalidation does not lock a file across a later network
transfer or acknowledge that any destination write has occurred.

## Ownership and exclusions

The caller must apply the owner-approved capture/exclusion policy **before**
using a file capability. The generic filesystem port does not decide whether
an otherwise readable `.env`, credential or auth file may leave a workspace.
Do not mount this port directly as a browser-selected path endpoint.

An individual capture or Missing error is not an authoritative inventory.
Unlisted/missing files must not be interpreted as deletions. A complete bounded
inventory, policy binding and workspace admission are still required before
building a synchronization plan or publishing its common base.

## Verification

WZU_Server final `cargo test --locked -j4 -p xharness-fs -p xharness-cloud
--all-targets`: 104 passed, zero failed/ignored. This includes 14 new native
capture regressions, 16 existing filesystem regressions and 74 cloud-domain
regressions. Final strict Clippy passed for all seven compiler-protected packages.
Actual negative mutations passed 49 cases over 39 protected files; positive
restored-source Clippy passed, and all 39 protected source files plus the two
guard policy inputs are SHA-256 identical to the final source. After a test-only
platform fixture correction, affected tests and protected-package Clippy were
rerun on the final source. Eight compile/policy inputs also match local/remote.
Architecture/freeze and 34 architecture mutations passed.

The native regressions cover full binary/Unicode data, full-hash interior
changes in an 8 MiB file, allocation bounds, zero-length files, immutable bytes,
mode/link/inode changes, foreign capabilities, root replacement, parent/leaf
symlinks, directories/FIFOs, busy admission, post-read replacement and Linux
mount crossings. A non-compiling local Mac OS probe confirmed invalid UTF-8
filename creation fails (EILSEQ); that actual-file fixture is Linux-only.
Full execution of the new Rust capture port on macOS/Windows is a separate CI
gate, not a claimed local Mac result. No dependency or lockfile changes.
No local Rust compilation, installed application replacement, Host restart or
user-workspace synchronization is part of this acceptance.

## Next native gates

1. Complete bounded inventory with explicit exclusions and filesystem-specific
   certification; no silent skipping of unsupported names or nodes.
2. Task/workspace-scoped native admission and durable operation identities.
3. Observed-version apply, retained preimages, explicit deletion policy,
   partial-effect receipts and restart reconciliation.
4. Both-end fresh verification and durable common-base commit.
5. Real Mac/Linux bidirectional synchronization and fault injection. Only then
   enable workspaceSync; native session portability has its own separate gates.
