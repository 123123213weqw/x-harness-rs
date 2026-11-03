# Personal workspace: directory feature evaluation

Status: **compile-time feature enabled, no production directory scanner added**.
This is stacked on the read-only file capture implementation at
`c1178759709972a30ebbe4edaade630ec28d629e`. The user explicitly approved trying
the existing `nix` dependency's `dir` feature. No installed application or Host
was replaced/restarted, and neither workspaceSync nor sessionMigration is enabled.

## Minimal dependency change

Only `crates/xharness-fs/Cargo.toml` changes from `features = ["fs"]` to
`features = ["fs", "dir"]` for its Unix dependency. The selected version stays
`nix 0.30.1`; its `dir = ["fs"]` feature adds no packages. The project
`Cargo.lock` is byte-identical (SHA-256
`3e01630ffa4b2b2226826cd544354928d98b6e1d8337d12706a7a1bce12915e5`).
No production Rust source, filesystem permission, RPC, write/delete path or UI
capability changes. A content-bound architecture record covers the manifest.

## Native audit findings: not a complete-inventory certificate

The exact cached dependency source was inspected, and an isolated Linux probe
was compiled/executed on WZU_Server. Its authoritative `audit-locked-*` evidence
uses the **same registry versions and checksums as the project lockfile**:
nix 0.30.1, libc 0.2.189, bitflags 2.13.1, cfg-if 1.0.4 and cfg_aliases 0.2.2.
An earlier exploratory probe resolved newer transitive dependencies; it is not
the lock-matched acceptance evidence. Neither probe altered the project lock.

1. **Normal descriptor ownership works in the tested case.** Open a directory
   with O_DIRECTORY/NOFOLLOW/CLOEXEC, consume its OwnedFd in `Dir::from_fd`,
   rename that directory and put a replacement at its old path. Enumeration
   still sees the original directory, not the replacement; dropping Dir closes
   its descriptor. This does not prove the original path still names it, prove
   a stable inventory, or eliminate the need for fresh root/path validation.
2. **Failed conversion leaks its descriptor.** Intentionally pass an owned
   regular-file descriptor to `Dir::from_fd`. It returns ENOTDIR, but the
   descriptor remains open, verified through `/proc/self/fd` and explicitly
   closed by the isolated probe. In this version `from_fd` calls `into_raw_fd`
   before `fdopendir`, without closing the raw descriptor on the failure path.
   Its documentation claiming error-path closure is not sufficient evidence.
3. **A directory read error can appear as successful EOF.** Preload a tiny
   `readdir64_r` fault shim into **only the isolated probe subprocess**. It
   returns EIO with a null result pointer. `dir.iter().next()` returns None,
   not Some(Err). The dependency passes the positive errno return value into
   an error helper designed for the -1 convention, then treats the null result
   as end-of-directory. The injected error is deliberate; this is not a claim
   that the live host filesystem experienced EIO.

Probe outputs:

```json
{"case":"normal","original_handle_retained":true,"replacement_not_read":true,"fd_closed_on_success":true}
{"case":"invalid_fd","returned_enotdir":true,"fd_still_open_after_error":true}
{"case":"injected_read_error","saw_error":false,"saw_eof":true}
```

These are Linux execution results, not macOS/Windows runtime certification.
All probe operations touched newly created temporary fixtures, not user files;
the fault shim was never loaded into a Host, Gateway or installed application.

## Next implementation boundary

Keep the feature unused by production until error-path descriptor ownership
and truthful enumeration errors are resolved in a separately tested native
adapter or an explicitly approved dependency change. No silent dependency
upgrade or compiler/architecture-gate exemption is authorized by this toggle.
Do not assume `collect::<Result<_, _>>()` fixes errors that the iterator has
already misreported as EOF. Do not accept an incomplete traversal as a complete
manifest, infer absence/deletion from it, or publish a new synchronization base.

The future adapter still needs descriptor-anchored child access, root and device
checks, byte-preserving names, explicit exclusions before reads, bounds and
mutation detection. Enabling this Cargo feature alone implements none of those.

## Verification scope

On the synchronized changed source, WZU_Server's affected filesystem/cloud
tests pass: 104 passed, zero failed/ignored. Strict filesystem Clippy passes.
All 49 actual compiler-negative cases over 39 protected sources pass, with
restored-source strict all-target Clippy passing for all seven protected crates.
The local formatting check, content-bound architecture gate and 34 architecture
mutation tests pass. Rust compilation and the isolated native probes ran only
on WZU_Server, never on the Mac. Failure-path findings remain unresolved and
block production inventory acceptance despite these existing regression passes.

Detailed source, locks, native probe results and compiler-gate evidence are
retained in the task's `personal-workspace-dir-feature-20261103` output directory.
No merge, release or actual workspace synchronization is part of this trial.
