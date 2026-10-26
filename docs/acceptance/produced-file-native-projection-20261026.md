# Native produced-file projection acceptance — 2026-10-26

## Production gap

PR #388's UI is present in master and the installed 0.2.60 bundle. A read-only
`session.history` request against the installed desktop Host found a successful
native `write` call/result with no `view` on either envelope. The file-card
accumulator depends on call render intent (`diff`, or `generic` + `kind: edit`)
and `locations`. Without that producer it always derives an empty file list.
The existing UI fixtures supplied those views; they did not validate the native
producer-to-selector boundary. This fix closes that gap rather than redesigning
the card or asking a model to remember to mention filenames.

## Implementation / retained boundaries

- One pure, unsafe-forbidden file presenter supplies the existing generic edit
  intent for canonical native `write`/`edit` calls. Both durable and compatibility
  projectors use it. Existing terminal/result/compaction projections are unchanged.
- Preserve the exact requested path, including relative, Unicode, Windows and
  UNC forms. Reject empty, NUL, malformed/duplicate path fields and locations over
  32 KiB. The presenter does no filesystem IO or authorization and does not copy
  the write body into a fabricated diff. This is not a total Host RSS benchmark.
- Only successful settlements enter the UI accumulator. Error and unknown
  outcomes, reads, and filename-like shell output do not become artifacts.
- Read `created`/`path` from bounded native JSON output-envelope metadata as well
  as the existing plain result format. Path agreement remains required. Do not
  label an edit as created/modified when the actual result has no such evidence.
- No model tool, prompt, executor, model-facing result, durable journal schema,
  permission, native-launch rule or package dependency changes.
- Bash/Python/Code Mode output discovery is **not** implemented by this patch.
  No prose parsing or directory-wide scan is introduced. Office icons remain
  format labels, not added Office document rendering.
- A result-only history page does not invent an unseen turn prefix. Loading the
  older mutation evidence restores the cards through the normal assembler.
- The independent 3082 Web's old static directory is a separate deployment issue.
  This change does not replace it, restart the desktop, or stop any running Agent.

## Regression mechanism

The Rust Host test uses controlled, provider-free durable tool events and the
real BasicHost mux publication, `session.history`, and reopened JSONL store.
No test fabricates `view` objects. It exports those actual wire envelopes for
`test-produced-file-native-wire.mjs`, which runs the production Session,
ConversationAssembler, deliverables Definition and turn-tail selector. Transport
and React paint are omitted in this wire test, not the producer or reducers.
Existing Chromium/WebKit tests separately cover the unchanged source card UI.

Coverage includes write/create, overwrite, edit, same-path deduplication,
error/unknown outcomes, non-mutations, pending calls, a closing answer with no
filenames, a following turn with no writes, older-page loading, and JSONL restart.
A negative control removes all producer views and must yield no cards. The same
wire fixture is exported afresh by the Linux, Windows and macOS Rust jobs and
consumed before their checks can pass; the committed export supports offline
UI shards, not a substitute for the fresh native export.

## Results

Validated against master `cf9b0fc6d8c07bdad781c81876988e816cca5578` in an
isolated worktree. All Rust commands below ran on **WZU_Server**, after source
synchronization; no Rust compilation took place on the Mac.

| Check | Observed result |
| --- | --- |
| Pre-fix native Host negative control | Fails at the missing call locations: actual `[]`, expected six write/edit paths. No mock views. |
| Patched real Host live / history / reopened JSONL | 1/1 passes; exports actual 62-event windows and native JSON output-envelope metadata with resolved paths. |
| Fresh native export → production Session/Assembler/selector | 4/4 passes; also removes every view as a negative control, which correctly produces no cards. |
| `cargo test --locked -j6 -p xharness-projection` | 40 passed. |
| `cargo test --locked -j6 -p xharness-host --lib --test basic_host` | 467 library + 24 integration passed; 8 existing ignored tests remain ignored. |
| `cargo clippy --locked -j6 -p xharness-projection -p xharness-host --all-targets -- -D warnings` | Passes. |
| `cargo fmt --all -- --check` | Passes. |
| TypeScript typecheck, UI build, committed build verification | Pass; 61 modules / 190 assets. |
| View-source + file-display source tests | 96/96 pass. |
| CI UI-plan contracts | 18/18 pass, including retained commands/calibration/fail-closed behavior. |
| CI tiering + architecture policy mutation tests | 10/10 + 30/30 pass; architecture tests use Python 3.14, not macOS's old Python 3.9. |
| Architecture dependency / content-bound stabilization freeze | Passes against the exact base above. |
| Source file-card browser regression | Chromium and WebKit pass on V100: folding, dropdown/keyboard, exact paths, Office icons, metadata/thumbnail lifetime, pagination, and no automatic native opening. |
| Full owned file-preview graph | Chromium and WebKit pass on V100: Markdown/math/code/images, diff scopes, refresh, blob cleanup, HTML isolation, and native hand-off guards. |

The restarted comparison preserves all events, messages, paths, views, outcomes,
sequence numbers and ordering. Only opaque request audit-snapshot references are
normalized: live headers can defer their snapshot while reopened JSONL headers
refer to their durable backing. The fixture uses SnapshotRuntime's default
provider-free route, so assistant model attribution is not normalized away.

The committed `protocol/fixtures/produced-files-wire.json` is the real final
native export, SHA-256
`3b5bfa03ddb8acd455f3b0f00d7f008a694f5080a21d47dc9dccd37fa42aa38e`.
Its payloads are controlled/synthetic and contain no account keys or real user
file contents. Complete command outputs and browser screenshots were downloaded
to the isolated worktree's `dist/file-card-native/` evidence directory.

Reproduce the fresh producer/consumer boundary after syncing source to a remote
Rust machine (these commands must **not** be run on the Mac):

```sh
export XHARNESS_PRODUCED_FILES_WIRE=/tmp/produced-files-wire.json
cargo test --locked -p xharness-host --lib \
  native_file_artifact_wire_survives_live_history_and_jsonl_restart
node --test scripts/test-produced-file-native-wire.mjs
```

This is not a real-model or installed-desktop acceptance run. Linux execution
and cross-platform path fixtures do not substitute for fresh Windows/macOS CI.
No software was installed, restarted, deployed or published; existing running
Agent tasks and user conversations were not interrupted.
