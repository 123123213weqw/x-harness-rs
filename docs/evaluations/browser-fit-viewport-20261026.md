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
- Initial remote Linux desktop unit tests: 92 passed; all-target Clippy passed.
- Initial genuine native fit test FAILED: GtkBox allocation stayed 800 x 300,
  yielding a 2403 x 901 CSS viewport after zoom. This was not accepted as a pass.
- A follow-up GTK overlay build also passed 92 unit tests and all-target Clippy,
  but its native contract still failed. It is not accepted as a pass.
- The latest source adds explicit GTK overlay slot allocation and bounded
  post-position AppKit inset calibration. Native revalidation of this latest
  source is pending because V100 SSH connections repeatedly time out/reset.
  Temporary network failure is not evidence of a code pass or a permanent block.
- macOS/Windows native validation: not yet run for this change. No three-platform
  parity or installed-client acceptance claim is made.

Rust compilation/testing is remote-only on WZU_Server. Intermittent SSH failures
were handled through its existing alternate SSH port; TLS/host-key checks and
installed software were not changed. Build resources include a cached genuine
Host sidecar solely to satisfy Tauri packaging prerequisites; the native probe
starts no Host or model. Interrupted/failed source transfers are not validation.
