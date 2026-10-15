# Swarm option 1

The user selected this AI-generated concept on 2026-10-15. `option-1.png`
is retained as design evidence, not embedded as application UI.

Implementation reuses existing XHarness vector icons, theme tokens, conversation
slot, sessions catalog, command UI and RPC transport. The generated search
button is intentionally omitted: the product previously removed sidebar search.

The coordinator conversation remains central; the team rail is 320 CSS pixels
on wide panes and collapses behind a Team control on narrow panes. The native
browser/files workspace can still be docked beside it. `/swarm` is the opt-in
entry, rather than another permanent sidebar button.

The concept's broad Pause and semantic role labels are deliberately not copied:
phase one only pauses team membership metadata and observes actual turn states.
It does not stop running workers, auto-schedule tasks or assert task acceptance.
See `design-qa.md` at the repository root and the separate evidence directories
for backend restart recovery and frontend acceptance.
