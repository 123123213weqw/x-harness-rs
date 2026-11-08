# Personal workspace reconciliation: phase 2 core

Status: pure decisions implemented; **no filesystem adapter or UI enablement**.
The separate environment connection MVP is PR #428. Its final head `d18e7d36`
passed 39 checks with 3 conditional skips. This change builds on that head and
does not reinterpret its independent tasks as session migration.

## Implemented contract

`xharness_cloud::workspace_sync` takes a common base, Local scan and Cloud scan:

- Equal ends need no write. A change on just one side is proposed for the other.
- Independent paths merge in both directions. Unequal edits on both sides of
  the same path, including edit/delete or concurrent create, are conflicts.
- Any conflict blocks **all** apply admission, including otherwise safe paths.
- Create/update/delete proposals carry their exact before/after content hashes,
  sizes and executable bit. No timestamp/sample digest substitutes for SHA-256.
- Deterministic identities bind the base, both scans, pair, generation, exact
  Local/Cloud environment IDs and the versioned capture/exclusion policy.
  A changed end or scope invalidates a stale plan, even if a policy update
  happens to produce identical visible files. Persist the base with that scope;
  do not reinterpret an old base under newly chosen capture exclusions.
- The proposed next base is not committed. Both fresh end observations must
  equal that projection before convergence can be acknowledged; partial or
  one-sided completion fails. This check alone is not a durable native receipt.

The module performs no filesystem, transport, credential, Host, Agent, model or
permit operations. A plan cannot be deserialized into an apply capability. All
IO, quiescence, approvals and durable completion remain native adapter duties.
Its source boundary forbids those couplings and inherits the compiler-enforced
business error and unsafe-code fences.

## Capture limitations, not silent exclusions

Unicode names retain their original spelling. Canonical decomposition plus full
case folding detects equivalent names in **each directory component**, not only
complete filenames. Different spellings of the same portable key block capture
or planning; they are never silently normalized, merged or overwritten. This
includes NFC/NFD accents, Hangul, sharp S and Greek sigma. Compatibility folding
is used only to reject Windows device names, not for general filename equality.
The user-approved dependencies are pinned to `caseless = "=0.2.2"` and
`unicode-normalization = "=0.1.25"`. The lock audit confirms exactly these two
new packages and no changes to existing package versions or checksums.
The pinned case-fold table is Unicode 16.0.0; the normalization table is Unicode
17.0.0. These exact table versions are regression-checked, not represented as a
promise of current/future Unicode or native filesystem case equivalence.

This portable check is not certification of every native filesystem's collation
rules. Native adapters must additionally certify both destination filesystems;
unsupported names must fail the entire capture, not disappear. Case/Unicode
aliases, file/directory collisions, case-only renames, traversal, Windows device
names and redirected/unsupported nodes cannot be converted into writes.
The current manifest type represents regular files only; an adapter must reject
symlinks/reparse points rather than follow them or relabel them as regular.

Owner-reviewed capture exclusions must precede manifest construction: `.git`,
`.env`/`.env.*`, environment/auth/credential files, keys and build/dependency
trees are denied if submitted. This filename denylist is defense in depth, not
a general secret-content detector or authority to copy arbitrary workspace data.
Native adapters still require an owner-authorized workspace and exclusion policy.

Bounds: 100,000 files; exact 16 MiB encoded manifest metadata; 512 MiB per file;
8 GiB total per end **and merged projection**; at most 128 path components.
Exceeding a bound returns an
error; no path, file or content is truncated. Counts remain canonical decimal
strings on the wire. Duplicate JSON fields/paths and unknown fields fail closed.

## Verification

- WZU_Server `cargo test --locked -p xharness-cloud --all-targets`: 74 passed,
  zero ignored. The 18 new tests include all 64 three-way content/deletion
  combinations, independent bidirectional edits, conflicts, stale input/scope,
  one-sided/partial completion, mode/binary identity, deterministic round-trip
  and an independent golden digest, malformed/duplicate metadata, path aliases,
  protected paths, quotas and full-hash interior changes in an 8 MiB file,
  Unicode round-trips, canonical/casefold aliases, excessive path depth and
  exhaustive checks for all 11,172 precomposed Hangul syllables.
- Strict remote Clippy passed. No local Rust compilation/check/test occurred.
- Architecture/freeze checker and 34 architecture mutations passed. The actual
  remote compiler-negative guard passed all 42 cases over 38 protected files,
  including this seam; restored-source strict Clippy also passed. Seven compile
  and policy input files were SHA-256 matched between local and remote source.
- The two downloaded crate archives match the exact project lock checksums.
  Native filesystem synchronization and session handoff were **not** tested by
  these pure metadata regressions and remain disabled.

## Still needed before advertising workspace sync

1. Native capture ports with non-following filesystem capabilities, complete
   content hashes, normalization certification and exact workspace binding.
   Invalid UTF-8 names, hardlinks, redirected roots and mount crossings need
   explicit rejection or a separately certified policy, never lossy conversion.
2. Native per-file observed-version apply, explicit deletion/retention policy,
   cancellation, persistent operation identity, partial-effect receipts and
   restart reconciliation. Never advance the base on transport success alone.
3. A durable coordinator that observes and flushes both ends before committing
   the common base, without replaying an unknown write or changing environments.
4. Real Mac/Linux file synchronization and conflict/failure/crash acceptance.
5. Only then enable the Cloud UI sync capability. Keep `workspaceSync: false`
   and `sessionMigration: false` until the corresponding end-to-end gates pass.

## Native session handoff audit

The existing `rpc/export.rs` produces a presentation export and explicitly
leaves full request snapshots in the state-directory audit archive. Existing
`session_import.rs` accepts only Claude Code/Codex transcripts and seeds a new
native session; it is not a native journal restore port. Reusing either would
lose execution receipts, cold tool/Harness archives and attachment ownership.

Same-session handoff still requires native idle admission/quiescence, a complete
portable journal/resource bundle and durable bidirectional execution ownership
with crash reconciliation. UI `running=false`, a successful file plan, or the
existing one-way Prepared/Active/Sealed hosted permit cannot certify that.

## Unicode reference

Canonical caseless matching follows the pinned implementation's
[`nfd().default_case_fold().nfd()` composition](https://docs.rs/caseless/0.2.2/src/caseless/lib.rs.html).
See also the [Unicode normalization FAQ](https://www.unicode.org/faq/normalization.html).

Dependency source review: both added crates have `build = false` and contain no
filesystem, network, process or FFI calls. `caseless` uses a static sorted table
and a bounded two-character expansion queue. `unicode-normalization` is **not
unsafe-free**: its private Hangul helpers use `char::from_u32_unchecked`. The
decomposition caller checks `U+AC00..=U+D7A3`; the arithmetic emits only leading
Jamo `U+1100..=U+1112`, vowels `U+1161..=U+1175`, and optional trailing Jamo
`U+11A8..=U+11C2`. Composition checks the corresponding input ranges and yields
only `U+AC00..=U+D7A3`, below the surrogate range. A regression covers all 11,172
Hangul syllables through the public safe APIs and verifies that both spellings
cannot enter a manifest together. This dependency audit does not weaken the
unconditional `forbid(unsafe_code)` on our decision module.
