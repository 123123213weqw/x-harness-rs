# Swarm option 1 — design QA

## Comparison artifacts

- Source visual truth: `docs/design/swarm/option-1.png`, selected by the user.
- Implementation: `http://127.0.0.1:3291/`, actual source Swarm component on
  the source platform, with explicitly synthetic team/conversation data.
- Final screenshot: `docs/evidence/swarm-ui-20261015/desktop.png`.
- Source and final screenshot: 1487 × 1058 pixels; CSS viewport 1487 × 1058;
  DPR 1. Full-page capture avoids the in-app browser viewport capture cropping
  at its surrounding panel edge. No image scaling or pixel mask was applied.
- State: light theme, open team, three existing workers, one recorded turn.
  The source is a concept, not a proven runtime state. Its semantic activity
  names and acceptance claims are not copied into production.
- The source and implementation were emitted together in the same comparison
  input, first before spacing corrections and again after the final revision.
  Full-resolution header, member labels, controls and composer are readable;
  no extra crop was needed to assess those regions.
- Additional evidence: `mobile.png` (390 × 844), `dark.png` (1487 × 1058),
  in `docs/evidence/swarm-ui-20261015/`.

## Findings and comparison history

1. **[P2, fixed] Desktop composition drift.** First comparison:
   `desktop-before.png` had a 272-pixel rail, smaller body text and insufficient
   center insets compared with the selected concept. Updated to a 320-pixel
   rail, 44-pixel heading inset, 27-pixel title and 18-pixel preview conversation
   copy. The final paired comparison aligns the three major regions, heading
   baseline and two-line coordinator message. Production continues to use its
   original conversation typography rather than changing all chats.
2. **[P1, fixed] Narrow rail inherited the absent second grid track.**
   `mobile-before.png` showed a 33-pixel clipped overlay. Absolute positioning
   still inherited `grid-column:2`. Explicit row-2/column-1 placement now keeps
   the rail below the live-height header at a usable width. `mobile.png`
   confirms the fix. Both browser engines assert rail width and header bounds.
   Container queries also cover a narrow center caused by a docked workspace,
   not just a small application window.
3. **[P1, fixed, preview shell only] Dark sidebar contrast.** `dark-before.png`
   used a light fallback behind light labels. Replaced it with the existing
   sidebar theme token; `dark.png` confirms readable labels and matching dark
   surfaces. No native sidebar business logic was changed.

## Required fidelity surfaces

- **Fonts/typography:** existing product/system sans-serif stack, 27-pixel
  semibold heading, 16-pixel member names and smaller secondary observations.
  These preserve the mock's hierarchy. Native product icons and text are
  sharp; no raster text is used. The preview body wraps to two lines as in the
  concept; exact timestamp copy is omitted rather than fabricating real time.
- **Spacing/layout rhythm:** 338-pixel preview sidebar and 320-pixel team rail;
  generous center whitespace, a subtle rail divider and bottom composer.
  The production shell retains its existing rounded surfaces and native
  composer. Narrow panes collapse the rail rather than compress the chat.
- **Colors/tokens:** monochrome product tokens, white/light gray in light mode,
  dark surfaces in dark mode. No new accent palette or gradient was added.
- **Image/asset fidelity:** existing product vector icon library is reused.
  The generated concept contains approximate product symbols; those are not
  traced or replaced by new hand-drawn art. The concept PNG is evidence only,
  not a background. All shipped UI remains actual text, controls and vectors.
- **Copy/content:** same example objective and discussion in the isolated
  preview. Deliberate implementation constraints: “Pause membership” instead
  of broad “Pause”; observed “Waiting” instead of invented “Reviewing”;
  “Recorded results / Turn finished” instead of unsupported acceptance claims.
  The previously removed search control stays removed. Refresh, existing-worker
  linking and New controls are actual phase-one capabilities, not decoration.

## Interaction and console evidence

- Actual source component in Chromium and WebKit: create/select a team,
  pause/resume metadata without stopping a running worker, link an existing
  child, open worker conversation, close/reopen, retain an unsent draft,
  isolate owner changes including a delayed old-owner response, and guard
  against duplicate creation after a lost acknowledgement.
- Compact rail toggle and Escape dismissal work. Both engines assert no
  horizontal overflow and usable rail geometry, including a docked pane.
- Full generated graph boots in both engines; Swarm open/close preserves
  the original composer draft. Ordinary-chat pixels still match the immutable
  frozen reference after the existing narrowly reviewed geometry projections.
- Preview console has its intentional `Host boot intentionally disabled`
  exception, used to isolate the real platform from Host startup. No unexpected
  page errors occurred in either engine. Browser tooling's own telemetry
  network failures are outside the page under test and were not treated as
  product success/failure evidence.

## Intentional deviations and remaining scope

This is an implementation of the selected layout, not a claim that the concept
has become an autonomous team. Production reuses the existing conversation.
The standalone preview's conversation/sidebar are fixture context, plainly
labeled in the footer. Status reads refresh on open, focus or explicit refresh;
this slice does not claim a live worker-event subscription. No coordinator
loop, worker spawning, result-routing acceptance or real-model Swarm run has
been completed here. Runtime lifecycle/restart evidence remains separate.

## Implementation checklist

- [x] Apply coordinator-center / team-right layout.
- [x] Preserve the normal conversation and opt-in `/swarm` entry.
- [x] Bind only supported lifecycle operations to typed RPC.
- [x] Fix composition, compact clipping and dark preview contrast.
- [x] Compare source and revised capture in the same comparison input.
- [x] Verify both browser engines and full-graph ordinary-chat parity.
- [x] Retain source art and acceptance captures in the repository.

## Follow-up polish

- [P3] Revisit density after real multi-worker event routing exists. Do not add
  invented status labels or a fake live activity stream to fill empty space.

final result: passed
