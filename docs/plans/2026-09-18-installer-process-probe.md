# Installer Process Probe Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent inaccessible retired process entries from indefinitely blocking updates without allowing live or uncertain processes to bypass installation safety checks.

**Architecture:** Retain the current-user Host guard (copies can share user data). On an owner-query failure, re-query the exact PID and creation identity; accept disappearance, or two stable zero-thread/zero-handle samples only when all existing target executables can be exclusively opened for writing. Unknown, active, changed-identity, missing-metadata, locked or uninspectable cases fail with a PID and an actionable diagnostic. Pass target directories to preflight/reconciliation; do not kill processes or alter permissions. The exclusive-file probe is a point-in-time check; NSIS/file replacement remains the final lock guard.

**Tech Stack:** Windows PowerShell 5.1, CIM, .NET file sharing, NSIS hooks, Windows CI.

## Alternatives and limits

- Ignoring all owner-query failures, or relying on zero threads alone, is unsafe and rejected.
- Requiring successful owner queries forever causes the observed deadlock and is rejected.
- A bounded metadata-and-file-access fallback addresses this incident without weakening the live current-user guard. Foreign-user processes remain outside the user-data guard, but target executable locks are independently checked.
- Do not claim to have reproduced the original kernel/process-retention mechanism unless a native Windows test demonstrates it. The server VM has no Windows installation.

## Steps

1. Add deterministic tests in `scripts/test-install-process-probe.ps1` using the actual production functions with CIM fault injection; run against the old script to establish failure.
2. Update `apps/desktop/src-tauri/windows/install-ownership.ps1` with a bounded owner-failure classifier and non-destructive target executable checks. Preserve current-user exclusion, PID identity and redirection guards.
3. Pass installation directory as environment data in `windows/hooks.nsh`; apply the probe again during reconciliation and before legacy retirement.
4. Add native disposable Windows process tests for a live child and an exited child whose process handle is retained, plus locked-file checks. Run Windows PowerShell 5.1 and PowerShell 7 in CI; never use the real installed app or user sessions as a fixture.
5. Update `scripts/test-install-ownership-contract.mjs`, the dedicated CI workflow, and `docs/windows-installation-ownership.md`.
6. Commit with the currently authenticated GitHub account, submit an upstream Draft PR and report exact results. Do not publish or modify the installed application.
