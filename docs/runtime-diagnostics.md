# Runtime diagnostics: two tiers, one application

Open **XHarness 更新 → 运行诊断**. An unexpected Host exit also opens a bundled
diagnostic window, independently of the failed loopback server. The chat page
and unsent draft are not navigated away from. Closing this diagnostic window
does not close the application.

## Tier 1: permanent lightweight evidence

- Desktop lifecycle, exit code/signal, expected/unexpected classification,
  Windows retained-process-handle resources every 10 seconds.
- Host operation categories summarized every 10 seconds. Producers never wait
  for disk; a bounded 256-event queue counts dropped metadata events. Existing
  full-debug mode remains separate and is not implicitly enabled.
- Desktop and Host each keep four 1 MiB JSONL segments. One metadata export is
  retained as `diagnostics/export.json` under the app cache directory. Export
  overwrites the prior export; copy reports you want to keep elsewhere.
- Abnormal-run markers survive restart until acknowledged. Diagnostic I/O
  failure is shown in the status; it never aborts the Agent's operation.
- Metadata is a closed schema of enums/numbers. No chat, command arguments,
  provider configuration, environment, secret value, path or raw stderr is
  copied into reports. Malformed/extra-field lines are rejected and counted.
  Live export is a bounded best-effort snapshot, not an atomic session backup.
- Nothing is uploaded automatically. The user decides whether to share a report.

## Windows crash evidence

The Host installs a best-effort unhandled-exception signal after state ownership
is acquired. The exception callback writes 16 bytes to a pre-opened context file
and waits at most 15 seconds on its generation-specific event. It does not
allocate, take a Rust mutex, or call DbgHelp. A desktop observer uses a retained
process handle to save the dump, then acknowledges the signal on success or
failure. The ordinary Windows exception processing is not suppressed.

Dump I/O is capped through the DbgHelp callback: 64 MiB normally, 512 MiB in
explicit full-memory mode. A failed or over-budget dump is not presented as a
complete dump. At most `crash-latest.dmp` and `crash-previous.dmp` are retained.
Both can contain credentials, conversation text and other memory contents;
**neither is included in the normal metadata export**. Review locally before
sharing. These are app-owned files; global Windows CrashDumps are not changed.

Fast-fail, OOM, forced termination and some corrupted runtimes can bypass the
hook. A dump cannot be guaranteed. DbgHelp may block internally; the Host wait
is bounded, and I/O callbacks impose a 10-second deadline when called. This is
not a hard timeout for every internal Windows call.

## Tier 2: explicit, temporary deep diagnosis

After reading the notice, enable up to 15 minutes of enhanced diagnostics:

- Windows resource interval becomes 2 seconds.
- Up to 4096 individual operation-category events per lease are recorded. No
  payload/raw text is captured by this tier. Queue drops remain counted.
- Optional full-memory crash capture is independently selected before enabling.
  Above 512 MiB it fails rather than silently producing a supposedly full dump.
- Optional Windows default-process-heap validation runs at most once a minute.
  It can block allocators and noticeably slow the Host. This checks heap control
  consistency, not all memory or every allocation; it is **not PageHeap/ASan**.
  No registry/global debugger or IFEO settings are changed.

Lease expiry is monotonic within each process, and the unchanged control file
cannot re-enable an expired lease. Restarting the desktop disables it. Control
changes reach the Host within approximately two seconds under normal operation.
A heap validation already executing cannot be cancelled halfway through.

## Recovery

Save/export evidence, then manually exit/reopen XHarness. Diagnostic commands do
not submit session requests, restart tools, replay tool calls, stop the Host,
install an update or automatically resume a failed command. Before continuing a
task, verify the real effects of its last interrupted operation. Existing Host
restore behavior is not altered by this feature.

## Versioned symbols

Windows release builds retain optimization, set release debug info to 2 and do
not strip it. `scripts/archive-desktop-symbols.py` archives exact Host/Desktop
EXE+PDB pairs, checks CodeView GUID/age against the PDB identity stream, and
records SHA256, source commit, rustc version and lockfile hashes. PDBs are not
bundled into the user installer.

The matrix uploads a separate symbol archive. The aggregator validates its
source/identity/checksums and attaches `windows-debug-symbols.zip` **before**
creating the immutable release draft, includes it in `SHA256SUMS`, and retains it
as a Release asset. It does not change `latest.json` or the updater trust key.
Actions copies expire after 90 days; Release assets do not have that automatic
expiry (maintainers can still delete them). Historical releases without symbols
remain valid. Newly rebuilt PDBs cannot be used for a mismatched old executable.

Portable metadata/export/leases/UI are shared by Windows, macOS and Linux.
Native resource/exception/heap instrumentation and this PDB archive are Windows
specific; dSYM/ELF symbol archival is not implemented by this change.

## Verification

Do not compile Rust on the local Windows development machine (see AGENTS.md).
Use WZU_Server or GitHub Actions. `Runtime diagnostics acceptance` runs isolated
native Windows exception/capture tests with synthetic child processes, along
with recorder/lease tests and Clippy. No real App or user state is loaded.

Local non-Rust checks:

```text
node scripts/test-runtime-diagnostics.mjs
node scripts/test-runtime-diagnostics-browser.mjs
python -B scripts/test-desktop-symbols.py
python -B scripts/test-unified-desktop-release.py
```

Browser tests accept UI_TEST_DEPS/UI_TEST_EXECUTABLE as the existing UI tests do.
