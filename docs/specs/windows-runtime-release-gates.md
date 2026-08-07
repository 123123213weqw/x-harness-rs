# Windows runtime / installer dependency gates

## Scope

All owned AMD64 Windows executables (Desktop, Host, sandbox runner) use the
repository's target-scoped static CRT configuration. Windows CI sets
`CARGO_BUILD_TARGET=x86_64-pc-windows-msvc`: proc macros remain host tools and
application artifacts go under the explicit target directory. A `RUSTFLAGS` or
`CARGO_ENCODED_RUSTFLAGS` override can replace Cargo config; the *final payload*
audit, rather than trusting environment configuration alone, rejects dynamic CRT
imports. Linux/macOS build configuration is unchanged.

This does not eliminate Windows system DLLs or WebView2. Do not copy DLLs from
an arbitrary CI machine into a release or install the VC runtime to hide a failed
clean-machine test.

## Independent checks

1. `audit-windows-runtime.py` parses ordinary AND delay imports, checks AMD64,
   rejects malformed PE tables, and resolves non-system imports only against the
   payload's own loader-visible directories. Known Windows API sets/system DLLs
   are explicitly allowed; a runner's System32 contents are not evidence.
2. NSIS is extracted into a disposable directory with 7-Zip. Installer-only
   `$PLUGINSDIR` and `uninstall.exe` can have a separate x86 loader; their imports
   are also audited, without imposing the AMD64 app policy on NSIS itself. Every
   application PE is checked; all four root executables are mandatory.
3. Build collection compares extracted Desktop/Host/runner/rg SHA256 with the
   freshly built/staged files. A stale sidecar or mixed installer fails before a
   signed platform receipt is created. Aggregate independently re-audits NSIS.
   The cryptographic receipt schema and native updater acceptance stay unchanged.
4. Hosted install ownership acceptance compares every installed application PE
   hash with the exact installer audit before and after reinstall. No additional
   trust is assigned to an unrelated or stale audit JSON.
5. `test-windows-clean-vm.ps1` is a separate UUID-guarded V100 clone fixture. It
   verifies no VCRUNTIME140, installs exact official 0.2.34 then the candidate,
   checks all installed hashes, preserves a data sentinel, tests Host readiness
   and desktop-crash child cleanup. It does NOT pretend to be GitHub hosted.
   The read-only PowerShell fixture checks real working directory and write
   denial. UI screenshots remain independent observations, not inferred from an HTTP 200. It is NOT signed two-hop updater acceptance.

## Startup errors

Early NTSTATUS exits distinguish missing DLL, missing entry point and invalid
image/architecture. The status code is shown; a particular DLL name is never
inferred from STATUS_DLL_NOT_FOUND. Existing structured failure receipts still
have priority. Lost event channels fail readiness immediately while preserving
process ownership until real exit; failed startup requests cleanup. Successful
product readiness, not just creation of a live endpoint, gates automatic crash
notice routing. No operation/tool is replayed automatically.

## Acceptance / publication

The build-only workflow `windows-runtime-gates.yml` produces a disposable 0.2.35
candidate and evidence, not a Release. Production version planning/signatures,
exact-SHA CI and the existing native updater publication gate remain mandatory.
A clean-VM run and inspection of its recorded outcomes must be completed before
calling this change accepted. Missing execution evidence is not a pass.

The V100 fixture does not change original VM accounts/UAC, installs no system
redistributable, and stops only processes belonging to its explicit test path.
Program Files / elevated UAC / complete historical migration are separate
acceptance scopes. The current installer policy is still currentUser.
