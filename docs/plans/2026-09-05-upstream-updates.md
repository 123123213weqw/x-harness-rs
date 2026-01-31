# Upstream Update Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Submit a tested, opt-in Windows update release workflow to upstream without duplicating PR #21.

**Architecture:** Reuse the existing signed-release scripts, replacing personal
repository constants with explicit repository identity validation. Keep each
repository's secret store, signing key and release channel independent.

**Tech Stack:** Git, GitHub Actions, Python, existing Tauri/Node verification.

---

1. Import only `.github/workflows/friends-release.yml`, `scripts/friends-release.py`,
   and `scripts/test-friends-release.py` from the verified fork implementation.
2. Test missing/mismatched/invalid opt-in identities, version ordering, immutable
   package URLs, and independent upstream/fork channel derivation.
3. Generalize the helper/workflow and remove the dependency on PR #21's UI test.
   Run `python -B scripts/test-friends-release.py` and existing signature/updater
   tests locally; no local Rust compilation.
4. Add the pure test to `.github/workflows/ci.yml`; write `docs/friends-updates.md`
   for upstream maintainers without local machine provisioning records.
5. Commit, push the contribution branch, create an upstream PR and verify its
   diff/base/CI state. Do not enable repository variables, upload secrets or issue
   release tags on upstream as part of this code-submission request.

The user authorized this submission; proceed in this isolated worktree without
subagents. Referenced superpowers execution tooling is unavailable, so use the
available Code guidance and report CI status accurately at handoff.
