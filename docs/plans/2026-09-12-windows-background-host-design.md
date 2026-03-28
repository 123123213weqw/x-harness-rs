# Windows desktop without an extra console

The desktop owns one independent Host for fault isolation. Host startup already
uses tauri-plugin-shell 2.3.6, whose Windows Command constructor sets
CREATE_NO_WINDOW and pipes stdout/stderr. The actual missing setting is in the
desktop executable: its entry point has no GUI subsystem attribute, and the
installed Windows binary reports IMAGE_SUBSYSTEM_WINDOWS_CUI (3).

## Decision

- Build the release Windows desktop as IMAGE_SUBSYSTEM_WINDOWS_GUI (2).
- Retain development consoles and the standalone Host CLI. Do not make Host a
  GUI executable, detach its log pipes, or turn it into a Windows service.
- Keep single-instance activation, startup ownership barrier, Job cleanup,
  shutdown handling, and independent local diagnostics unchanged.
- This does not merge the optional diagnostics window into the main window.
  Two related process entries in Task Manager remain intentional.

## Verification

1. Source contract guards the Windows-only release attribute and preserves Host
   CLI entry point semantics.
2. Native Windows CI inspects both executables extracted by the real NSIS
   installer; merely hiding the CI launch window must not conceal a regression.
3. Existing native acceptance still checks Host readiness, duplicate activation,
   crash cleanup, and reinstall data retention.
4. Rust compilation stays on remote builders/CI. Do not replace or restart the
   user's running installation as part of this source change.
