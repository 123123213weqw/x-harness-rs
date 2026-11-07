# Session-owned file display panel

The existing right workspace dock owns browser, tool-details and file tabs. File
rendering now registers under the same `workspace.item` slot, in the existing
Browser feature module. It does not create another WebView or editor runtime.

## Entry points

- The model uses the existing `plugin_mcp` gateway, not a standalone `display`
  tool. The in-process reserved namespace is `plugin=builtin`, `server=ui`,
  `tool=display`; it exists on both Web and desktop with no plugin installation,
  external MCP process or native-browser bridge required. Discover it with
  `action=list` and load the full schema with `action=describe`. The authenticated
  session is captured by Host, never accepted from the model arguments. Tool
  allowlists apply before projection. Reads remain under the existing active
  permission preset.

```json
{"action":"call","plugin":"builtin","server":"ui","tool":"display","arguments":{"path":"reports/result.md"}}
```

The compact capability index and built-in UI display remain approval-free like
former `display`. Foreign MCP operations that can start/call a server and native
browser operations retain their existing approval policy, including monotonic
per-request approvals. The gateway registration and guard are bound together;
full-access behavior is unchanged. `builtin` is reserved for Host capabilities,
not an installable plugin identity. The display call keeps its former 30-second
execution deadline and cancellation cleanup; it does not inherit the external
MCP server's 90-second window.

An explicit deployment allowlist containing old `display` now fails visibly.
Migrate it to `plugin_mcp` deliberately; it is **not** silently translated into a
broader external-server capability. Existing direct UI preview RPCs, file links,
wire DTOs, and historical tool rows are unchanged.
- File links in settled replies/tool cards open in the same dock. Explicit folder
  opening (`.` / `..` / trailing separator) retains the original system opener.
  When the connected Host exposes native opening, file tabs also offer an
  explicit “Open externally” action, including for unsupported file errors.
- The browser's blank-tab page offers a file-path input when a session is selected.
- Markdown local links create file tabs; local image references load lazily against
  the Markdown file's parent directory, resolved by the Host OS.

## Ownership and wire

1. `plugin_mcp` routes the built-in display request to the same bounded Host preview reader.
2. Host publishes the existing `host/remote-event` carrier with `display/open`
   and a typed `DisplayOpen`. The receipt is **requested**, not a UI visibility ACK.
   These transient intents are not replayed from historical tool results.
3. The Browser presentation adapter strictly decodes the payload, then asks Layout
   to open the corresponding session's file tab. Background sessions update only
   their own dock and never switch the current conversation.
4. The active `FilePane` calls `display/read` on the existing trusted `/api` channel.
   Host derives cwd and permission from the session; it never reads a browser-local
   path. Alternative runtimes/deployments default to unavailable unless they
   implement the bounded reader seam.
5. Native deployment uses the original contained, no-follow `FsService` opener.
   The UI preview read explicitly does **not** register model observations or
   authorize a subsequent blind overwrite. The ordinary model `read` still does.

`crates/xharness-api/src/display.rs` owns the DTOs. Remote Rust exports JSON Schema
and fixtures; `scripts/generate-file-display-contract.mjs` generates readonly TS
and strict decoders using the shared schema emitter. UI assembly checks freshness;
CI compares against actual Rust output. Neither the frozen RPC catalogue nor
historical tool/session payloads change.

## Rendering and bounds

- Markdown reuses the existing GFM/KaTeX/code renderer. Owner-provided resource
  hooks apply only to file preview; ordinary chat's URL policy stays unchanged.
- PNG/JPEG/WebP/GIF are identified by bytes, not filename. The existing attachment
  decoder validates format/pixels without persisting an attachment or sending
  image content to the model. Blob URLs are presentation-owned.
- UTF-8 text/code is rendered readonly. HTML is text, not an executable page.
  Raw Markdown HTML stays literal; remote links retain the existing safe policy.
