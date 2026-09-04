# Windows Tauri Desktop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the upstream Tauri client as a functional Windows x64 Coding Agent, including the native Host, pinned ripgrep, ACL sandbox runner, CI-built NSIS installer, and signed updater artifact support.

**Architecture:** Keep the Tauri shell platform-neutral and reuse the existing loopback Host protocol. Add a Windows-only Tauri config overlay because `externalBin` arrays replace rather than extend the base configuration, and include the Windows sandbox runner beside the Host so restricted execution remains available after installation. Build and test only on native Windows CI; local checks remain limited to formatting and non-Rust contract tests per `AGENTS.md`.

**Tech Stack:** Rust, Tauri v2, PowerShell 7, GitHub Actions, NSIS, Python 3, Node.js.

---

### Task 1: Lock the Windows bundle contract

**Files:**
- Create: `scripts/test-windows-desktop-bundle.py`
- Create: `apps/desktop/src-tauri/tauri.windows.conf.json`
- Modify: `apps/desktop/src-tauri/capabilities/desktop-main.json`

**Step 1: Write the failing contract test**

Add a Python test that stages dummy `xharness-host.exe`, `rg.exe`, and
`xharness-windows-sandbox-runner.exe` inputs for `x86_64-pc-windows-msvc`, then
asserts the target-suffixed files and Windows Tauri `externalBin` entries exist.
Also assert that the desktop capability includes `windows`.

**Step 2: Run the test to verify it fails**

Run: `python scripts/test-windows-desktop-bundle.py`

Expected: FAIL because `tauri.windows.conf.json` and the Windows capability do
not exist yet.

**Step 3: Implement the Windows config overlay**

Create `tauri.windows.conf.json` with all three external binaries. Keep the base
macOS/Linux list unchanged, because Tauri platform arrays replace the base list.
Add `windows` to `desktop-main.json`.

**Step 4: Run the test to verify it passes**

Run: `python scripts/test-windows-desktop-bundle.py`

Expected: PASS and three target-suffixed `.exe` files are verified in an isolated
temporary directory.

**Step 5: Commit**

```bash
git add scripts/test-windows-desktop-bundle.py apps/desktop/src-tauri/tauri.windows.conf.json apps/desktop/src-tauri/capabilities/desktop-main.json
git commit -m "feat(desktop): define Windows bundle contract"
```

### Task 2: Build an installable Windows client in pull-request CI

**Files:**
- Modify: `.github/workflows/ci.yml`

**Step 1: Extend the native Windows job**

Reuse its release Host, sandbox runner, and checksum-pinned ripgrep. Stage all
three Tauri binaries with `x86_64-pc-windows-msvc` names, run the separate desktop
Cargo manifest's format/check/test/Clippy commands, and run the Python/Node
contract tests.

**Step 2: Build the NSIS installer**

Use `tauri-apps/tauri-action` with updater artifacts disabled for pull-request CI.
Create a SHA-256 file for the installer and upload both as
`XHarness-windows-x64`.

**Step 3: Verify remotely**

Run: GitHub Actions `Rust / Windows x86_64`

Expected: the workspace and desktop shell pass with warnings denied, an NSIS
installer is produced, and the artifact includes its checksum.

**Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(desktop): build Windows installer"
```

### Task 3: Add Windows to tagged desktop releases

**Files:**
- Modify: `.github/workflows/desktop-release.yml`

**Step 1: Add a Windows x64 matrix entry**

Use `windows-2025` and `x86_64-pc-windows-msvc`. Build the Host and ACL runner,
download and hash-check ripgrep 15.2.0, and stage all three external binaries.

**Step 2: Preserve updater security**

Keep `TAURI_SIGNING_PRIVATE_KEY` and the immutable updater public key mandatory.
Publish NSIS updater artifacts through the existing draft release. Do not claim
Authenticode signing unless a Windows code-signing certificate is configured.

**Step 3: Validate workflow structure**

Run: `python scripts/test-windows-desktop-bundle.py`

Expected: PASS, including assertions for the Windows release matrix, target,
sandbox runner staging, and pinned ripgrep hash.

**Step 4: Commit**

```bash
git add .github/workflows/desktop-release.yml scripts/test-windows-desktop-bundle.py
git commit -m "ci(desktop): publish Windows x64 releases"
```

### Task 4: Update support and security documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/specs/desktop.md`
- Modify: `docs/TODO.md`
- Modify: `docs/windows.md`

**Step 1: Document the complete Windows bundle**

State that the installer includes Host, pinned ripgrep, Web UI, and ACL runner;
PowerShell 7 remains required. Explain that updater signatures protect integrity,
while an unsigned Authenticode installer may still trigger SmartScreen.

**Step 2: Correct the implementation status**

Remove the obsolete statement that Windows native support is still pending.
Keep Windows ARM64 and branded code signing as follow-up work.

**Step 3: Commit**

```bash
git add README.md docs/specs/desktop.md docs/TODO.md docs/windows.md
git commit -m "docs(desktop): describe Windows client delivery"
```

### Task 5: Verify and submit upstream

**Files:**
- Verify all modified files

**Step 1: Run permitted local checks**

Run:

```powershell
cargo fmt --check --all
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
python scripts/test-windows-desktop-bundle.py
node scripts/test-desktop-updater.mjs
```

Expected: all pass. Do not run local Rust compilation.

**Step 2: Push and open the upstream PR**

Push `btlqql/windows-desktop` to the fork and open a PR against
`123123213weqw/x-harness-rs:master`.

**Step 3: Wait for CI and inspect the artifact**

Require Linux, macOS, Windows workspace checks plus Windows desktop checks to be
green. Download `XHarness-windows-x64`, verify its SHA-256, and inspect the NSIS
payload for the Host, ripgrep, sandbox runner, Web UI, and desktop executable.

**Step 4: Report limitations**

Report Windows x64 as complete only after artifact inspection. Keep Windows ARM64
and Authenticode reputation explicitly pending when no certificate is configured.
