# Windows/Linux release implementation plan

> Execute task-by-task using the executing-plans workflow; the user approved implementation, testing and publication in this task.

**Goal:** Publish 0.2.10 for Windows x64 and Linux x64 AppImage without changing Mac channels or weakening release verification.

**Architecture:** Bind an explicit allowlisted release scope to the immutable plan and platform receipts. Derive build and native-acceptance matrices from that plan. Keep the existing full-platform default and reject promotion that drops any currently live stable platform.

**Tech stack:** Python release contracts, GitHub Actions, Node signature tests, remote native Rust builds.

## 1. Scope contract (test first)

- Modify `scripts/desktop-release.py` and test `scripts/test-unified-desktop-release.py`.
- Add `all` and `windows-linux` only; existing plans without scope retain `all` behavior.
- Test two-platform aggregation/promotion, wrong/missing/extra artifacts, scope tampering, omitted native evidence and refusal to remove live Mac entries.
- Run `python -B scripts/test-unified-desktop-release.py`; commit the tested contract.

## 2. Workflow and provenance

- Modify `scripts/desktop-release-build.py`, `.github/workflows/desktop-release.yml`, `.github/workflows/desktop-unix-update-acceptance.yml`.
- Release input selects scope; tag pushes retain `all`. Candidate acceptance derives its matrix from the authenticated immutable candidate, never a separately supplied platform list.
- Selected platforms retain existing signing gates. Rehearsal still tests all Unix targets without production secrets.
- Run `python -B scripts/test-desktop-release-build.py`, `python -B scripts/test-unix-update-acceptance.py` and all release contract tests; commit.

## 3. Delivery

- Update unified release specification; submit upstream PR, require green CI before merging.
- Verify exact master CI, signing configuration and unchanged stable platform inventory. Create immutable `desktop-v0.2.10` tag; explicitly dispatch `windows-linux` build. A tag-triggered full-scope run may fail the existing Apple prerequisite gate and is not a publishable candidate.
- Build both native candidates in hosted CI, retain draft until Windows real installer upgrade and Linux three-repeat native candidate upgrade pass.
- Promote through existing provenance/signature/data-preservation gates; verify public manifest, signatures, hashes and release assets. No local Rust compilation, no user App restart, no private-key movement.
