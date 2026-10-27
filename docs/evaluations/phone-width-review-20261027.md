# Phone-width review follow-up — 2026-10-27

- Merged current master (98ba4c30) into the PR branch. Only the generated manifest,
  graph and HTML conflicted; rebuilt the complete UI from merged owned sources
  rather than manually choosing asset hashes.
- Added the shared Swarm synchronization correction: review waits for a committed
  Delivered marker; unrelated follow-up waits for the idle driver as well as its
  exact durable turn. Deadlines, CAS and evidence checks are not relaxed.
- WZU_Server shared Host regression: 470 passed, 8 pre-existing opt-in ignores,
  all-target warning-denying Clippy, then 30 rounds of all 29 Swarm tests passed.
- Strict owned UI build/check, 24 conversation source tests and 4 layout tests
  passed. Chromium and WebKit passed the real source-built dock regression and
  composer suite (20 light/dark widths each).
- Added real coarse-pointer page checks at 320/375/426/600px: zero frame gutter,
  no card border/radius, no document horizontal overflow, 44px new-session
  target. Separate fine-pointer pages still exercise narrow/wide row actions,
  keyboard menu and rename focus behavior on both engines.

Tests use isolated fixture pages and synthetic transport, not a production Host
or account. The first test attempted to assert the coarse-pointer target size on
its fine-pointer page; it was corrected by adding a separate actual touch context,
not by changing product CSS or weakening the touch assertion. Cross-platform CI
must pass on this new head before merge. No running software was changed.
