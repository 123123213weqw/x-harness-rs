# Swarm task-board UI

This UI extends the already selected coordinator-center/team-right workspace.
The native conversation and composer stay mounted; the right rail switches
between Tasks and Team. A narrow center uses the compact Team entry,
including when the browser/files pane is docked. Light and dark themes use the
existing semantic tokens and monochrome styling.

## Scope

- Read active work, assignment delivery state, dependencies and retained results.
- Expand a task to read its instructions, result summary and accepted worker turn.
- Open the existing worker conversation without creating a new chat.
- Add a task with dependencies on loaded tasks. All tasks includes retained history.
- Explicitly assign ready work to a linked, observed idle worker. The submit button
  states that this sends work to an inbox and may start execution. The Host remains
  authoritative for readiness, worker eligibility and revision conflicts.
- Refresh and load more through the real `swarm/tasks` endpoint (50 rows per page).
  Page revisions must match; a changed revision requires a fresh view. Task reads
  synchronize changed team metadata before later pause/resume actions.

Inbox admission is not execution or completion. The UI deliberately says
"Delivery pending" or "Inbox received", not "Running" or "Done" based on a claim.
A normal worker turn ending is shown separately in Team, not accepted as task
completion. There is no completion button that guesses the consuming turn.

## Isolation and failure handling

Viewing the workspace creates no work and invokes no model. The live monitor
uses read-only inspection while the selected Swarm view is visible. Automatic
pickup and coordinator review belong to the existing Host/runtime, not UI effects.
Closed views stop reading; hidden documents skip background inspection. Existing team pause now
uses the label "Pause team" because it also gates new task deliveries; already
admitted work continues under the existing runtime.

Writes use explicit board revisions, a synchronous in-component submission lock,
and no automatic mutation retries. After an uncertain write, further board writes
are disabled until an explicit read. The user can inspect whether it was saved;
refreshing does not repeat the mutation. Owner/team changes unmount the scoped
board and abort reads; late results cannot replace another team's view.

Response data is decoded from `unknown` into discriminated task states. Duplicate
identities, invalid states, crossed targets/cursors, unsafe counters, invalid
readiness and malformed pagination are rejected. Agent-provided text uses ordinary
React text nodes, never HTML injection. No `any` or type assertions are introduced.

## Validation and preview boundary

`node --test scripts/test-swarm-client.mjs scripts/test-shell-navigation.mjs
scripts/test-owned-ui-type-policy.mjs` checks the protocol boundary and unchanged
navigation/type policy. `node scripts/test-swarm-ui-browser.mjs` and
`UI_TEST_BROWSER=webkit node scripts/test-swarm-ui-browser.mjs` use the actual
source component and platform with synthetic RPC responses. They cover manual
assignment, dependency blocking, retained results, lost acknowledgements, offline
reads, pagination conflicts, stale team revisions, safe text rendering, ordinary
chat draft preservation, owner changes and narrow layouts.

`PORT=3292 node scripts/preview-swarm.mjs` starts a clearly marked fixture preview.
It is not a live model or a production Host. No credentials are loaded and no
paid inference is performed. Production code uses the real RPC client; fixture
browser acceptance alone does not claim a live Host-to-model assignment or
autonomous Swarm loop. Backend restart/inbox acceptance is recorded separately under
`docs/evidence/swarm-task-board-20261016`.

## Compact live header

The Swarm header is a single compact row: a small icon, single-line ellipsized
objective, agent-count/running summary, and icon-only pause, refresh, and close
controls. The persistent-team subtitle, timestamp row, and duplicate worker-card
grid have been removed from above the chat. Full objective and worker details
remain in the right-hand Team inspector. The summary button opens that inspector,
including when a narrow center hides the rail. Runtime warnings/freshness remain
available through the summary tooltip and inspector. Buttons retain explicit
accessible labels; pause/resume behavior is unchanged.

The selected visible view inspects after 1.5 seconds, then every 1.5 seconds while
work is running/queued or assigned, and every 5 seconds when idle. Requests are
serial and abort on owner/team change or unmount. Hidden views skip inspection.
This uses the existing RPC and makes no provider requests or schema changes.
Read failures keep last-known state with an unavailable label. The separate live
snapshot does not reset an add-task draft, pagination error, or uncertain-write
guard. Only per-worker titles/counts and a bounded recorded-result preview are
retained; full task bodies and histories are not cached in this workspace.

## Right-hand team inspector

The right rail opens on Team by default. Its overview shows the objective,
coordinator, team lifecycle, dispatch mode, worker count, and accepted/total
progress with pending, assigned, and rejected counts. Progress comes from the
same durable task snapshot; a finished worker turn is still not an accepted task.

The header summary opens Team. Selecting a worker row expands its details in
place. The coordinator conversation and draft stay mounted. Worker details show
role/initial assignment, runtime activity, assignment delivery, pending inbox,
reported blockers, last turn outcome, and a bounded recorded task-result preview.
Result ordering uses that worker's settled turn, not task-ID ordering.

Only the expanded worker reads its public tail and model metadata through the
existing parent-addressed `subagent.history` RPC (`maxMessages: 1`). The model
label says **Last used model**: it comes from reported throughput metadata, not
an inherited configuration guess or a provider probe. Missing metadata is shown
as Not reported. Reasoning fields are never decoded into the inspector. Public
response and task-result previews are capped at 2,000 characters each.

Owner/team/worker changes and leaving the Team panel cancel detail reads. Late
responses cannot replace the selected worker. Errors keep same-worker last-known
details with an explicit error label; refresh is read-only. The explicit Open
worker conversation button uses the existing catalog address. No runtime, tool,
RPC schema, automatic scheduling, or model-prompt behavior changes are required.
