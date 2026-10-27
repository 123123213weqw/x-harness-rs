# Chat-owned Chrome / Edge browser

The desktop's default **new-task** browser is a fresh, independent background
instance of an installed Chrome or Edge. It is not an attachment to the user's
running browser and does not inherit its profile, login, cookies or extensions.
There is no production Node, Playwright, browser download or bundled Chromium.

## Control path

```
SessionToolFactory (actual chat owner)
  -> plugin_mcp: @xharness/native-browser / browser
  -> existing authenticated, bounded loopback desktop bridge
  -> Rust Browsers manager -> private CDP -> installed Chrome / Edge
                                      |
                                      +-> optional JPEG preview in sidebar
```

The same lazy MCP entry exposes the existing five operations: `control`,
`observe`, `perform`, `screenshot`, and `input`. Discovery does not launch a
browser. Existing tool guards, screenshot normalization/media attachments and
cancellation remain in the Host adapter. No new top-level model tool is added.

Example discovery and opening (not arbitrary JavaScript):

```json
{"action":"list","plugin":"@xharness/native-browser"}
{"action":"describe","plugin":"@xharness/native-browser","server":"browser","tool":"control"}
{"action":"call","plugin":"@xharness/native-browser","server":"browser","tool":"control","arguments":{"action":"open","url":"https://example.com/"}}
```

The Host supplies the owner; model arguments cannot select another chat or tab.
`webview` remains a separate explicit server for existing visible pages and
manual/login workflows. No silent backend switch or cookie transfer occurs.
The separately installed `browser-use` plugin is not replaced.

## Lifetime and preview

- One page/browser per chat; four live chat browsers maximum. Opening again
  navigates that same chat's page. Capacity errors require explicit closure,
  rather than evicting a running task.
- Collapse, chat switching, preview unmount and document backgrounding do not
  revoke control. Only a visible preview polls, at most once per second, with
  one in-flight read. Preview skips busy control rather than adding a capture
  queue; an in-flight preview is abandoned after 350 ms to bound control delay.
- The page has a fixed 1280×720 CSS viewport. The sidebar scales a 640×360 JPEG
  using `object-fit: contain`; narrowing it does not narrow the actual page.
  Model screenshots remain full-viewport PNGs with coordinate metadata.
- Explicit close, session retirement and graceful desktop shutdown release the
  owned browser. A same-executable helper holds the Chrome child and a parent
  stdin-pipe lease. Unexpected desktop death closes the lease; the helper
  reaps its exact child and removes only its temporary profile.
- UI close includes the exact tab ID. Stale closure/events cannot target a
  successor or another chat. Background chat events do not steal foreground
  focus or expand its sidebar.

## Evidence and action semantics

Bounded DOM observation reuses the native browser's fixed observation script
and action schemas, including pagination and password filtering. Observe/PNG
creates a one-shot frame. Effects consume it before dispatch and validate
current URL, DOM revision, scroll and viewport. Preview reads do not consume it.
Only invalidated **read-only observations** can be retried automatically.
Unknown input outcomes are not replayed. A subsequent operation can balance an
abandoned key/button release, but never repeats its down/click.

Browser-protocol mouse/key input produces trusted browser events and can target
cross-origin iframe pixels. This is not global OS input. Dispatch acknowledgement
is not proof of application success: inspect actual state afterward. Navigation
readiness checks the new document's loader rather than accepting the old page.

## Current boundaries

- No arbitrary JavaScript/selectors, cookie export, cross-origin DOM traversal,
  recording, multiple-page management or human click-through in the preview.
- Downloads are denied; pop-up and JavaScript-dialog workflows are not yet
  exposed. Keep explicit WebView workflows for capabilities requiring them.
- Failure to start a compatible installed Chrome/Edge is reported; no browser
  download or access to an existing user profile is attempted.
- This is a desktop bridge capability. A standalone Web/remote Host without
  that bridge is not advertised as having a local browser.
- Profiles are ephemeral. App restart does not promise login/tab recovery.
- Linux real-engine tests and UI transport tests are separate evidence. They
  are not an LLM end-to-end or signed macOS/Windows installation acceptance.

## Regression commands

All Rust commands run **remotely after rsync**, never on the development Mac:

```sh
cargo test --locked -p xharness-host-app --lib
cargo clippy --locked -p xharness-host-app --all-targets -- -D warnings
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --example headless-browser-probe
python3 scripts/gui_bench/owned_browser_acceptance.py \
  --binary apps/desktop/src-tauri/target/debug/examples/headless-browser-probe \
  --cycles 100 --output dist/owned-browser-acceptance
```

Use the locked test-only Python requirements in
`scripts/gui_bench/owned-browser-requirements.txt`. CI enrolls the same real
engine/lifetime acceptance in the existing Linux, macOS and Windows desktop
jobs, using runner-installed Chrome/Edge. Absence/failure is not silently skipped.
Existing native WebView tests and Chromium/WebKit UI regressions stay enrolled.
See the dated evaluation for actual completed coverage, not inferred passes.
