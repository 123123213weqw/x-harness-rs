# Browser images and native input

The sidebar is a scaled preview, not the model's coordinate system. A narrow
preview must not silently redefine the fixed CSS viewport or move the system
pointer. Existing browser instances, profiles and login state stay in place.

## Shared Host contract

- `viewport` is the CSS viewport. `image` is the **final attached PNG**, after
  decoding and the existing 1600-pixel longest-edge budget; it is not a copy of
  the bridge's pre-normalization size. `source_image` records the decoded input.
- `image_to_viewport.scale_x/scale_y` describe the final image-to-CSS transform.
  `resolution.css_1x_or_better` reports actual density, not requested density.
  `host_upscaled=false` means Host normalization never enlarges an image; it is
  not a claim that accelerated video/WebGL will appear in a native snapshot.
- `input` defaults to CSS coordinates for backward compatibility. For a click
  or move located in an attached screenshot, pass `coordinate_space: "image"`
  with that screenshot's `frame_id`. The Host applies the stored transform and
  sends the unchanged CSS wire format to the desktop bridge.
- The stored transform is one-shot, scoped to the chat owner and browser
  backend, expires after 120 seconds, and is bounded to 64 owners. A new
  observation/effect invalidates the owner's old transform. Invalid, stale or
  out-of-image points fail before native dispatch; callers cannot supply a
  replacement scale. The desktop still enforces its own owner/epoch/frame.
- A screenshot is remembered only after successful image projection. No Base64
  payload is kept in this cache or copied into the conversation transcript.
- `stale_frame` means obtain fresh browser evidence, not bypass the browser
  error with shell-based system input. This is routing guidance, not an OS-input
  sandbox for a Full Access shell.

## Native adapters

The shared capture plan preserves useful native density, requests at least one
image pixel per CSS pixel when the 1600-edge budget permits, and never treats
bitmap interpolation as recovered detail.

| Backend | Capture path | Limitation |
| --- | --- | --- |
| macOS WKWebView | `WKSnapshotConfiguration.snapshotWidth`, converting image pixels to backing points | Native rendering can omit accelerated surfaces. No live resize or page-zoom change is requested. |
| Windows WebView2 | CDP viewport clip and output scale, using controller zoom and native raster scale | Pinch-scaled ambiguous geometry is rejected. Native CI must verify layout and thin-line detail, not only output dimensions. |
| Linux WebKitGTK | Existing visible native snapshot | The public snapshot API has no independent output-width control. A narrow preview may remain undersampled; actual final density is reported, not hidden by upscaling. |
| Owned Chrome/Edge | Existing isolated background viewport | Shares final-image metadata and frame-bound input conversion; does not inherit another browser's cookies. |

Linux full-resolution rendering requires separate renderer/preview work. An
offscreen screenshot alone is not acceptance of focus, manual input, dialogs,
tab hiding or cleanup. Do not temporarily rezoom a live page, reload it in a
different profile, or resize the returned bitmap to claim that work is done.

## Acceptance

The production native probe uses three narrow panes with a fixed CSS viewport.
It verifies actual four-corner PNG pixels, trusted native clicks, a checkbox,
resize-invalidated frames and restoration of responsive mode. macOS/Windows
also require CSS-1x evidence and thin-line contrast; a resolution-media-query
sentinel must stay at the same position in the live page **and** the screenshot.
That catches nominally large but blurred images and capture-only layout changes.
Linux's current native-resolution limitation is explicit, not counted as a
successful high-resolution implementation.

Host regressions compare final metadata with the real projected attachment,
exercise both image and legacy CSS coordinates, reject wrong owners/backends,
stale frames and out-of-range points, and preserve bounded byte/pixel decoding.
