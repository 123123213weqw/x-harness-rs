# Desktop installation ownership implementation plan

**Goal:** Keep updates in the existing installation, prevent competing writers, and never install while Host shutdown is unconfirmed.

**Architecture:** Preserve the Tauri application identifier and NSIS install directory. Register the official single-instance plugin before sidecar initialization, and independently lock the canonical Host state directory for the Host lifetime. Existing agent leases remain mandatory, including compatibility checks for older Hosts. Never delete a lock file to recover ownership. Do not scan disks or terminate processes by executable name on user machines.

**Tech Stack:** Rust, fs2, Tauri 2, NSIS, PowerShell, GitHub Actions.

The user approved implementation of the four-part design in the conversation. This dedicated worktree and existing upstream PR #26 hold the migration follow-up. Execute locally without subagents; Rust compilation remains on CI because WZU_Server closes its SSH connection. No production feed, signing key, installed application, or user data changes are part of development/testing.

## 1. Cross-platform ownership

- Fix `crates/xharness-agent/src/lease.rs` to classify contention using `fs2::lock_contended_error`, not only `WouldBlock`.
- Strengthen `crates/xharness-agent/tests/inbox.rs` to assert `AlreadyOwned` and successful reacquisition without deleting lock files.
- Add a Host-lifetime state-directory guard before configuration loading or session recovery, rejecting live legacy agent leases at startup as well. Cross-process tests cover aliases, independent state directories and owner exit.
- Commit the independent ownership fix.

## 2. Desktop lifecycle

- Register `tauri-plugin-single-instance` first in `apps/desktop/src-tauri/src/lib.rs`; repeated launch shows/focuses the first window.
- In `sidecar.rs`, do not report stopped or clear the child until termination is observed. Update shutdown must return an error instead of installing after forced/unconfirmed shutdown.
- In `updater.rs`, abort on stop failure, preserve the verified package for retry, and do not launch a second Host for uncertain installer errors.
- Test stop timeout and failed stop gates, update retry state and cross-platform compilation.
- Commit lifecycle changes.

## 3. Installation ownership

- Verify the pinned updater's NSIS directory handling and preserve the actual running installation path.
- Add safe, explicit legacy-install reconciliation tooling: dry-run inventory first, only caller-selected verified installation roots, refuse live processes; fix known per-user shortcuts to the retained installation without deleting data or arbitrary files.
- Test Chinese/custom paths, shortcuts and refusal conditions on an ephemeral Windows runner. Old binaries cannot retroactively obey a new mutex; report and block conflicts rather than claiming they are automatically safe.
- Commit installer and migration changes.

## 4. Acceptance and upstream handoff

- Add native CI checks for repeated launch from different directories, exclusive state ownership and custom-path reinstall with retained data.
- Keep existing signed two-hop acceptance intact. Do not call a normal NSIS reinstall a signed updater acceptance.
- Run local non-compiling tests and formatting; run all Rust tests/builds on CI, inspect failures and update the original upstream PR.
- Document exact passed checks and any remaining release/install acceptance gaps. Do not publish a production release with unverified behavior.
