# Compact Swarm header

Removed the large persistent-team subtitle, separate status/timestamp row, and
all duplicate worker cards above the coordinator chat. The header is now one
small row with single-line ellipsized objective, agent count/running summary,
and labelled icon-only pause/refresh/close controls. Worker roles, runtime
states, models, tasks, blockers, and recorded results remain in the right-hand
Team inspector. The summary button opens Team in desktop/narrow layouts.

Frontend behavior only: existing polling, RPCs, worker dispatch, pause semantics,
model traffic and normal chats are unchanged. No Rust build or runtime restart
was needed. Static assets were synced to the existing isolated V100 Web Host.

Validation:

- Repository build and deterministic build check: 60 modules / 190 assets.
- 51 contract/navigation/type-policy checks passed.
- Chromium and WebKit source-component browser regressions passed, including
  12 inspector rows, no cards above chat, <=64px header with a long objective,
  mobile/docked layouts, live worker updates, late-read isolation, uncertain
  write guards, and native coordinator draft preservation.
- Real Chrome preview on http://127.0.0.1:3293/ reloaded and opened through
  /swarm; the actual header measured 51 CSS pixels, title 15px, and zero worker
  cards above chat. Team overview and both real worker statuses remained visible.
- `live.jpg` is the actual Chrome Web preview, not fixture data or a generated
  mockup. It was captured and visually inspected in this run.
- No model request, commit, push, PR, merge, release, installed-app replacement,
  or worker restart was performed for this layout change.
