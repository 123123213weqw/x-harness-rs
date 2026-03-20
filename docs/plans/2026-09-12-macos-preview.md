# macOS Preview Distribution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an explicit unnotarized Mac distribution option without weakening default releases or updater verification.

**Architecture:** Reuse the existing scope-bound release contract and immutable candidate/promotion pipeline. Derive Mac code-signing policy and native acceptance checks from the authenticated plan; prevent notarized-to-preview feed downgrades.

**Tech Stack:** Python, GitHub Actions, Tauri bundler, macOS codesign, existing native update fixtures.

---

### Task 1: Bind preview policy to the release contract

**Files:** `scripts/desktop-release.py`, `scripts/test-unified-desktop-release.py`.

1. Add failing tests for `all-macos-preview` selecting four platforms, unchanged
   default strict scope, preview manifest labeling and forbidden live Mac downgrade.
2. Run `python -B scripts/test-unified-desktop-release.py`; new cases must fail.
3. Implement `macos_preview(plan)` from the validated release scope, policy-derived
   notes and acceptance check sets. Preview manifests carry
   `macos_distribution: ad-hoc-unnotarized-preview`; normal manifests do not.
4. Validate that marker exactly matches the plan; reject a preview promotion if
   existing Mac entries have no matching preview marker. Preserve all existing
   package/signature/platform continuity tests.
5. Run the suite to green and commit this independent contract change.

### Task 2: Build and verify explicit ad-hoc packages

**Files:** `.github/workflows/desktop-release.yml`, `scripts/desktop-release-build.py`,
`scripts/unix-update-acceptance.py`, `scripts/test-desktop-release-build.py`,
`scripts/test-unix-update-acceptance.py`.

1. Add failing tests: preview permits absent Apple credentials, still rejects missing
   updater signer, default scope still rejects ad-hoc; native checks must verify
   real ad-hoc signatures without claiming notarization/Gatekeeper success.
2. Read scope from the authenticated plan in the signing gate; no unbound boolean
   acceptance override. Configure `APPLE_SIGNING_IDENTITY=-` only for preview Mac
   builds and omit Apple certificates/notarization credentials in that mode.
3. Reuse codesign verification before and after update; return the distinct
   `adHocSignatureVerified` check. Rehearsals use the same verifier but remain
   non-publishable. Missing/invalid code signatures fail, not skip.
4. Add scope selection and warning text to draft creation. Do not mutate any
   staged candidate or existing release.
5. Run `python -B scripts/test-desktop-release-build.py` locally and
   `python3 -B scripts/test-unix-update-acceptance.py` on WZU_Server (Unix imports).
   Run native compilation/testing only in existing CI; commit independently.

### Task 3: Document, integrate and verify

**Files:** `docs/specs/unified-desktop-updates.md`, applicable existing contract tests.

1. Document release input, manual first-open approval, no Apple account requirement
   for ad-hoc, unchanged updater signatures, same feed/identifier/data, and the
   distinction between Mac preview status and normal GitHub desktop Release.
2. Run all affected no-Rust Python/Node release tests, `git diff --check`, and review
   fail-closed behavior (unknown scope, tampered policy/checks, missing signing key,
   accidental notarized downgrade).
3. Commit documentation; push the contribution branch to `yyqdbngt/x-harness-rs`
   and create a PR against `123123213weqw/x-harness-rs:master`.
4. Follow exact PR CI results, including native ad-hoc rehearsal on both Mac
   architectures. Report any unverified first-open behavior explicitly. Do not
   merge/release or replace local software without a subsequent request.
