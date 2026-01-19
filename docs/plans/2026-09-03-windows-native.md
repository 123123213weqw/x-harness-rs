# Windows Native Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the complete XHarness Cargo workspace compile, test, package and run long coding-agent tasks natively on Windows with PowerShell 7 and fail-closed partial ACL confinement.

**Architecture:** Preserve platform-neutral public contracts and select native backends with `cfg`. Centralize unsafe Windows APIs in `xharness-win32`; let process, sandbox, filesystem and terminal providers consume those primitives while Host, session, provider and Web layers remain shared.

**Tech Stack:** Rust 2021, Tokio, `windows-sys`, PowerShell 7, Win32 Job Objects/restricted tokens/ACLs/ConPTY, GitHub Actions `windows-2025`, OpenAI-compatible DeepSeek Chat Completions.

---

### Task 1: Establish Windows compilation closure and native primitive crate

**Files:**
- Create: `crates/xharness-win32/Cargo.toml`
- Create: `crates/xharness-win32/src/lib.rs`
- Create: `crates/xharness-win32/src/handle.rs`
- Create: `crates/xharness-win32/src/job.rs`
- Create: `crates/xharness-win32/tests/job.rs`
- Modify: `Cargo.toml`
- Modify: target-specific dependency sections in affected crate manifests

**Steps:**
1. Add compile-only tests for owned handle close behavior, kill-on-close Job configuration and active-process accounting.
2. Run the Windows check in CI to record the existing Unix import failures.
3. Add target-specific `windows-sys` features and RAII wrappers; keep all raw APIs inside the new crate.
4. Run `cargo fmt --check --all`, Windows crate tests, then workspace Windows check.
5. Commit the isolated primitive layer.

### Task 2: Port managed process execution to Job Objects

**Files:**
- Modify: `crates/xharness-process/src/lib.rs`
- Create: `crates/xharness-process/src/unix.rs`
- Create: `crates/xharness-process/src/windows.rs`
- Modify: `crates/xharness-process/Cargo.toml`
- Modify: `crates/xharness-process/tests/process.rs`
- Create: `crates/xharness-process/tests/windows_process.rs`

**Steps:**
1. Add Windows tests for direct argv, UTF-8 streams, timeout, cancellation, descendant cleanup, output truncation and dropped-runtime cleanup.
2. Move existing Unix launch/signal code behind `cfg(unix)` without changing results.
3. Implement the Windows launcher with a kill-on-close Job, assignment failure cleanup, active-process settlement and structured Windows exit status.
4. Verify targeted native tests, then Linux regression tests remotely.
5. Commit process portability.

### Task 3: Port durable files and logs without weakening path safety

**Files:**
- Modify: `crates/xharness-fs/src/lib.rs`
- Create: `crates/xharness-fs/src/windows.rs`
- Modify: `crates/xharness-fs/Cargo.toml`
- Modify: `crates/xharness-fs/tests/fs.rs`
- Modify: `crates/xharness-control/src/lib.rs`
- Modify: `crates/xharness-control/Cargo.toml`
- Modify: `crates/xharness-session-jsonl/src/lib.rs`
- Modify: `crates/xharness-session-jsonl/Cargo.toml`
- Modify: relevant tests in all three crates

**Steps:**
1. Add failing Windows tests for case-insensitive containment, junction/reparse escape, DACL preservation, atomic replacement and exclusive durable locks.
2. Isolate existing `openat/openat2` code as Unix backend.
3. Implement Windows canonical-handle checks and `ReplaceFileW` with protected-DACL copying.
4. Replace Unix-only open flags/modes and positional reads in durable logs with target-specific helpers using Windows share/lock semantics.
5. Verify native Windows tests and remote Linux workspace regression; commit.

### Task 4: Implement the fail-closed Windows ACL sandbox

**Files:**
- Extend: `crates/xharness-win32/src/token.rs`
- Extend: `crates/xharness-win32/src/acl.rs`
- Create: `crates/xharness-sandbox/src/windows.rs`
- Create: `crates/xharness-sandbox/src/bin/xharness-windows-sandbox-runner.rs`
- Modify: `crates/xharness-sandbox/src/lib.rs`
- Modify: `crates/xharness-sandbox/src/policy.rs`
- Modify: `crates/xharness-sandbox/Cargo.toml`
- Create: `crates/xharness-sandbox/tests/windows_acl.rs`

**Steps:**
1. Add pure SID/path-boundary/argument-validation tests and native denial tests for read-only/workspace-write/private-temp/outside-workspace.
2. Implement deterministic workspace SID, random private-temp SID, DACL materialization and cleanup.
3. Implement `WRITE_RESTRICTED` token creation and runner-side target launch in a kill-on-close Job.
4. Add `partial` enforcement facts and make unsupported network denial fail readiness without spawning.
5. Run escape, hard-link-boundary documentation and cleanup-failure tests; commit.

### Task 5: Add PowerShell 7 as the Windows coding shell

**Files:**
- Modify: `crates/xharness-coding-tools/src/lib.rs`
- Create: `crates/xharness-coding-tools/src/shell.rs`
- Modify: `crates/xharness-coding-tools/tests/bundle.rs`
- Create: `crates/xharness-coding-tools/tests/pwsh.rs`
- Modify: `crates/xharness-host/src/state.rs`
- Modify: `crates/xharness-host/src/restore.rs`
- Modify: related Host/Web projection tests

