# Windows bundled PowerShell and dependency maintenance

## Execution contract

Windows x64 desktop and portable Host packages contain the **complete official
PowerShell 7.6 LTS ZIP** (including its .NET runtime, modules, LICENSE and
ThirdPartyNotices). Users do not need to preinstall PowerShell 7, .NET or Python.
Supported Windows/.NET OS requirements and WebView2 requirements still apply;
this is not a claim of supporting every Windows release.

`runtime/powershell.lock.json` is the sole source of version, target, archive
size and SHA256. No startup download or global PowerShell installation occurs.
The release builder and all alternative Windows staging routes run
`scripts/powershell-runtime.py stage`. The Windows-only Tauri overlay maps the
full payload to `runtime/powershell/<version>/`; Unix bundles are unchanged.

Desktop resolves the resource directory and passes
`XHARNESS_BUNDLED_POWERSHELL_ROOT` privately to Host. The common process library
selects in this order:

1. Explicit `XHARNESS_SHELL` selection (missing/invalid selection is an error).
2. App-owned, pinned runtime (before `SHELL` or system PATH).
3. Only for unbundled standalone CLI: existing system-shell discovery.

A claimed but missing/mixed bundle never silently switches to PS5 or CMD. The
portable Host discovers a sibling `runtime/powershell` directory; its PS5
launcher re-enters the bundled pwsh before doing any work. Tools still use the
same direct `program`/`args` or explicit `command` interface, common managed
process runtime, Windows Job, timeout, cancellation and stdout/stderr capture.
There is no Python wrapper or newly registered model tool.

Startup checks the pin and required file sizes; it does not hash hundreds of
megabytes on every launch. Staging checks the official ZIP digest before safe
extraction, verifies native pwsh/.NET loader dependencies, and seals **all**
file hashes. The final extracted NSIS payload must match that staged manifest
and every file hash; installed-payload acceptance checks them again. Managed
AnyCPU .NET assemblies use the vendor-content gate, not the owned x64 native
PE gate. The latter's static-CRT/loader requirements remain unchanged.

## Update behavior

PowerShell updates ship with an XHarness update, not independently at startup.
Runtime files live in a version-named resource directory. Staging never repairs
or overwrites an existing invalid/in-use directory. The app updater already
requires confirmed Host/Tool/Job shutdown before invoking the installer; if
shutdown fails, installation is paused. The installer then replaces resources
as part of the app update and restarts the new app. No live DLL hot replacement
or separate runtime-cache garbage collector is introduced. User Windows PS5
and any globally installed PS7 remain untouched.

The full pinned ZIP is about 101 MiB compressed / 245 MiB unpacked. Bundle size
increases deliberately to remove a user-preinstallation dependency. Native
Windows acceptance, not Linux-only tests, is required for a new interpreter.

## Dependency robots

- Dependabot checks Cargo (root + desktop), npm (UI + release-service action)
  and GitHub Actions weekly. Compatible updates are grouped and open-PR counts
  are bounded. Major updates are still reviewable PRs, never auto-merged.
- PowerShell is a release ZIP, not a Cargo/npm package. A separate trusted
  default-branch weekly workflow checks stable patches **within the pinned LTS
  series**. It cross-checks GitHub's asset digest with `hashes.sha256`, stages
  and validates the complete archive, and proposes **only the lock file**.
- A version has one bot branch/PR. Partial branch/commit publication can recover
  without repeating the commit; uncertain or modified partial branches fail
  closed. A previously closed proposal is not automatically reopened.
- The bot explicitly dispatches normal CI and native Windows installer gates;
  GITHUB_TOKEN-created PR events can require manual workflow approval. No
  personal token or third-party App is required. Existing-PR checks do not
  trigger weekly duplicate CI runs.
- It never approves reviews, merges, signs or releases. Repository settings
  must allow Actions to create PRs; ordinary workflows keep read-only defaults.
  Schedules start only after this configuration reaches `master`.

Moving from LTS 7.6 to a different series is a deliberate reviewed lock change,
not the weekly patch robot's decision. Review Microsoft's support lifecycle
when making that change.

## Regression / native build

Offline (no Rust compilation):

```sh
python3 -B scripts/test-powershell-runtime.py
python3 -B scripts/test-windows-desktop-bundle.py
python3 -B scripts/test-windows-runtime-audit.py
python3 -B scripts/test-desktop-release-build.py
```

All Rust compilation/checks/tests run on remote servers or native CI runners,
never the local Mac. After synchronizing source, run the shared process,
coding-tools and web-terminal suites on WZU_Server. Native Windows gates stage
the pin, run `test-bundled-powershell.ps1` with system pwsh/.NET removed from
PATH, run managed bundled-interpreter tests, build NSIS, audit extraction and
exercise installation/replacement/data retention. These gates do not publish.

References: [Microsoft ZIP installation](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows),
[PowerShell servicing](https://learn.microsoft.com/en-us/powershell/scripting/install/powershell-support-lifecycle),
[GitHub token-trigger behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