- Maximum text: 512 KiB. Maximum image source: 8 MiB, 16 Mi pixels. Oversized or
  unsupported files fail visibly; there is no silent truncation.
- The existing native display reader keeps its two-read limit. Adaptive raster
  derivatives and historical thumbnails additionally share one blocking decoder
  slot; its permit remains held even if the requesting future is cancelled.
- Each Markdown preview admits at most eight local images, with aggregate source
  bytes limited to 16 MiB and estimated decoded RGBA bytes limited to 64 MiB.
  References beyond the budget offer an explicit separate-file preview.
- Close, refresh, source toggle and unmount release the corresponding owned
  resources. Retained static PNG/JPEG file tabs unmount their raster on hide,
  keeping bounded compressed bytes plus zoom/scroll. A shared 12-entry / 32 MiB
  encoded URL pool reuses the URL while keeping its decoded budget charged;
  pressure can evict inactive entries. Revisit needs no second Host read, so
  offline/deleted/changed source files do not silently change an already-open
  preview. Only explicit refresh rereads the source; errors remain retryable.
- APNG, GIF, WebP, unknown/malformed raster headers and PDF keep their prior
  retained lifetime by default, including local Markdown animation/unknown-format
  decoders. Hidden local Markdown static raster DOM also suspends, with a
  browser-decoded (EXIF-aware) aspect-ratio placeholder and bounded URL reuse. PDF has an explicit
  Pause/Resume action warning that reading position can reset; automatic hidden
  teardown remains disabled. Rebuilding an animated decoder/native PDF viewer
  can lose playback/page/zoom/selection state. Existing four-page/idle
  eviction still applies. Hidden initial static-image reads may finish into
  compressed bytes, never a mounted raster/URL. Closing aborts the read, and a
  late response cannot resurrect it.
- File contents are not retained in the global session cache or localStorage.
  File tabs are transient, like tool-details tabs; the existing persisted
  browser-tab contract is unchanged.

## Acceptance

Rust tests on the remote node cover the real native reader, path escape/symlink,
corrupt/binary/large files, image display without model vision, strict tool args,
allowlists, weak Host lifetime, observation isolation, and a real Host HTTP route.

Chromium/WebKit full-owned-graph tests inject only the fixture Host transport and
exercise the actual Host-event receiver, model display adapter, dock routing,
Markdown/table/math/local-image/code rendering, refresh, source view, image zoom,
reuse, background isolation, visible failure and per-resource Blob cleanup.
These browser tests are not claimed as native WKWebView/WebView2 acceptance.

Commands:

```sh
# Rust only on a synced remote server.
cargo test --locked -p xharness-host-app --test file_display
cargo test --locked -p xharness-host-app --lib builtin_ui
cargo test --locked -p xharness-api
cargo test --locked -p xharness-fs

# Local JS/TS is allowed.
node scripts/generate-file-display-contract.mjs --check
npm run build --prefix ui
node --test scripts/test-file-display-source.mjs
UI_TEST_BROWSER=chromium node scripts/test-file-display-browser.mjs
UI_TEST_BROWSER=webkit node scripts/test-file-display-browser.mjs
```

## Read-only Diff display

The same file slot now renders `.diff` / `.patch` as a typed `diff` result. The
model uses the same built-in display capability through `plugin_mcp`; these
objects are its nested `arguments`:

```json
{"path":"changes.patch"}
{"path":".","gitDiff":"working"}
{"path":"src/main.rs","gitDiff":"staged"}
{"path":"src/","gitDiff":"head"}
```

- `working`: tracked worktree vs index; `staged`: index vs HEAD (also works for
  an unborn repository); `head`: tracked worktree vs HEAD. Git must be installed
  on the connected Host. These are workspace scopes, **not** turn checkpoints.
  Untracked files and submodule internals are explicitly excluded. This does
  not replace the existing GitHub PR/AI Code Review feature.
- The browser blank-tab form offers **Git Diff**; an empty path means the session
  workspace. Scope changes use separate/reusable file tabs keyed by scope as
  well as session, path and Markdown resource base.
