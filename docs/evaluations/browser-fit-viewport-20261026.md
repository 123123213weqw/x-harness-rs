# Fixed CSS browser viewport / fit-to-pane

## Scope

Keep the native Tauri browser and existing `plugin_mcp` observation/input gateway.
The desktop UI defaults to a requested 1280 x 720 CSS viewport, with 1440 x 900,
1920 x 1080 and an explicit responsive mode. Sidebar geometry is presentation,
not the website's layout viewport. No browser streaming loop or new browser
process is introduced. No installed application is replaced by this change.

## Implementation

- Pure, bounded presentation planning lives in `browser_viewport.rs`.
- Native page zoom and letterboxed child bounds fit the requested CSS viewport.
  Public AppKit content geometry accounts for a titlebar inset without assuming
  a fixed height. Actual observed dimensions, not a requested label, must pass
  verification before an observation/screenshot becomes an actionable frame.
- GTK needs an owned `GtkOverlay` slot for each child: Wry 0.55.1's GtkBox path
  packs expanding siblings and its `set_bounds` is a no-op on that path. The
  main renderer retains its existing box. Browser slots occupy only their actual
  rectangles; there is no full-window transparent input layer. Hidden tabs are
  never exposed via `show_all`.
- AppKit/GDK input maps observed CSS coordinates to native content points.
  WebView2 CDP already consumes CSS coordinates and is not scaled again.
  Display/image coordinates must not be multiplied blindly by DPR.
- Layout changes invalidate old frames, share the per-tab operation gate and
  recheck active-tab ownership. Native screenshot metadata reports actual PNG
  dimensions separately from CSS viewport dimensions. Small screenshots are not
  upscaled and represented as original high-resolution captures.

## Acceptance

The existing genuine native WebView probe now adds 426, 640 and 360 pixel pane
cases. Each must retain approximately 1280 x 720 CSS layout, dispatch real trusted
clicks to all four corners and a checkbox in a 1000-pixel centered panel, reject
an old frame after resize and restore responsive layout. An independent stdlib
PNG checker verifies all four colored corner pixels using actual image/CSS
ratios. Missing, duplicated or inconsistent evidence fails the overall runner.
This runs through the existing native probe CI entry on Linux/macOS/Windows;
Playwright UI mocks are explicitly not native acceptance.

## Validation status

- Strict UI types and reproducible repository-only build: passed.
- Chromium/WebKit browser-pane and native-boundary UI regressions: passed.
- Chromium/WebKit component picker: 10 cases each passed.
- Python native acceptance/checker regressions: 25 tests passed.
- Architecture freeze and formatting: passed at the recorded working-tree base.
- V100 Linux desktop unit tests: 92 passed; all-target Clippy passed.
- Initial genuine native fit test FAILED: GtkBox allocation stayed 800 x 300,
  yielding a 2403 x 901 CSS viewport after zoom. It was not accepted as a pass.
- Corrected native allocation uses explicit GTK overlay slot placement. Native
  tests measure the content allocation, not Wry's pre-margin allocated_size.
- A subsequent first-click failure was traced to the preceding picker's deliberate
  400 ms release-click suppression. The independent viewport probe now runs
  before the picker; picker assertions and suppression behavior are unchanged.
  Initial macOS CI independently exhibited that same fixture interference.
- V7 final functional Linux contract PASSED on three consecutive isolated runs:
  16.569 s / 16.647 s / 16.599 s; same compiled binary. All three narrow panes
  retained width 1280 and height 720/721 CSS pixels, all native corner/modal input
  checks passed, and the independent PNG checker verified all four corners.
  Original PNGs were downloaded and independently rechecked locally as well.
- V8 adds a cancelled-callback guard and checked margin arithmetic; its exact-source
  native rerun is pending. No new UI behavior is introduced by these guards.
- macOS/Windows exact-head native CI remains pending. The native matrix currently
  certifies the default 1280 x 720 viewport, not a blanket claim for every preset,
  OS, high-DPI display or installed package. No software was installed/restarted.

Rust compilation/testing is remote-only on WZU_Server. Intermittent SSH failures
were handled through its existing alternate SSH port; TLS/host-key checks and
installed software were not changed. Build resources include a cached genuine
Host sidecar solely to satisfy Tauri packaging prerequisites; the native probe
starts no Host or model. Interrupted/failed source transfers are not validation.

Implementation references: [pinned Wry GTK backend](https://github.com/tauri-apps/wry/blob/wry-v0.55.1/src/webkitgtk/mod.rs), [GTK overlay placement](https://docs.gtk.org/gtk3/signal.Overlay.get-child-position.html). No vendored dependency source was modified.
