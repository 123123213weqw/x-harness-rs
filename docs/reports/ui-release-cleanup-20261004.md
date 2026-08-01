# UI release cleanup, 2026-10-04

Desktop 0.2.33 faithfully packaged master `c8440ae`, but that master omitted
four UI cleanups already present in the local preview. This repair restores
the intended product UI in repository sources and generated distribution files:

- Expanded and collapsed sidebars have no session-search button or field.
- Browser panes have no engine-status footer or empty strip reserving its height.
- Browser tabs have no leading decorative glyph; file and tool labels retain theirs.
- The native updater occupies a sidebar footer row above Tasks and Settings.
  It follows resize and sidebar remounts, releases its observers on page exit,
  and reserves no row in a plain Web or unconfigured desktop environment.

Session search data contracts remain available. Browser navigation, errors,
download records, native visibility/overlay coordination, updater confirmation
and installation commands keep their existing behavior.

## Validation

Workspace module tests include an intact frozen positive control with search
present and current-product controls with search absent. Complete generated UI
boot checks count this explicit product change independently; all other
controls and the conversation pixels after the existing regional geometry
projection still compare exactly against the immutable frozen reference.
No reference bytes, pixel tolerances, masks or baseline hashes were changed.

Local validation passed:

- 12 workspace module cases, 74 view-module cases, 16 desktop-updater cases,
  strict source/type policy and reproducible distribution verification.
- Chromium and WebKit: expanded/collapsed workspace browsing, browser panes,
  browser dock and native bridge lifecycle/download records.
- Chromium and WebKit: 24 updater stacking/layout cases per engine, covering
  Tasks hit targets, short viewports, long notes, confirmation, Escape/focus
  and the editable composer.
- Full generated graph: source, frozen and geometry-projected source boots in
  both engines, including model/provider/effort controls and exact conversation
  pixel parity.

The old 0.2.33 updater script fails the new real-layout test at
`Reserved row keeps updater above Tasks with no overlapping hit targets`.
The repaired script passes the same assertion in both engines.

The changes are covered by existing required CI entries. Their publication
and installed-App acceptance are separate from these local test results.
