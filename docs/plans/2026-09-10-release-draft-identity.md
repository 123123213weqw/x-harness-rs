# Release draft identity implementation plan

**Goal:** Fix draft staging/promotion queries without changing signed binaries, trust keys, feeds, or existing draft assets.

**Architecture:** Capture the numeric Release ID from the authenticated create response. Bind it to the tag and exact source, save staging evidence before uploading, and query that same ID throughout promotion. Preserve full snapshot, artifact, signature and native-acceptance checks.

**Tech stack:** Python standard library, GitHub CLI/REST, GitHub Actions tests.

## Evidence and alternatives

Run 34411893275 built both platforms and uploaded draft 385892062, but the subsequent releases/tags lookup returned 404. Owner-authenticated by-ID lookup succeeds. GitHub documents the tag endpoint as returning a published release, so retrying that endpoint is not a repair. Resolving a same-named draft repeatedly also risks switching identities. Use the creation response ID and verify it thereafter.

## Task 1 — failing regressions

Modify `scripts/test-desktop-release-build.py`. Test draft staging when tag queries are unavailable, exact by-ID URLs, malformed/missing IDs, tag/source/visibility drift, stale metadata or assets, existing tags including later pagination pages, uncertain creation, and upload failures. Run the new tests first to establish failure.

## Task 2 — implementation

Modify `scripts/desktop-release-build.py`: extract testable `stage_draft`, create via REST with draft=true and make_latest=false, refuse existing releases from a paginated inventory, write creation intent and response identity, and add a shared validated by-ID draft lookup. Replace all four published-only draft queries. Do not fall back to a different release on 404 and never automatically retry POST/upload/publication.

Modify `.github/workflows/desktop-release.yml` to export only staging intent/created identity/snapshot on failure; failed staging must still not upload a complete candidate artifact. Update the release specification with the invariant.

## Task 3 — verification and delivery

Run local no-network Python tests (Windows cannot run the existing symlink-privilege fixture); run all Python cases on hosted Linux/macOS CI. No local Rust compilation. Read-only smoke check against the existing draft is permitted, but do not mutate or publish it. Commit with the active GitHub identity and submit a focused upstream PR from a clean master-based branch; PR #45 is already merged.

The blocked 0.2.11 run lacks a successful complete-candidate artifact. This patch does not declare it accepted or automatically recover/overwrite it. Actual release recovery/publication remains subject to immutable source/run and native upgrade gates.
