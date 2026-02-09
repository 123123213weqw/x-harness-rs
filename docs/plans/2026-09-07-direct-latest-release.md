# Direct latest Windows release implementation plan

> Execution: use the available executing-plans workflow locally; no subagent delegation or local Rust compilation.

**Goal:** Publish the reviewed Windows fixes as 0.2.4 only after real signed upgrade acceptance, and let supported old clients reach that target in one install.

**Architecture:** Keep full immutable NSIS packages and the existing rolling manifest. Build signed upstream assets into a private draft; test actual 0.2.2/0.2.3 -> candidate installs before public promotion. Permit the old repository to re-sign the identical latest package with its existing key, without relocating secrets, then verify 0.2.0/0.2.1 -> latest before moving the old feed.

**Tech Stack:** GitHub Actions, Node.js, PowerShell, existing Tauri/NSIS updater.

## Tasks

1. Add failing direct-bridge contract tests to scripts/test-update-channel-bridge.mjs. Permit target == bridge while rejecting downgrade; deduplicate asset requests and cover identical bytes / independent signatures. Run node scripts/test-update-channel-bridge.mjs and commit.
2. Extend scripts/windows-migration-acceptance.mjs and its guard tests for a single native hop. Same-channel candidates come from a successful tag release build artifact with pinned public key; old-channel candidates retain the existing bridge receipt checks. Verify version, trust, data, journal, corruption rejection and confirmation. Keep original two-hop compatibility.
3. Make .github/workflows/friends-release.yml stage drafts only. Add .github/workflows/windows-direct-update-acceptance.yml for upstream 0.2.2/0.2.3 and extend the old migration workflow with explicit direct mode. Test workflow guards with node scripts/test-migration-acceptance-guards.mjs and python -B scripts/test-friends-release.py.
4. Submit to upstream, require PR CI, merge reviewed passing code. Push unused friends-v0.2.4 on upstream; inspect signed build artifact and run direct native acceptance plus installation ownership/crash acceptance on disposable Windows. Never install CI candidates on the user's workstation.
5. Publish complete upstream draft only after acceptance. Fast-forward the contribution fork to reviewed upstream code without force, keep its normal release workflow disabled, prepare old-key signature in the old repository, then test both old bases and promote that draft. Compare public manifests/signatures/hashes and report actual supported one-hop paths.

## Boundaries

No private key moves, signature bypass, user data edits or automatic workstation upgrade. Preserve old versioned releases for recovery. No claim of transactional rollback, guaranteed network delivery, zero downtime, or a one-click UI (download and stop/install confirmation remain). A failed native acceptance blocks publication; do not weaken assertions to ship.
