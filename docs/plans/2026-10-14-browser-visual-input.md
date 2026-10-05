# Native browser visual input (2026-10-14)

## Model interface and separation

No additional top-level tool. The lazy `plugin_mcp` namespace remains
`@xharness/native-browser / webview`:

- `control`: discover/open the visible chat-owned tab.
- `observe`: bounded, paginated DOM evidence; includes CSS viewport and node bounds.
- `perform`: existing ref-based DOM click/fill/select/scroll, unchanged semantics.
- `screenshot`: native visible viewport pixels, projected as an actual model image.
- `input`: one browser-owned native left click, move/hover or balanced keypress.

Use DOM observation/actions where sufficient. Use native pixels and input for
canvas/custom controls, hover/keyboard interactions and cross-origin iframe
**visual** targets. This is not cross-origin element discovery or global OS input. System WebView
snapshots may omit hardware-accelerated video/WebGL; do not claim universal
screen-capture parity.
There is no recording, drag, right/double click, arbitrary keycode/JS/selector,
background-tab control or IME text-entry API in this change. Text fields retain
DOM fill. Key support is explicitly a-z, navigation/editing keys, and portable
Shift/Control/Alt/Meta modifiers; Meta maps to Command on macOS.

## Implementation boundaries

- Desktop owns WKWebView/NSEvent, WebKitGTK/GDK and WebView2 CDP adapters.
  Native objects remain on their WebView UI thread/apartment.
- Host captures session identity, applies existing MCP approval and projects
  screenshots through the existing session-scoped attachment service. Core and
  provider adapters receive the same image ContentBlock used for computer/read.
- Only screenshot replies may use a 12 MiB bounded loopback envelope. Other
  replies retain 64 KiB and requests retain 32 KiB. Native PNG is capped at
  8 MiB / 16M pixels. Host bounded decoding shrinks large images to at most
  1600px per side, never enlarges small images. A single Host image permit bounds
  transient decoding across concurrent chats. Base64 is removed before ToolOutput;
  history holds references, not image bytes. No new screenshot temp-file directory.
- Screenshot returns a new one-shot frame and CSS viewport dimensions. Image
  coordinates must be mapped proportionally; native input is never global
  screen-coordinate input. Input may also consume a fresh DOM frame.
- Per-tab gate, identity/epoch checks and visible-session/origin grants apply to
  both operations. Input consumes its frame before scheduling. Resize/layout
  changes invalidate old frames. UI-thread guards use a nonblocking registry lookup (no lock held across native
  getters). Every queued native closure rechecks binding,
  cancellation and deadline on the UI thread. Pointer/key press/release pairs
  dispatch together, so caller cancellation cannot omit a scheduled release.
- After dispatch, callback loss/browser change yields `effect=unknown`, never
  automatic replay. `applied` is native dispatch, not page/task success. Observe
  afterward. Cross-origin DOM same-origin restrictions are not disabled.

## Regression gates

1. Host lazy-tool tests: true image metadata, no base64 transcript, nonvision and
   extra-argument rejection before capture, bounded decode/transport, ownership,
   cancellation and unknown-effect projection.
2. Existing Chromium/WebKit DOM suite: pagination, password redaction, stale
   refs/modal/user edit and callback behavior must remain intact.
3. Native production bridge probe on each platform: capture actual PNG, trusted
   pointer/key/hover, Shift key result, cross-origin coordinate click, denied
   wrong owner, duplicate/stale frame and hidden screenshot. Native API prototype
   retains independent changed-pixel PNG grading. Standard and Overlay macOS
   titlebars must both pass; use remote/GitHub compilation, never local Rust.
4. All native desktop check/test/Clippy and repository CI gates stay mandatory.
   No release/app replacement is implied by source or native-probe success.

Primary API references:
- [WebView2 CDP](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/chromium-devtools-protocol)
- [Chromium Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)
- [WKWebView snapshot](https://developer.apple.com/documentation/webkit/wkwebview/takesnapshot(with:completionhandler:))
- [WebKitGTK snapshot](https://webkitgtk.org/reference/webkit2gtk/stable/method.WebView.get_snapshot.html)

This document records implemented boundaries, not blanket browser parity or a
claim that CI for an earlier candidate validates a later one.
