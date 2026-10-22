# Plan/composer scroll containment

## Root cause

The installed 0.2.56 application and the inspected master snapshot have identical
`ProgressDock`, `InputBar`, and `ConversationRoot` styles. The plan's accessible
status text uses absolutely positioned, visually hidden spans. Without a
positioned ancestor inside the list, their containing block is the outer
composer card. Those spans escape the list's overflow clipping and enlarge the
conversation's scrollable overflow despite the visible list staying bounded.

An isolated production-component fixture with 18 wrapped plan entries reproduced
this in both macOS Chromium and WebKit. At 1100 x 640, the conversation reported
1,240px of scrollable content instead of approximately 600px of normal flow.
Scrolling to that false floor moved the entire sticky composer above the viewport.
No Host, model requests, or user conversations were used in the fixture.

## Fix

Make each plan row a positioned containing block with `position: relative`.
The hidden status remains accessible but is now anchored within the list's
clipping boundary. This does not change visible row geometry, the list's existing
height limit, task data, plan expansion defaults, or execution behavior. No
scroll-to-bottom workaround, history mutation, forced collapse, or label removal
is used.

## Regression

The existing CI-enrolled `test-composer-layout-browser.mjs` now checks:

- 18 wrapped entries at desktop, narrow, and short viewport sizes;
- outer scroll height matching normal-flow content rather than clipped rows;
- visible input controls at the true scroll floor, including a long transcript;
- inner-list scrolling, native collapse/reopen, and live status updates;
- reader position, resident textarea identity, draft, and selection preservation;
- retention of all 18 nonvisual status labels.

It also writes plan geometry JSON and isolated screenshots into its existing
artifact output directory. The expanded layout suite passed in macOS Chromium
and WebKit. The separate real-ChatView scroll-intent suite also passed in both
engines, including passive arrival, explicit send, and anchored auto-pagination.
The existing Goal, view-source, and branding contract suite passed 98 tests.
Strict TypeScript, source-fresh production assembly/check, desktop asset checks,
formatting, and architecture checks passed. Only UI CSS/tests/generated
assets are changed; no Rust compilation or application installation is needed
for this patch's browser acceptance.

The installed application is not replaced or restarted by these tests.