- Native Git uses fixed executable+argv through `NativePlatform` and the managed
  process supervisor. Even full-access sessions use a read-only, offline native
  sandbox for this adapter; unavailable sandbox/Git fails visibly, never falls
  back to an unconfined process. It uses literal pathspecs inside the session
  workspace, disables external diff/textconv/fsmonitor/pager and global/system
  Git config, and never inherits credentials or ambient `GIT_*` settings.
  A managed, bounded config scan (16 KiB; at most 64 filter drivers) disables
  repository `clean` / `process` filters and their `required` flag before diff.
  This is necessary because `--no-ext-diff --no-textconv` alone still executes
  clean filters. Malformed, ambiguous or oversized filter configuration fails
  visibly. Scan and diff share one 15-second deadline and joined cancellation.
  Only the exact verified enclosing worktree is explicitly trusted by
  `safe.directory`; no wildcard or ambient trust list is admitted. Fixed
  `--git-dir` / `--work-tree` arguments allow a workspace below the repository
  root without exposing sibling worktree files. Only validated Git metadata
  directories are added as read-only sandbox roots. Linked-worktree pointers
  are bounded and verified against their back-reference; symlinks, reparse
  points and malformed pointers fail closed. Ordinary `.git/worktrees/<id>`
  layouts are supported; bare-linked and custom separate-Git-directory layouts
  are explicitly rejected rather than broadening access. Windows verbatim disk/UNC paths
  are normalized only for the Git configuration value, without lossy Unicode
  conversion; containment and native sandbox paths stay canonical. Missing
  partial-clone objects fail visibly: lazy fetch is disabled and Git's transport
  protocol whitelist is empty, including on platforms with partial network
  confinement.
- Only tracked text diff is requested (three context lines, no rename detection;
  a Git rename appears as add/delete). Patch files can also display explicit
  rename, mode and binary metadata. Content is readonly and never applied.
- Cancellation joins process/pipe cleanup. Git is limited to 15 seconds and
  512 KiB captured stdout; oversized output fails with a narrower-scope hint,
  never silently displays a truncated patch as complete.
- The UI has file list, true old/new line numbers, +/- counts, unified/side-by-side
  views and complete raw source. Only the selected file's viewport rows mount.
  Parsing is capped at 20,000 lines and 1,024 framed files. Malformed hunks,
  combined diffs and encoded binary patches retain their raw source with a
  visible unsupported/error state, not a made-up partial valid diff.
- Code Review and file display now share the original strict readonly hunk
  coordinate parser under `shared/diff`; evidence validation rules are unchanged.
  The internal Layout event's scope values are also generated from Rust, without
  adding a second Zod runtime to the Layout bundle.

Additional acceptance covers actual Git repositories (three scopes, deleted and
literal paths, clean and unborn repos, binary/oversize errors, external helper
suppression, unchanged index/files), a real Host HTTP Git route, model display
intent ownership, active-child cancellation, and Chromium/WebKit full-graph
Diff tabs with 7,000-row windowing and source fallback.

## Dependency boundary review (integration)

`xharness-host-app` explicitly owns the native Git display composition. Its two
reviewed edges to `xharness-process` and `xharness-sandbox` reuse the existing
managed supervisor and read-only policy type; they do not move process/native
logic into Core, Session, API or UI. The architecture allowlist records only
these concrete edges and continues rejecting unreviewed dependencies.


## Memory experiments (2026-11-03)

All fixtures below are synthetic and isolated from the running application and
user sessions. This table records the initial experiment, not a permanent claim
that a released URL frees native memory. The subsequent historical-thumbnail,
decoded-admission and oversized-code implementation is documented in
`ui-image-memory-admission.md`; it adds an optional authorized derivative read
without changing original/model bytes. Installed App, background task,
dependency and default history-cache limits remain unchanged.

