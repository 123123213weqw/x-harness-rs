# Session-owned file display panel

The existing right workspace dock owns browser, tool-details and file tabs. File
rendering now registers under the same `workspace.item` slot, in the existing
Browser feature module. It does not create another WebView or editor runtime.

## Entry points

- The model has one `display({"path":"reports/result.md"})` tool. The authenticated
  session is captured by Host, never accepted from the model arguments. Tool
  allowlists apply before projection. Reads remain under the existing active
  permission preset.
- File links in settled replies/tool cards open in the same dock. Explicit folder
  opening (`.` / `..` / trailing separator) retains the original system opener.
  When the connected Host exposes native opening, file tabs also offer an
  explicit “Open externally” action, including for unsupported file errors.
- The browser's blank-tab page offers a file-path input when a session is selected.
- Markdown local links create file tabs; local image references load lazily against
  the Markdown file's parent directory, resolved by the Host OS.

## Ownership and wire

1. `display` validates a bounded preview through the deployment reader.
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
- Two native preview reads/decodes may run at once. Decoder work retains its
  semaphore permit even if the requesting future is cancelled.
- Each Markdown preview admits at most eight local images, with aggregate source
  bytes limited to 16 MiB and estimated decoded RGBA bytes limited to 64 MiB.
  References beyond the budget offer an explicit separate-file preview.
- Collapse, close, switch, refresh, source toggle and unmount abort outstanding
  reads and revoke owned Blob URLs. File contents are not retained in the global
  session cache or localStorage. File tabs are transient, like tool-details tabs;
  the existing persisted browser-tab contract is unchanged.

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
model still has only one display tool:

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
