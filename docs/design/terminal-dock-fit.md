# Measured terminal dock fitting

The bottom terminal remains a body portal scoped to the current chat's existing
DockStore. Server PTYs, transport, history and execution ownership are unchanged.

## Grid geometry

The exact vendored xterm bytes are already pinned in `ui/modules.json`. A narrow,
guarded adapter reads that version's actual CSS renderer cell width/height and
viewport scrollbar reservation. Font-size times line-height is not a cell metric:
the former 15px estimate produced 18px cells in both real browser engines and cut
off the bottom rows. Fitting now subtracts the host's computed padding and xterm's
scrollbar band before calculating whole cells. Zero/invalid metrics and hidden or
degenerate hosts retain the old grid until a real measurement is available.

One ResizeObserver and a coalesced animation frame handle viewport changes. Public
xterm render notifications schedule work only when cell metrics change (including
the first connected measurement); unchanged output does not resize the PTY. A font
readiness completion and window resize handle late fonts and scale changes. All
observers, render listeners and pending frames are disposed with the viewport.
No polling, global font-cell cache, new dependency or vendor edits are introduced.

## Shared height bound

The body-scoped dock height is one CSS `min(savedHeight, max(0px, 100vh - 220px))`
expression. Both panel max-height and center-column reservation consume it, so a
persisted tall dock cannot reserve more space than it actually occupies after a
window shrinks. The persisted preferred height is retained for later expansion.
Closing keeps the geometry through the exit animation; reduced motion also turns
off the reservation transition.

## Contracts and acceptance

The redesigned stylesheet has an independent exact SHA-256 pin and negative
controls for unrelated appended styles, trigger changes and overflow changes.
The frozen reference remains unchanged. New two-engine browser CI cases execute
the actual shipped module, real pinned xterm, platform React and synthetic PTY HTTP
replies. They cover grid clipping, scrollbar/padding accounting, short windows,
persisted height, stable output without PTY resize churn, hidden composer portals,
keyboard close/reopen, reduced motion and observer disposal. Unit cases exercise
unmeasured/invalid cells, zero-size hosts and narrow grids. Existing browser dock,
native bridge, terminal lifecycle and strict pixel gates remain in force.

These are isolated functional/lifecycle checks, not a native WebView memory
benchmark, release, installation or restart of any user's App or Host.