**Steps:**
1. Add dialect tests asserting `bash` only on Unix and `pwsh` only on Windows, PowerShell environment syntax, UTF-8, pipeline failure behavior and background jobs.
2. Extract common shell tool lifecycle and result rendering from the hard-coded Bash implementation.
3. Resolve PowerShell 7 from explicit configuration, the standard installation path and `PATH`; reject Windows PowerShell 5.1 fallback.
4. Invoke `pwsh -NoLogo -NoProfile -NonInteractive -Command` with UTF-8 preamble and preserve current job ownership/cancellation.
5. Make terminal-card projection accept both shell names; verify fake-provider tool loops and commit.

### Task 6: Compose the Windows platform and readiness model

**Files:**
- Modify: `crates/xharness-platform/src/lib.rs`
- Modify: `crates/xharness-platform/Cargo.toml`
- Modify: `crates/xharness-platform/tests/platform.rs`
- Modify: `docs/specs/platform.md`
- Modify: `docs/specs/sandbox.md`

**Steps:**
1. Add tests for `PlatformKind::Windows`, restricted/full access, `partial` sandbox facts, PowerShell readiness and denied network capability.
2. Remove Windows compile guards and select the ACL provider at compile time.
3. Use Windows filesystem roots and component-safe absolute-path resolution instead of Unix `/` assumptions.
4. Probe the actual runner with a harmless read-only command and cache the result.
5. Verify Windows and remote Unix platform suites; commit.

### Task 7: Port persistent terminals and remaining host utilities

**Files:**
- Refactor: `crates/xharness-terminal/src/lib.rs`
- Create: `crates/xharness-terminal/src/unix.rs`
- Create: `crates/xharness-terminal/src/windows.rs`
- Modify: `crates/xharness-terminal/Cargo.toml`
- Modify: `crates/xharness-terminal/tests/terminal.rs`
- Modify: `crates/xharness-debug/src/lib.rs`
- Modify: `crates/xharness-host-app/src/main.rs`
- Modify: `crates/xharness-host/src/rpc.rs`
- Modify: platform-specific tests

**Steps:**
1. Add Windows terminal tests for open/write/read/resize/Ctrl-C/close/scrollback/owner isolation.
2. Keep the Unix PTY backend intact and add a ConPTY backend with the same registry contract.
3. Add Windows private-directory/file DACL handling for debug traces.
4. Add portable Ctrl-C shutdown and `explorer.exe` path opening with structured argv.
5. Run the full native Windows test inventory and remote Unix regressions; commit.

### Task 8: Add required Windows CI and release artifact

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `scripts/package-windows.ps1`
- Modify: `README.md`
- Modify: `docs/TODO.md`
- Modify: `docs/FULL_REPLICATION.md`

**Steps:**
1. Add workflow contract checks where present, then a `windows-2025` job with `shell: pwsh`.
2. Run fmt, workspace check, workspace tests and clippy with warnings denied.
3. Build the release Host and sandbox runner, bundle `rg.exe`, create a zip and SHA-256 file, then upload both.
4. Keep Linux/macOS jobs required and use target-aware caches.
5. Push the branch, inspect every CI job and fix failures until the matrix is green; commit CI/docs.

### Task 9: Validate DeepSeek provider configuration and secret handling

**Files:**
- Modify: `docs/specs/provider-openai.md`
- Create: `examples/deepseek/providers.json.example`
- Add/modify: provider and host configuration tests
- Modify: `.gitignore` only if a local evaluation output pattern is introduced

**Steps:**
1. Add a fixture proving `https://api.deepseek.com` plus Chat Completions/tool calls maps to the existing provider-neutral stream.
2. Define an environment-only `DEEPSEEK_API_KEY` credential reference and assert serialized config/debug output never contains its value.
3. Verify streaming reasoning, tool-call assembly, usage accounting, retry/timeout and context fallback with a fake server.
4. Perform a real protocol smoke using the user-authorized key injected only into the process environment.
5. Commit configuration, tests and secret-safety documentation without any credential material.

### Task 10: Run long coding evaluation and close regressions

**Files:**
- Extend: `docs/specs/live-deepseek-evaluation.md`
- Create: `scripts/evaluate-deepseek.ps1`
- Create: isolated evaluation fixtures under `tests/fixtures/live-coding/`
- Create: a sanitized report under `docs/evaluations/`

**Steps:**
1. Run deterministic fake-provider, debug-trace and restart gates.
2. Run the official DeepSeek-compatible protocol smoke.
3. Run three disposable long coding tasks covering multi-file edits, an intentional failing test, background work, context pressure and recovery.
4. Independently check build/test results, Git diff, out-of-workspace writes, duplicate side effects and secret leakage.
5. Turn every runtime/tool failure into a deterministic regression test and repeat all gates until three consecutive runs pass.
6. Record TTFT, throughput, token usage, tool success/retry, compact activity, event/log size and wall time; commit only sanitized results.

### Final verification

1. Run local `cargo fmt --check --all`.
2. Synchronize the source to `WZU_Server` excluding `.git`, `target`, `node_modules`, `.env` and `.env.*`; run full workspace check/test/clippy there.
3. Push and require green Linux, macOS arm64 and Windows x64 CI.
4. Review the complete diff for secret material and unsafe-code boundaries.
5. Deliver the branch, commits, CI links, supported/partial capability matrix and long-task evaluation report.
