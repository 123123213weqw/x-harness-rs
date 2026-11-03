# Personal workspace: read-only native inventory

Status: opt-in native foundation, **not bidirectional synchronization or session
migration**. Stacked on the native file capture at
`c1178759709972a30ebbe4edaade630ec28d629e`. Existing tools, model observations,
wire APIs, Host execution/ownership and UI capability flags are unchanged.

## Native boundary

`directory_stream.rs` is a small isolated Linux/macOS POSIX FFI adapter. It uses
the existing nix re-export of libc; no package/version/lock upgrade is involved.
The explicitly approved `nix 0.30.1` dir feature remains enabled, but neither its
leaking `Dir::from_fd` failure path nor its error-swallowing iterator is called.

- OwnedFd remains owned by Rust until fdopendir succeeds. Failure closes it.
- readdir is exclusively borrowed and each native name is copied before another
  read. It clears errno and distinguishes exact raw errno=0 EOF from **every**
  nonzero error, including errno codes unknown to nix's Errno enum.
- All normal read/limit/error paths explicitly close. A close error fails the
  scan; simultaneous primary/cleanup errors retain both typed causes. Never
  retry closedir on an ambiguously closed/reused descriptor. Drop is only an
  unwind guard; its exceptional cleanup failure emits a static secret-blind
  diagnostic, never a successful completion receipt.
- Entry names are byte-preserving, sorted, bounded and checked for duplicates.
  Dot entries are removed explicitly. There is no lossy UTF-8 conversion.

This native adapter retains the same error lint fences as the business seams;
its necessary FFI is not relabeled safe business code. The policy/scanner and
Host composition keep unconditional `forbid(unsafe_code)`. All three new seams
are enrolled in architecture/compiler error guards without weakening any gate.

## Observation, limits and provenance

`FsService::capture_inventory(policy, limits)` synchronously scans the entire
included tree twice. It hashes complete regular files in a bounded streaming
buffer, records file identity/mode/link/timestamps and directory witnesses
(including empty directories), and requires both observations to agree.
`revalidate_inventory` performs a fresh scan against the private native binding.
Bindings include the service, established root witnesses, exact policy identity
and limits; construction/deserialization cannot be forged through metadata JSON.
No worker is detached; an async caller must bound blocking concurrency and
observe its worker's completion/cancellation separately.

Every included node is opened under the established root descriptor. Linux uses
openat2 BENEATH/NO_MAGICLINKS/NO_SYMLINKS/NO_XDEV. macOS walks parent descriptors
with NOFOLLOW, checks device crossings and verifies native paths. This is not
blanket certification of every macOS mount/collation behavior. Windows fails
closed pending its own native directory/reparse/ACL adapter.

Caller-selected limits may only tighten these hard ceilings:

- 100,000 enumerated entries (including excluded names), 100,000 regular files,
  10,000 included directories including root;
- 16 MiB accounted native metadata, plus the pure domain's separate exact
  16 MiB serialized file-manifest limit;
- 512 MiB per file, 8 GiB total included content, depth 128;
- relative paths 4096 bytes and individual components 255 bytes.

Limits fail the whole operation, never return a truncated inventory. Included
symlinks, hardlinks, FIFOs, unsupported names/nodes, mount crossings, root/path
rebinding and observed changes fail rather than being silently omitted. The
capture hashes up to two full content passes (plus another for revalidation);
it retains metadata, not whole-workspace file contents in memory.

This is **not an atomic filesystem snapshot or a write lock against external
programs**. A later executor still needs native workspace/task admission,
quiescence and observed-version CAS. Two matching observations do not prove no
writer changed the tree immediately afterward. Missing/failed/partial scans may
never be interpreted as deletion, a common-base commit or completed transfer.

## Fixed personal policy and domain composition

The pure cloud module exposes the existing portable-path/exclusion classifier;
manifest construction still rejects excluded paths. Native Host composition
applies that fixed policy **before opening each child**, pruning .env, key/auth
files, VCS/build/dependency trees and the other existing explicit exclusions.
Unsupported names fail. This filename policy is not a content-based secret
detector or permission for arbitrary browser-selected roots.

The domain additionally checks Unicode/case aliases and file/directory
collisions across included paths, including empty directories. Original native
spelling is preserved for I/O. Existing file manifests/plans keep their wire
format and rules. Directory witnesses are available from the captured native
object, but the current sync manifest represents regular files only: this does
not implement empty-directory creation/deletion, xattr/ACL transfer or special
node synchronization.

`capture_workspace_inventory` returns the validated pure manifest together with
private native provenance and a fixed versioned capture-policy reference. It
can feed the existing three-way planner; neither the native object nor the
resulting plan is an apply lease or grants a model observed-write permission.
There is no RPC exposure, automatic scan, watcher, browser permission change,
common-base persistence, write/delete executor or session import/export here.

## Verification

All Rust builds/tests run on synchronized current source on WZU_Server, never
on the Mac. Native regressions exercise Unicode/binary content, full interior
hashes above the old sampling threshold, mode/inode/addition/deletion changes,
between-pass mutations, policy identity changes, native binding rejection,
root rebinding, symlinks/hardlinks/FIFOs, limits, non-UTF-8 Linux names and Linux
mount crossings. Composition tests cover pre-open exclusions with dangling
secret symlinks, empty-directory/case/Unicode alias checks, unchanged model write
admission and two real fixture trees feeding a three-way plan **without apply**.

`test-directory-inventory-guard.py` runs only on remote Linux/CI. It builds an
isolated fault shim, locates the exact Cargo test executable and executes one
positive plus six negative native subprocess probes: fdopendir ENOMEM, readdir
EIO, EACCES, unknown errno, close failure and read+close failure. Tests require
the original typed OS error, no successful EOF/partial result and unchanged
process FD counts. The shim only targets temporary fixture directories and is
never loaded into a Host/Gateway or installed app. Linux CI runs this guard and
uploads its evidence in addition to existing tests and compiler gates.

Detailed final receipts are retained in the task output directory
`personal-workspace-inventory-20261103`. macOS/Windows runtime status must be
reported separately from Linux verification; neither merge/release nor enabling
workspaceSync/sessionMigration is authorized by completing these local gates.

Final pre-commit Linux acceptance: 127 passed, zero failed/ignored (23 new
regressions), all seven native subprocess probes, strict affected Clippy and
49 actual compiler-negative cases over 42 protected files passed. Restored
all-target Clippy passed for all seven protected crates. All 57 compile/policy
inputs match local/remote. The non-compiling local format/architecture checks,
34 architecture mutations and 10 CI-tier contracts passed; Cargo.lock is
byte-identical. Initial diagnostic failures were resolved before this final
run: Host App's thiserror is test-only (use standard Error/From instead), and
process-wide FD counts are asserted in isolated single-test subprocesses rather
than against unrelated parallel tests opening their own descriptors.
