# Cross-platform release checksum ordering implementation plan

> Execute task-by-task with the executing-plans workflow. The user approved repair and actual Windows/Linux publication in this task.

**Goal:** Make a Linux-generated signed release inventory verify unchanged on Windows and resume formal publication.

**Architecture:** Sort checksum entries explicitly by case-sensitive filename rather than OS-dependent Path comparison; emit LF bytes on every platform. Keep exact inventory, file hash, receipt, signature and immutable source checks. Reuse the shared release pipeline, caches and native acceptance; do not replace failed evidence or mutate existing drafts.

**Tech stack:** Python standard library, Node signature verifier, GitHub Actions native runners.

## Evidence and alternatives

The real 0.2.12 artifact has nine matching file hashes. Linux Path sorting puts uppercase XHarness filenames before metadata; Windows Path comparison puts them last, causing acceptance run 34417226316 to fail before installation. Explicit filename ordering is preferred to ignoring checksum order (would loosen the canonical inventory) or rewriting downloaded manifests (would change immutable candidate bytes).

## Task 1: Fixed cross-platform regressions

- Modify `scripts/test-unified-desktop-release.py`: fixed mixed-case filename/hash fixture; exercise both PurePosixPath and PureWindowsPath comparison independently of the host OS; check generated checksum bytes are LF; retain tamper/missing/extra file rejection.
- Run `python -B scripts/test-unified-desktop-release.py ChecksumTests` before implementation and record failure.

## Task 2: Minimal shared fix and verification

- Modify `scripts/desktop-release.py`: `sorted(Path(root).iterdir(), key=lambda path: path.name)` and write checksum text with `newline='\n'`.
- Run full unified release tests, orchestration regressions and Windows acceptance contract tests locally (no Rust compilation). Run the patched full verifier read-only against the unchanged real 0.2.12 candidate; do not reinterpret this as formal native acceptance.
- Commit with active gh identity; push focused upstream PR. Require hosted CI before merge and exact master CI before tagging.

## Task 3: Formal delivery

- Create fresh immutable desktop-v0.2.13 at verified green master; never retag 0.2.12 or overwrite its draft assets.
- Dispatch windows-linux signed build, then Windows and Linux formal candidate acceptance in parallel; reuse existing workflows and caches.
- Require exact successful native receipts, promote using desktop-promote.yml, verify public latest.json and packages. No Mac publication, old fork feed/key changes, or local App replacement.
