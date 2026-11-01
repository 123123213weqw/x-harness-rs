# Bounded stream presentation — 2026-10-24

Base: `2b398856c2e3412fe6da828986a215f3f00403ef` (desktop 0.2.57).
Branch: `fix/smooth-stream-presentation-20261024`.
No installed app, user conversation, model service, or independent Web Host was changed.

## Changes and boundaries

- Core now arms an independent 250 ms deadline for pending journal chunks while
  waiting for provider output. Already received text can be published during a
  provider pause; another delta is no longer required to notice the deadline.
  Empty batches do not arm a timer. The 64-fragment / 4096-byte caps, journal
  authority, replay sequence numbers, retry-safe private tool prefix and tools
  remain unchanged. This is **not** a new ephemeral/live transport or a complete
  separation of presentation from durable journal publication.
- Live Markdown has a display-only adaptive queue: nominal 32 ms commits,
  catch-up deadline 192 ms from the start of each debt episode, shortened to
  96 ms at completion. Later input does not extend the current deadline.
  These are scheduling budgets, not hard real-time browser guarantees.
- Stop/interruption, replacement, restored history, hidden pages, reduced motion,
  and a backlog exceeding 8192 UTF-16 units bypass pacing. Engines without
  `Intl.Segmenter` also bypass pacing, rather than cut unknown graphemes.
- Final text still passes through the original settled Markdown renderer.
  Code/table/math do not get prose fade spans. The original incremental parser
  and frozen prefix cache are retained; no new runtime dependency is added.
- Completion state and tool/control events never wait behind presentation debt.
  Fresh nodes mounted with completed content are treated as history, not replayed.

## Verification

- On WZU_Server, synchronized source: Core 208 passed; Host 475 passed,
  8 pre-existing externally dependent tests ignored; affected crates' all-target
  Clippy with `-D warnings` passed. Rust compilation was remote only.
- Frontend deterministic contracts: 17 passed, including bounded debt, continuous
  arrivals, final text arriving with completion, non-append pending replacement,
  cleanup, hidden/reduced mode, grapheme boundaries, delayed timers and old engines.
- Actual Chromium and WebKit: same source batches fed to pinned old and current
  production Markdown components, normal/burst/structured cases, exact final
  rendered equivalence, interruption and reduced motion, no page errors.
- Chromium normal fixture: 7 → 33 text mutation samples; largest observed
  positive text jump 47 → 9 rendered UTF-16 units. Burst fixture: 170 → 54.
  WebKit: normal 7 → 33, 47 → 10; burst 170 → 53. These are fixture measurements,
  not model tokens/second or a universal performance guarantee.
- Existing streaming-math browser regression: 18 checks (Chromium) passed.
- Owned UI strict build, deterministic artifact verification, plugin API
  typecheck, architecture check, formatting and whitespace checks passed.
- Patched Linux Host executable, isolated local fake SSE provider and empty
  workspace/state: 8 RPC/WebSocket trials, all text totals exact. A provider
  emitting 3 small fragments then pausing 800 ms publishes its first 15
  characters at about 259 ms, before the pause ends. No premature completion.
  The earlier installed Mac binary waited about 865 ms in that fixture;
  this cross-platform comparison demonstrates the old failure mode, **not**
  a controlled same-host latency speedup. Model generation latency is unchanged.

Evidence: local `xharness-stream-cadence-evidence-20261024` directory contains
raw synthetic Host frames, build/test logs, browser mutation metrics and screenshots.
No real model credentials or production transcript was used for these tests.

## Replay the visual comparison

From the repository root:

```sh
node scripts/preview-stream-cadence.mjs
# http://127.0.0.1:3270/ — old left, new right; replay / burst / code controls
node --test scripts/test-stream-presentation.mjs
# With preview running, using the existing Playwright test dependencies:
UI_TEST_DEPS=/path/to/test-dependencies node scripts/test-stream-cadence-browser.mjs
UI_TEST_DEPS=/path/to/test-dependencies UI_TEST_BROWSER=webkit node scripts/test-stream-cadence-browser.mjs
```

The comparison builder reads the pinned baseline from Git; keep that commit
available when using a shallow checkout. The preview binds loopback only and
never calls a real model. It is not a production install or deployment.
