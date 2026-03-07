# Installer Shortcut Backups Implementation Plan

**Goal:** Stop leaving shortcut recovery files on the Windows desktop and migrate verified legacy backups without losing recovery data.

**Architecture:** Keep shortcut copies in per-user LocalAppData, grouped by destination version and a digest of the original path and content. Reconcile the active shortcut first, then archive only its verified sibling legacy backup. Preserve custom, corrupt, redirected, orphaned and unverified files. Do not change binary retirement, installation directories, signing, feeds or session data.

**Tech Stack:** Windows PowerShell 5.1/7, existing Unicode Shell Link COM helper, Node contract tests, native Windows CI.

## Design decisions

- Hiding desktop backups still leaves clutter; deleting them outright loses recovery. Use a dedicated recovery directory instead.
- Retain verified recovery copies (deduplicated per version/path/content), with original-path metadata; no automatic age-based deletion in this change.
- Only migrate a legacy sibling after the current shortcut points to the verified new executable. Missing/custom/corrupt targets are left alone. Known retired installations may be identified using their retained desktop binary's product metadata.
- Copy and verify before removing the exact legacy file. Any migration failure retains the source and emits a warning; inability to back up an active link stops reconciliation before rewriting it.

## Task 1: Regression tests

Modify `scripts/test-install-ownership-logic.ps1`: isolate the backup root in the fixture; cover no adjacent backup, migration, deduplication, original-path metadata, preservation of unknown/custom/corrupt files, recovery after failure and redirection refusal. Run against an existing release desktop binary with both Windows PowerShell 5.1 and PowerShell 7; do not compile Rust locally.

## Task 2: Installer implementation

Modify `apps/desktop/src-tauri/windows/install-ownership.ps1`: validate recovery paths; archive with SHA-256 and metadata; replace adjacent shortcut copies; migrate validated legacy siblings after successful shortcut repair. Extend the existing contract assertions to permit only the specific verified, non-recursive legacy-file removal.

## Task 3: Verification and delivery

Run `node scripts/test-install-ownership-contract.mjs`, `python -B scripts/test-windows-desktop-bundle.py`, and both PowerShell variants of the fixture regression. Existing CI already executes the fixture and native Windows installation tests. Submit an atomic fix to the upstream repository via the contribution fork; do not publish or replace the user's installed App.
