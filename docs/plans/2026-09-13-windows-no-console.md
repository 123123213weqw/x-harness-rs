# Windows non-interactive process launch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the existing GUI desktop fix together with console-free non-interactive Windows tools, including the restricted-token runner.

**Architecture:** Continue upstream PR #70; do not duplicate it. The desktop uses the existing release GUI subsystem setting, while tauri-plugin-shell 2.3.6 already starts the standalone console Host with CREATE_NO_WINDOW. Add CREATE_NO_WINDOW alongside CREATE_SUSPENDED at the shared tool launcher; the restricted-token child inherits the runner's headless console. Preserve explicitly supplied pipes, Job ownership, cancellation and the separate ConPTY terminal implementation.

**Tech Stack:** Rust, Win32, PowerShell native fixtures, Node source contracts, GitHub-hosted Windows CI.

---

### Task 1: Add regression coverage

Files: `scripts/test-install-ownership-contract.mjs`, `scripts/fixtures/windows-no-console.ps1`, `crates/xharness-process/tests/windows_process.rs`, `crates/xharness-sandbox/tests/windows_acl.rs`.

1. Add a shared synthetic PowerShell probe using GetConsoleWindow; fail if a console HWND exists. Do not infer window visibility from GetConsoleProcessList: a headless PowerShell may still report internal membership. Emit distinct UTF-8 stdout/stderr markers and exit 17 to verify redirected streams/exit status.
2. Run that probe through both ProcessRuntime and WindowsAclSandbox, with a bounded timeout and isolated temp workspace. Never use production files or models.
3. Add source contracts for the combined flags; run `node scripts/test-install-ownership-contract.mjs` before the implementation and record the expected failure. Commit tests.

### Task 2: Implement the missing flags

Files: `crates/xharness-win32/src/suspended.rs`, `crates/xharness-win32/src/lib.rs`, `crates/xharness-process/src/lib.rs`, `crates/xharness-win32/src/restricted_process.rs`.

1. Re-export the native CREATE_NO_WINDOW constant for the shared safe launcher.
2. Use `WINDOWS_CREATE_SUSPENDED | WINDOWS_CREATE_NO_WINDOW` in ProcessRuntime.
3. Keep `CREATE_SUSPENDED` alone in CreateProcessAsUserW, inheriting the runner's headless console. Keep STARTF_USESTDHANDLES and pre-resume Job assignment intact. Native CI rejected both attempts to change console state at this inner boundary: CREATE_NO_WINDOW failed with STATUS_DLL_INIT_FAILED (0xc0000142); DETACHED_PROCESS returned zero without executing PowerShell scripts. Both broke pre-existing ACL tests. Never bypass restricted tokens or ignore those tests to obtain a green run.
4. Re-run source contracts and `cargo fmt --all --check` (formatting only locally); commit the implementation.

### Task 3: Verify and update the existing upstream PR

1. Push only PR #70's branch; no tag, release, main merge, updater changes or local reinstall.
2. Windows CI runs native process/sandbox regressions, existing timeout/tree-cleanup and ConPTY tests, builds the desktop installer and checks the extracted desktop PE subsystem is GUI (2), Host remains CLI (3).
3. Run cross-platform source contracts locally. Rust compilation/tests stay remote/CI per AGENTS.md. Inspect CI results; report failures accurately rather than marking a queued run as passed.
4. Diagnostic release builds with symbols use release GUI behavior. Developer cargo-debug builds retain their existing deliberate console. GUI subsystem does not prove third-party commands that explicitly request a new window can never display one; such user-requested processes are out of this automatic-tool-launch guarantee.

## Alternatives rejected

- Hiding the window after process startup can still flash and does not fix executable metadata.
- Changing the reusable Host to a GUI binary would alter standalone CLI behavior unnecessarily.
- Removing the Host process, disabling diagnostics, or changing ConPTY is unrelated to this fix.
