# Running-state bracket/node — 2026-10-15

The selected bracket-and-node animation replaces only `StateDot`'s ongoing glyph.
Its public props and default 10px slot stay unchanged; 16px and 24px custom sizes
are exercised too. Success, attention and error keep their existing geometry,
semantic color tokens and decorative accessibility contract. Caller-owned status
text and all business/runtime state derivation are untouched.

The neutral color uses the product's existing monochrome primary-label token.
The center pulse and slight bracket response use three 2.6s CSS animation tracks.
Reduced-motion media preference removes all three tracks and shows a static,
fully opaque mark. Completing the task replaces the SVG and leaves no animation.
No timers, React state, network calls or dependencies are added.

## Reproducible acceptance

`UI_TEST_DEPS` identifies an existing local Playwright installation. Tests execute
production compiled platform code with synthetic React fixtures, the actual Theme
token stylesheet and the actual monochrome product override—not live user chats.

```sh
npm run build --prefix ui
npm run typecheck --prefix ui
npm run check:build --prefix ui
UI_TEST_DEPS=/path/to/test-project node scripts/test-platform-source-browser.mjs
UI_TEST_DEPS=/path/to/test-project node scripts/test-owned-ui-boot-differential.mjs
node --test scripts/test-ci-ui-suite.mjs scripts/test-owned-ui-type-policy.mjs
python3 scripts/regression/check-architecture.py
cargo fmt --all -- --check
```

Both Chromium and WebKit platform runs retain the original frozen/source ABI,
math, Shiki, Core/slot lifecycle, layout and exact pixel comparisons. The reviewed
ongoing-icon change is checked separately on a fresh page without global animation
suppression. All three settled states are compared exactly against the frozen
positive control, in both themes.

Motion timing is sampled at 38% to verify the center opacity and unchanged row
geometry. The fixture remounts after timeline scrubbing before testing native
reduced-motion cancellation, avoiding test-owned paused animations contaminating
the native lifecycle assertion. Light/dark screenshots and JSON receipts are
stored alongside this file. Each picture shows the default inline slot and two
larger caller sizes; these are UI test scenes, not production session captures.

The full generated UI source/frozen boot differential passed in both engines.
The CI-plan/type-policy contract run passed 37 tests. Build freshness, strict source
checks, architecture and formatting checks passed. No Rust source changed, and no
Rust compilation was run locally or required for this UI-only change.

Bracket/square contours adapt Lucide 1.17.0; the full ISC and applicable Feather MIT
notices remain in the component's legal comment and emitted bundle. No npm runtime
dependency was added. No merge, deployment, app replacement or restart is performed
by this submission.
