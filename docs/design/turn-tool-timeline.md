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

## Event-driven collapsed tool summary

The live collapsed header shows the current tool glyph, action and bounded input
summary instead of a separate statistics + Recent carousel. A new tool identity
slides up over 300ms; at most one latest update waits through the 800ms read
window. Same-call input refreshes in place. Parallel roots have a count badge,
not cyclic playback. Idle summaries own no repeating timer. Delayed callbacks
coalesce to the latest state without animating stale backlog. Reduced motion,
background visibility, hover, focus and selection retain the existing controls.
A hidden/zero-size viewport restores the existing fail-open policy. Focus,
selection, open details and the existing reader-anchor owner protect recovery
from an error/pending row before any DOM is removed. Explicit group-close still
outranks earlier child expansion without erasing that state.
Statistics remain the fallback when no live summary is available and on explicit
expansion/completed turns. Thought remains its own disclosure (#468 tail window).

The existing chat owner selects a primitive summary-ready turn, independently
of per-token preview text. Only ordinary built-in tools with no native view can
be represented by that summary while running. Plugin/native privacy carriers,
agent communications, unknown tools, questions, approvals, failure/unknown-outcome
barriers, stop and disconnected states retain their real seats. Completed
successful tools retain the existing fold policy. Manual expansion always
restores the original keyed tool rows, without replacing their data or execution
state. The single pixel ring/timer, reader anchor and scoped expansion state are
unchanged. This is a conservative difference from ZCode: no blanket unmount of
native/plugin tools, whose privacy effects are owned by their rendered cards.

Validation covers deterministic presentation clocks, same-call refresh, bursts,
late callbacks, no idle timers/replay, protected rows, and real assembled
Chromium/WebKit transcript behavior including narrow screens, keyboard
expansion, selection/hover, waits, errors, stop, disconnect and session switch.
