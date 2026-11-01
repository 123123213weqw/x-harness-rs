# Opt-in Swarm workspace

## Boundaries

This is the option-1 frontend for the phase-one durable Swarm metadata API.
It registers as a source module through the existing ModuleLoader and slots.
The root conversation's `/swarm` popup opens the workspace. No additional model
or Agent tool is registered, and no Goal is created automatically.

The layout keeps the existing conversation at its fixed React tree position.
The Swarm module supplies only its heading, setup form and team rail; it does
not implement another production composer or chat runtime. Closing the feature
leaves the original conversation and draft in place. Worker links use the
existing catalog-addressed `openSubagent` path.

## RPC

The typed client uses only `/api` endpoint `swarm/manage`, with explicit
`ownerSessionId` and a tagged `command`. Reads decode unknown data, validate
owner/identity and match observations to exact membership. Mutations reuse
server revision CAS. Read cancellation and scope generations prevent late
responses from replacing a newly selected conversation's team.

Create, list, inspect, link an existing delegated child, and pause/resume
membership are supported. Status and recorded results are observations, not
claims of objective completion. Metadata pause does not cancel running chats.
There are no automatic retries of writes: after an uncertain response, refresh
must succeed before another mutation. Focus/visibility can refresh an open
workspace; there is no hidden polling and no provider health probe.

## Preview and tests

Run `node scripts/preview-swarm.mjs` and open `http://127.0.0.1:3291/`.
The preview loads the actual Swarm source component and platform, but all team
records and the example conversation are synthetic. It never opens real chats,
uses credentials or calls paid models. The preview footer identifies that
boundary; it is not a production feature component.

Deterministic tests:

- `node --test scripts/test-swarm-client.mjs`
- `node --test scripts/test-shell-navigation.mjs`
- `node scripts/test-swarm-ui-browser.mjs` with `UI_TEST_BROWSER=chromium` or
  `webkit` and the existing `UI_TEST_DEPS` browser dependency directory.
- `node scripts/test-owned-ui-boot-differential.mjs` verifies the full graph,
  existing conversation draft retention, and immutable ordinary-chat pixels
  against the frozen reference in both engines.

The client and two browser variants are included in `scripts/ci/ui-plan.json`.
Use the repository build check rather than hand-editing generated UI artifacts.

## Not yet implemented

No autonomous coordinator loop, worker creation, durable result routing,
mission/Goal scheduling or real-model Swarm end-to-end acceptance is claimed.
Those remain a separate runtime slice; this UI does not manufacture their
statuses. Rust lifecycle/recovery evidence is recorded separately under
`docs/evidence/durable-swarm-lifecycle-20261015/`.
