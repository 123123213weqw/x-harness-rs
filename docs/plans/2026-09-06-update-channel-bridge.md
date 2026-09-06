# Update Channel Bridge Implementation Plan

> Implement task-by-task in this worktree. The referenced superpowers execution skill is unavailable; use the available Code workflow.

**Goal:** Existing signed Windows clients can voluntarily upgrade to upstream-owned updates without trusting an unsigned package or sharing private keys.

**Architecture:** Upstream publishes two independently verified installers (bridge and newer target), both embedding its endpoint/public key. The old repository verifies those immutable artifacts with a separately pinned public key, re-signs the identical bridge bytes with its existing key, and stages a draft release. A maintainer publishes only after native two-hop acceptance. No installed-client or runtime changes are needed.

**Tech Stack:** Node.js, existing Minisign verifier, Tauri signer CLI, GitHub Actions, Windows NSIS.

### Task 1: Contract and negative tests
- Create `scripts/update-channel-bridge.mjs` and `scripts/test-update-channel-bridge.mjs`.
- Test exact repository opt-in, valid increasing Windows versions, different channel identities/keys, immutable URLs, old-key/new-key two-hop verification, corrupted bytes and signatures.
- Run `node scripts/test-update-channel-bridge.mjs`; first observe missing-module failure, then make it pass.

### Task 2: Draft-only orchestration
- Create `.github/workflows/update-channel-bridge.yml` with manual master-only dispatch and no private keys during source download/verification.
- Require source latest public release and exact pinned public key; download and verify both bridge and next installer.
- Sign bridge in a separate step, reverify both signatures and unchanged bytes, create only a new draft with no overwrite.
- Add a lightweight Linux/Windows/macOS contract job to `.github/workflows/ci.yml`.

### Task 3: Review and deployment gates
- Document variables, independent key ownership, channel latest-pointer exclusivity and permanent old-feed retention in `docs/friends-updates.md`.
- Run existing release/updater tests; open upstream PR; require CI success. Rust compilation stays in CI (AGENTS.md).
- Provision upstream signing only after workflow review; never move the fork private key.
- Build upstream packages before switching the old feed. On isolated Windows, verify old installer -> bridge -> newer upstream installer, configuration/session retention, user confirmation and failure recovery. Do not install over the user's active app for this test.
- Do not publish the old-channel draft until these native acceptance results are available. No claim of completion based on signature-only tests.