| Experiment | Result / corner cases | Default decision |
| --- | --- | --- |
| True-size thumbnails | Three 3200×2000/portrait images plus a 32×24 control: nominal decoded RGBA 76,803,072 → 1,731,072 bytes. The synthetic transport serves physically smaller, aspect-preserving images (480px longest side, for 240 CSS px at 2×), not a CSS resize of originals. Only a clicked original crosses the transport; cancelling a pending original cannot reopen the lightbox. | Initial prototype. The subsequent bounded Host variant and explicit old-Host/unsupported fallback are described in the admission document. Workspace file-inspection thumbnails are not a substitute for historical attachment ownership. |
| Shared decoded-image admission | Prototype reserves `width × height × 4` before asynchronous loads, accounts simultaneous reservations, rejects unsafe dimensions, refuses oversized work without evicting an existing visible lease, and releases exactly once even on stale completion/cleanup failure. | Production admission now shares a 128 MiB estimated RGBA ledger across historical thumbnails/original dialogs, workspace raster previews and local Markdown images, with visible refusal/retry. Not an app-wide native-memory cap. Decoder scratch, animation/GPU/cache residency can exceed accounting; drafts retain their existing policy. Never drop sent attachments or change model context. |
| Hidden heavy previews | Real FilePane and URL cleanup tested with zoom, horizontal/vertical scroll, repeated hide/show, StrictMode effect replay, slow hidden/closed reads, file deletion/offline revisit and explicit refresh failure/retry. PDF and animated decoder DOM identity must stay identical across hide/show. | Enable static PNG/JPEG suspension only. Preserve compressed bytes (≤8 MiB per image under the existing retained-page bound), not just a path. PDF/animation unloading deferred until playback/reader state can be round-tripped. |
| Inactive sessions | Real SessionManager/assembler experiments compare default six inactive windows against two/zero. Raw event windows become GC-reclaimable; the real InputMachine facade keeps draft text, undo/redo and attachment IDs. Existing running, question, approval, queue, in-flight request/command, epoch and bookmark protections remain covered. | Keep six/64 MiB defaults. Smaller limits force more rereads and make an evicted chat unavailable offline; a current/running/pending session is not disposable UI data. No Host cancellation/compaction/replay is used for eviction. |

In the 32-session × 160-event × 2,048-character synthetic fixture, Chromium's
post-GC JS heap measured about 19.16 MiB with an effectively unbounded inactive
cache, 10.54 MiB at the existing six-window limit, 9.25 MiB at two, and 8.58 MiB
at zero. These include fixed fixture/runtime overhead. WebKit runs the same
residency/state assertions but does not report a Chromium heap metric. In a
separate four-chat / twelve-visit fixture, lowering six to two increased history
reads from four to twelve; an offline revisit then failed for the evicted chat
while the default policy still displayed its cached history. This is the reason
not to change the default merely because the smaller heap is measurable.

The native WebKit allocator may cache decoded data after a DOM node and Blob URL
are released. RGBA input accounting, tracked URL lifetime, payload estimates and
Chromium post-GC JS heap are **not** macOS physical footprint and do not prove
that the installed application's long-running memory issue is resolved. Native
soak verification is still needed before any release/install decision.

The existing CI entrypoints `test-file-display-source.mjs`,
`test-file-display-browser.mjs` (Chromium/WebKit) and
`test-session-history-cache.mjs` (Chromium/WebKit) run the experiments. Fixture
helpers under `scripts/fixtures/ui-memory-*` are never imported by product code
or shipped in the assembled UI.


### Adaptive raster resource policy

Workspace fits now use the session-authorized `display/image-preview` derivative
at panel × DPR resolution. Explicit zoom uses source-bound original bytes. Hidden
static raster DOM suspends, but a bounded URL cache remains charged to the shared
image budget and is evictable under pressure; close/refresh revokes its owner.
Animated originals preserve playback identity. Native PDF suspension is explicit
only, with a reading-position-reset warning. See `ui-image-memory-admission.md`.
