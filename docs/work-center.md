# Tasks and automations

The sidebar clock opens a Work center in the chat column. Its Tasks and
Automations tabs share the existing runtime-owned session/workspace metadata.
Opening a task or reminder returns to its original conversation. Switching
center pages keeps the conversation mounted, including its draft.

## Ownership and compatibility

- `WorkCatalog` is a projection over `SessionRuntime` and `WorkspaceRuntime`,
  not another transport, event pump, or mutable session owner.
- The Tasks page sends commands through this typed runtime face. Archive
  management remains available in Settings and keeps its existing confirmation
  and parent/child deletion rules.
- Automations lists the existing `schedules` projections; creation and management
  still happen in the originating conversation. It is not a new scheduler or
  automation editor. Goals without schedules are not included.
- Unknown/unloaded projections are distinguished from a hydrated empty catalog.
  Partial records and failed refreshes are explicit rather than fabricated.
- A page timeout cancels its wait, not the shared baseline pull. Runtime reconnect
  and eventual successful pulls repair the page without private polling.
- Existing session search, provider settings, plugin navigation, archive RPCs,
  and the native host protocol are retained. This PR changes no Rust code.

## Regression commands

```sh
npm ci --prefix ui --ignore-scripts
npm run typecheck --prefix ui
npm run check:build --prefix ui
node --test scripts/test-automation-navigation.mjs scripts/test-work-catalog.mjs scripts/test-tasks-state-ownership.mjs
node scripts/test-tasks-plugin.mjs
node scripts/test-product-source-modules.mjs
node scripts/test-view-source-modules.mjs
node scripts/test-workspace-source-module.mjs
UI_TEST_IMPL=source node scripts/test-automation-navigation-browser.mjs
UI_TEST_IMPL=source node scripts/test-tasks-source-browser.mjs
UI_TEST_IMPL=source node scripts/test-workspace-source-browser.mjs
node scripts/test-owned-ui-boot-differential.mjs
```

Set `UI_TEST_DEPS` to an isolated Playwright dependency directory, and repeat the
browser checks with `UI_TEST_BROWSER=chromium` and `UI_TEST_BROWSER=webkit`.
Fixtures run actual generated modules, React, runtime owners and typed client
against synthetic Host responses; they are not native macOS or live-model
end-to-end acceptance. CI retains both browser engines and legacy regressions.
The full boot comparison allows the explicit clock/footer navigation change,
while requiring exact conversation pixels and all unrelated controls to match.
