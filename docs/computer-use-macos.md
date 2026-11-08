# macOS Computer Use observation scope and displays

## Accessibility scope

A normal observation prioritizes controls in the frontmost application's
windows and menu bar. It does not traverse every background application's
controls. Optional menu traversal has a separate 750 ms soft budget; a truncated menu
is explicitly reported as `menu_budget`, rather than consuming the rest of the
observation on hidden submenu items. Background window metadata has a separate,
soft one-second budget;
`window/list` retains the full inventory-only budget without reading controls.
Use `accessibility.scope`, `inventory_complete`, `truncated` and
`truncation_reasons`, not the absence of a target, to interpret a partial result.

A `region` selects intersecting AX windows (not individual child clipping) and
omits menu traversal. Node paths retain their original window and child indices.
To operate another app, use a returned `surface_id` with `window/focus`, then
observe again. Window actions do not accept `node_id` or `frame_id`.

The soft AX deadline remains eight seconds, with an independent twelve-second
subprocess watchdog. An individual Apple Event can overrun a soft deadline.
Missing AX controls in custom-rendered apps still require a visual fallback;
this optimization does not manufacture semantic controls.

## Multiple displays and screenshots

Input coordinates and AX bounds are global **logical desktop points**. Displays
to the left or above the main display can have negative origins. Each display's
`pixels` and `scale` use its current backing-pixel mode, not the legacy display
width API that may return logical mode dimensions on Retina screens.

The default screenshot explicitly covers the main display, not the entire
multi-display desktop. Supply `region` to observe a different display. A crop
must fit entirely within one active display; cross-display/off-screen crops
return `screenshot_region_unmapped` instead of a guessed transform. Use separate
crops for different displays, including mixed-scale arrangements. Crop rounding
is reflected in the returned metadata. Invalid post-action crops are rejected
before posting input.

Every returned screenshot includes its actual PNG dimensions and:

```
x_desktop = screenshot.pixel_to_desktop.origin_x
          + x_image * screenshot.pixel_to_desktop.scale_x
y_desktop = screenshot.pixel_to_desktop.origin_y
          + y_image * screenshot.pixel_to_desktop.scale_y
```

For a 2x display, a 64-point crop normally produces 128 image pixels; input
still uses 64 points plus the crop's global origin. Do not apply a global scale
factor to all displays. Point/path validation excludes off-screen gaps, rather
than accepting every point in the bounding rectangle of the desktop.

Display topology is checked again before publishing a frame and before
frame-bound input. Reconnecting a display, changing its resolution, moving it,
or changing the main display requires a fresh observation. This is not an
atomic OS-wide lock: the user can still move a window or change displays after
a check. A successful input acknowledgement is not proof of task completion.

## Validation boundaries

- `scripts/test-macos-accessibility-snapshot.mjs` runs the actual JXA with mocked
  Apple Events, including expensive background windows, scope, deadlines,
  stable paths and secure-input redaction. Mock timings are not live latency.
- Pure geometry/crop/PNG tests run in `xharness-computer-macos` on Linux, and the
  real macOS adapter must also pass a macOS-target compiler/Clippy check.
- Native read-only screen crops can verify per-display pixel dimensions without
  pointer/keyboard input. Live AX latency and input-effect acceptance remain
  separate from pure tests and cross-target compilation.

No dependency changes, permission resets, coordinate replay, installation,
production process restart, or browser/Host lifecycle changes are required.
