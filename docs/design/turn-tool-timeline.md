# Reading-first turn activity

This is a presentation-only change over the existing ChatView, Session/Assembler
projection, keyed node seats, transcript windowing and call-owned disclosure state.
It does not introduce a second transcript, Tool executor, task scheduler or Plan store.

## Reading hierarchy

Assistant prose uses the existing ordinary platform system-font stack, not Georgia
or a CJK serif download. The assistant-only Markdown boundary opts into 600-weight
22/32 and 18/28 headings, calmer paragraph gaps and the existing 16/28 body. Code
keeps its monospace font. Reasoning, tools and other Markdown consumers do not
inherit the assistant reading tokens.

## Turn disclosure

- One loaded-turn header shows tool-call and Thought counts. A missing logged
  turn/start is labelled **Loaded**, not represented as a full-turn count.
- Recursive calls are deduplicated within their owning turn/step; model call IDs
  are not presumed globally unique. Cached immutable metadata uses weak keys, not
  another retained copy of result bodies. Incomplete closed historical boundaries
  are skipped before looking up their members on each live publication.
- In auto mode, earlier settled successful tools fold without waiting to consume
  40% of the viewport. The newest action remains visible. Focus, selection,
  explicit call expansion and the reader anchor protect automatic folding.
- Thought is an expandable brain-icon row. Its existing displayable reasoning is
  retained, but a collapsed live turn does not keep appending reasoning-only rows.
  Narration, images, unknown blocks and incomplete tool input remain inspectable.
- Explicit group-close folds the currently present successful tools, overriding
  earlier child expansion without erasing that state. It is a snapshot of keys,
  not a permanent force-hidden turn flag: future failure/pending/recovery remains
  a fresh protected decision. Reopening restores call-owned disclosure state.
- Authoritative turn/end still owns completion. Idle and step/end cannot fabricate
  a completed turn. Final prose/images remain outside the group. Failed tools,
  nonzero/signal terminal cards, unresolved/unknown outcomes and agent communication
  receipts stay visible after the turn ends, including recursively nested calls.
- Questions/approvals keep their existing composer seats. No request/answer or
  authorization control is buried in the group. Reader gestures keep the existing
  follow/anchor ownership; natural scroll-range clamping is not reinterpreted as
  permission to follow. Offscreen headers are windowed and remount on scrolling.
- The existing bottom pixel ring and h/m/s timer keep their identity for the whole
  running turn. There is no duplicate ticking header clock. Completed headers show
  logged duration in h/m/s without a visible “Ran for” prefix.

## Recent-tool paging

Only the collapsed, loaded, currently running turn gets a decorative **Recent**
preview inside its existing header. It is not a second execution status: a short
preview may outlive a fast returned tool. The real keyed cards remain mounted in
their original seats and retain all actions, Inspect, pending controls and native
privacy effects. Expanded/history/closed turns do not page. Neither the bottom
pixel ring nor its single h/m/s timer is recreated or duplicated.

The presentation keeps one latest snapshot and at most two short faces, never an
event replay queue or result bodies. Updates coalesce at a 1,000ms cadence with a
180ms vertical flip. Parallel presentation cycles at most eight recent root calls;
the badge counts all actual active roots, not nested parent/child calls. Scoped
turn/step/sequence keys do not assume model-generated call IDs are globally unique.
Only bounded input metadata is parsed for the preview; original inputs/results
remain exact in their original cards. A large/incomplete argument keeps a neutral
preview rather than being reparsed without a limit.

Error/unknown-outcome/interruption/nonzero or signalled terminal results cancel
both faces immediately until a genuinely later dispatch. Pending questions,
approvals, a stop request or a disconnected session disable this decorative layer;
they cannot hide the actual error/control. The preview does not dispatch anything,
infer task completion, or change tool/execution/fold policy.

Hover on a fine pointer, keyboard focus and selection hold a static face. Hidden
documents and reduced-motion users get no paging timer; resuming selects the latest
snapshot without replay. Expansion, virtualization and session changes dispose
the one timeout and listeners. The duplicate short text is aria-hidden; the header
keeps its semantic expand/collapse name and accessible counts, while original cards
provide the full details. No animation-frame loop, new dependency, SVG package or
second tool-card tree is introduced.

The pure pacing/projection regressions cover coalescing, delayed timers, duplicate
faces, bounded previews, scoped keys, recursive error barriers and root-only
parallelism. The real Session/Assembler browser regression also exercises keyboard
pause/expansion, streaming, error/recovery, waiting, stop/disconnect, reduced motion,
session isolation, stable ring/timer identity and 320px layout in Chromium/WebKit.
These are functional/lifecycle checks, not a claim of lower measured memory or a
native macOS long-running profile.

## Tool identity

Small repository-owned monochrome SVGs share stroke, size and currentColor. Tool
identity remains visible while open and when failed/interrupted; the state badge
is independent. Search is a magnifier, Browser a browser window, Image a landscape,
Thought a brain, and TodoList a checklist. Known built-in names map explicitly;
unknown names retain a neutral glyph rather than a fuzzy substring guess.

Only exact browser MCP plugin/server identities and the WordCraft plugin refine
the MCP glyph. JSON parsing is bounded to 16,384 JavaScript string code units and
cannot dispatch a tool. Partial/malformed/large arguments keep the neutral MCP
identity. No icon package, font, network request, dependency or lockfile is added.

The new `todolist` view is registered alongside historical `todo_write` rendering.
`get` and `update` share one identity; updates show item count, not completion.
The UI accepts no status-writing shortcut and does not infer plan completion from
a successful command or model turn. Raw inputs/results remain in the normal
expanded tool details. This PR does **not** include the separate unsubmitted
`todolist` backend branch, enable a `plan` alias, or change Host capability policy.

Failure summaries unwrap bounded JSON messages and cap plain previews at 240
Unicode code points. Full error output remains unchanged and expandable.

## Validation

Private test exports are not added to the production apply/inject ABI. Existing
frozen references remain byte-for-byte unchanged. Exact reviewed CSS appends and
locale additions are pinned; unrelated styling/copy/slot deltas still fail parity.
New regressions cover live/history assembly, incomplete history, turn/step call-ID
reuse, malformed inputs, recursive failures, terminal failure envelopes, explicit
and automatic fold protections, keyboard controls, row-owned state restoration,
ordinary typography, 320px layout and reader anchoring. The new end-to-end fixture
uses the real Session/Assembler and maintained platform/ChatView/ToolRow/Markdown
in Chromium and WebKit and is enrolled in both existing CI browser matrices.
Native wheel input must settle before measuring a disclosure. The real gesture
places a visible reader anchor with sufficient post-collapse scroll range; the
less-than-2px assertion is unchanged and no blank production padding is added.
Existing lifecycle, 42 terminal windows, scroll-follow, virtualization, observer
cleanup and canonical reproducible-build gates remain required.

This is not an installation, release, native App/WebView lifetime measurement or
long-term memory benchmark. It does not restart/stop any installed App or Host.
