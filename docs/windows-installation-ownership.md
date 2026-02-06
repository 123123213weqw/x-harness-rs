# Windows installation and process ownership

Updates must retain the active installation directory and the stable application
identifier `com.xlang.xharness`. Application files are replaceable; state,
credentials, workspaces and session journals are not installer-owned files.

## Runtime protections

- The desktop registers Tauri's single-instance plugin first. A second launch
  (including a copy in another directory) shows/focuses the running window before
  initializing another Host.
- The native Host owns a filesystem lease under `state/ownership` before loading
  configuration, opening debug traces or restoring sessions. This also protects
  CLI/server launches, independent of the desktop plugin and installation path.
- Startup probes existing per-agent locks to detect active older Hosts. Older
  binaries do not implement the new directory lock, so per-agent locks remain
  mandatory even after this change. Do not remove lock files to resolve conflicts.
- Windows lock contention is compared with `fs2::lock_contended_error()`, including
  native error 33, instead of assuming Unix `WouldBlock` classification.
- A desktop-owned kill-on-close Windows Job contains the Host process tree. A
  per-invocation startup permit prevents the Host from restoring/spawning work
  before assignment. The permit is not an inherited environment variable.
- Updating waits for Host termination and an empty Job. A timeout, shutdown-file
  failure or uncertain exit pauses installation and retains the verified download.
  Ordinary download/check operations never stop work.

## Installation and legacy copies

The updater passes NSIS's final `/D=` argument from `current_exe().parent()`, so a
different copy's registry entry cannot silently redirect an in-app update.
The identity, data location and signing verification remain unchanged.

NSIS preflight waits briefly for the calling desktop to exit and then rejects
other XHarness desktop/Host processes owned by the current user. It does not kill
processes by image name. Its inventory captures existing per-user shortcuts before
NSIS creates/replaces its standard shortcuts.

After file installation, shortcuts still pointing to inventoried XHarness copies
are redirected to the retained installation. Custom launch arguments are preserved.
Automatic retirement is limited to inventoried legacy distribution directories:

- the current user's Desktop/XHarness (including OneDrive Desktop);
- LocalApplicationData/Programs/XHarness-Friends.

Only their desktop binary, Host binary and optional old uninstaller are renamed
to `.before-xharness-update` recovery files. The old uninstaller is retired because
it shares the new installation's registry identity. A shortcut in the retired
folder opens the retained installation. Existing backups are never overwritten;
partially renamed binaries are restored if retirement fails. Unknown directories,
custom launch configurations, newer copies and user project/data files are not
retired. This is not a disk-wide cleanup or a promise to find every arbitrary copy.

Junctions, symlinks and unknown reparse tags are rejected. Microsoft's cloud-file
reparse tags are distinguished from path redirects, so OneDrive is not rejected
solely for marking hydrated files as reparse points.

The installer runs its embedded, fixed helper commands using Windows' built-in
PowerShell (not a persistent PowerShell agent and not a dependency on PowerShell
7). Paths are passed as environment data, not interpolated command source. It
does not change execution policy, download scripts or load user profiles. Enterprise
application control/constrained-language restrictions are not disabled; an
unavailable helper fails the installer with diagnostics.

## Verification and release gate

- `node scripts/test-install-ownership-contract.mjs`: configuration and safety
  contracts, distinct from runtime behavior tests.
- `scripts/test-install-ownership-logic.ps1 -DesktopBinary <built desktop.exe>`:
  isolated copies/shortcuts, custom and unknown locations, retained user files,
  recoverable retirement and backup preservation. No actual user installation
  is modified.
- `cargo test --workspace --all-targets` on remote CI: native Windows/macOS/Linux
  lease classification, independent/aliased directories, live legacy lease
  rejection and cross-process Host crash/reacquisition.
- Desktop Rust tests on remote CI: stop timeout/retry and explicit directory
  argument behavior, plus existing updater tests.
- `scripts/test-windows-install-ownership.ps1 -Installer <NSIS.exe>`: disposable
  GitHub-hosted Windows runner only. Installs to a Chinese/spaced path, launches
  copies from two locations, checks live-install refusal, kills only the created
  desktop to test automatic Host cleanup, reinstalls, verifies shortcut/legacy
  retirement, Host readiness and retained fixture data.

The last check is a real NSIS reinstall/crash test, **not** a signed updater-chain
test. Existing `Windows Native Migration Acceptance` covers the previously
released 0.2.0/0.2.1 -> 0.2.2 -> 0.2.3 chain. A new signed release must run acceptance
against its own package before publication. CI installers using the repository's
development version are not production upgrades for installed 0.2.3 clients.

## Recovery

Close every XHarness window/Host before inspecting recovery files. Keep the data
directory intact. If a legacy executable was retired, use its new XHarness shortcut
to open the retained installation. Recovery files can be restored deliberately
only after ensuring the newer installation is stopped; never run both copies
against the same state or delete `.agent.lock` files to force concurrent access.
