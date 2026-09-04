# Windows Native Support Design

**Status:** Accepted  
**Date:** 2026-09-03  
**Upstream behavior baseline:** `deepseek-harness@141eb6fef8`  
**Windows implementation reference:** `deepseek-harness@76fda72979`

## Context

XHarness currently has platform-neutral agent, provider, tool, session, host and Web layers, but its process, sandbox, filesystem and terminal foundations are Unix-only. `xharness-platform` and `xharness-sandbox` deliberately reject Windows at compile time, `xharness-process` imports Unix process-group APIs unconditionally, and the coding bundle exposes a hard-coded `/bin/bash` tool.

The goal is one Rust product that behaves natively on Linux, macOS and Windows. Windows must use PowerShell 7 rather than requiring WSL or Git Bash. Restricted execution must fail closed and must report the limits of its enforcement instead of presenting ACL write isolation as a complete sandbox. The existing observable protocol and frozen upstream compatibility baseline remain unchanged except where the platform-specific shell tool is intentionally named `pwsh`.

## Approaches considered

### Separate Windows repository

This would minimize conditional compilation initially, but duplicates the agent loop, protocol, persistence and Web layers. The two products would drift and every upstream compatibility change would need two implementations. Rejected.

### Treat Git Bash or WSL as the Windows runtime

This preserves the existing Bash tool but does not provide native Windows path, process-tree, ACL, signal or deployment semantics. WSL is not guaranteed to be installed or healthy, while MSYS path translation changes command behavior. Rejected as a product backend; either executable may still be called explicitly by a full-access user.

### Shared capability surface with native providers

Keep one Cargo workspace and the current public capability types. Put platform mechanics behind `cfg`-selected modules and isolate reusable Win32 primitives in one internal crate. Expose `bash` on Unix and `pwsh` on Windows while preserving the common foreground/background job contract. This matches DeepSeek Harness's Service Definition / Provider / Consumer separation without copying its Cordis implementation. Accepted.

## Decision

1. Keep a single Cargo workspace and a single Host/application protocol.
2. Add `xharness-win32`, an internal Windows-only primitive library owning handle RAII, Job Objects, process inspection, restricted tokens, DACL operations and atomic replacement helpers. Non-Windows builds receive no Win32 dependency or runtime loading.
3. Split `xharness-process` internally into shared state/output logic plus Unix and Windows launch/lifecycle backends. Windows children are assigned to a kill-on-close Job Object; cancellation and timeout terminate and settle the whole Job before publishing a result.
4. Add a Windows ACL sandbox provider and a small runner executable. It uses a `WRITE_RESTRICTED` token with deterministic workspace and private-temp restricting SIDs. Every Win32 failure is fatal. The provider reports `partial`: it constrains writes governed by NTFS ACLs, but does not constrain reads, network access, process visibility, Everyone-writable objects or hard-link aliases.
5. Refactor the coding shell tool around a shared dialect descriptor. Unix continues to expose `bash`; Windows exposes `pwsh` and invokes PowerShell 7 as `pwsh -NoLogo -NoProfile -NonInteractive -Command`, with explicit UTF-8 input/output setup. PowerShell 5.1 is not an automatic fallback.
6. Add Windows filesystem operations that canonicalize and re-check targets, reject reparse-point escapes, preserve the destination DACL, and use `ReplaceFileW` for same-volume atomic replacement.
7. Use a native ConPTY-capable backend for persistent terminals while keeping the existing owner, scrollback and shutdown contracts. Platform-specific signal limitations are surfaced explicitly.
8. Port durable control/session locks, private debug storage, shutdown handling and “open path” behavior to Windows without weakening secret or symlink protections.
9. Add a native `windows-2025` CI lane using `pwsh`, running format, workspace check/test/clippy and release packaging. Security and process-tree tests that require the Windows kernel run only in this lane. Linux and macOS remain required regression lanes.
10. Configure DeepSeek through the existing OpenAI-compatible Chat Completions provider using `https://api.deepseek.com`, an environment-variable credential reference and an explicit model route. Live evaluation runs only in a disposable workspace and never records the API key.

## Security and failure behavior

- Restricted modes never fall back to full access.
- An unavailable `pwsh`, sandbox runner, required ACL operation or Job Object operation is a structured readiness/error result.
- Model-provided shell text is passed only as PowerShell's `-Command` value; executable and runner arguments remain structured argv.
- The API key is read from an explicitly named environment variable, scrubbed from child environments where not required, and redacted from debug events and errors.
- Windows `NetworkAccess::Deny` is reported unavailable because the accepted ACL backend does not enforce network isolation.
- ACL and path checks use canonical absolute paths, reject workspace/temp overlap, and validate containment with component-aware comparisons.
- Cleanup errors are observable and cannot be translated into successful tool completion.

## Verification

Each platform component receives pure unit tests runnable on all platforms where practical, plus native Windows integration tests for handles, Job settlement, ACL denial, PowerShell UTF-8, path boundaries, atomic replacement and ConPTY. The final gates are:

- local `cargo fmt --check --all` only;
- full Linux workspace check/test/clippy on `WZU_Server`, per repository policy;
- GitHub Actions Linux, macOS and Windows native lanes;
- fake-provider multi-step coding regression;
- DeepSeek live protocol smoke;
- three disposable long coding runs with independent build/test/diff validation and captured performance metrics.

## Consequences

Most existing code remains unchanged and all platforms share the same protocol and lifecycle. The cost is a small amount of audited unsafe Win32 code, a packaged sandbox runner, target-specific tests and explicit Windows limitations. The design intentionally favors accurate `partial` reporting over a false claim of complete containment.
