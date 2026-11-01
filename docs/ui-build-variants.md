# Production UI and fixture previews

## One UI, two composition roots

The production and preview builds use the same module manifest, platform, views,
RPC contracts, controller and connection lifecycle. Only the connection entry
changes; this is not a second UI or another runtime.

- `ui/src/modules/client-connection/index.ts`: production `WebApiClient` and real RPC.
- `ui/src/modules/client-connection/fixture-entry.ts`: explicit test/preview transport.
- `ui/src/modules/client-connection/install.ts`: shared service installation,
  single stream owner, reconnect handling, Host-description subscriptions and jobs.
- `ui/src/modules/client-connection/public.ts`: unchanged public contract exports.

The existing fixture data remains in `fixture.ts`, but no production import graph
may reach it. A production URL containing `?fixture`, `?fixture=1`, or demo flags
still connects to the real Host. Preview transport is chosen at build time, not
from a production URL or an environment variable embedded in the browser.

## Build commands

From the repository root:

```sh
npm ci --prefix ui --ignore-scripts
npm run build --prefix ui
npm run check:build --prefix ui
node scripts/check-production-ui.mjs
```

These commands produce production `ui/dist` and maintain the existing desktop
bootstrap document. Release assets must be rebuilt and committed with their inputs.

An explicit preview build needs a separate, new or builder-owned output directory
outside the repository. It cannot overwrite `ui/dist`, even through a parent alias.
It does not write the desktop bootstrap document.

```sh
node scripts/assemble-static-ui.mjs --variant fixture --out-dir /tmp/xh-preview-ui
node scripts/assemble-static-ui.mjs --variant fixture --out-dir /tmp/xh-preview-ui --check
UI_FIXTURE_DIST=/tmp/xh-preview-ui node scripts/test-owned-ui-boot-differential.mjs
UI_FIXTURE_DIST=/tmp/xh-preview-ui node scripts/preview-account-menu.mjs
```

Fixture-dependent browser scripts call `scripts/fixtures/ui-fixture-build.mjs`.
Without `UI_FIXTURE_DIST`, it builds a temporary preview and deletes it on normal
process exit. With that variable, it requires an explicit fixture marker; a
production output directory is rejected. The CI browser/parity runner creates one
preview per shard and shares it with child tests instead of rebuilding per case.
The GTK paired startup benchmark also requires `UI_FIXTURE_DIST` for its candidate.

## Boundaries

- The source compiler checks the complete TypeScript source closure, including
  transitive/type-only imports, for fixture/demo input paths in production mode.
- Assembly also checks script/platform/asset source paths. The fixture projection
  may change only the declared connection entry; module IDs, exports, injections,
  dependencies and startup ordering retain the existing loader protocol.
- The generated ownership marker records the variant and module source closures.
  The inventory hashes that marker and all generated assets.
- `check-production-ui.mjs` rejects missing/non-production provenance, fixture
  inputs, fixture transport bytes and stale or extra assets. Tauri's
  `beforeBuildCommand` and same-run CI artifact sealing/verification invoke it.
- Existing frozen UI references, screenshot oracles and tolerances remain intact.
  Fixture-based tests compare the preview build; separate tests verify the real
  production transport. Passing a fixture test alone is not real-Host acceptance.

## Optional real-Host integration

Use a separate state directory and an already-built Host executable. On macOS,
Rust compilation still belongs on the remote build server. The fixture launcher
below never compiles Rust or reads model credentials and refuses an existing run
directory. It runs a local deterministic OpenAI-compatible provider, including
input-token counting and non-stream auxiliary requests.

```sh
python3 scripts/fixtures/ui-host-provider.py \
  --host-binary /absolute/path/to/xharness-host \
  --ui-dir /absolute/path/to/checkout/ui/dist \
  --run-dir /tmp/xh-ui-host-unique
```

Read that run directory's `launch.json`. Use its loopback address, or an SSH
loopback tunnel to it, for the following mutating integration test:

```sh
UI_ISOLATED_HOST_ORIGIN=http://127.0.0.1:PORT \
UI_ISOLATED_HOST_MUTATIONS=allowed \
node scripts/test-production-host-connection.mjs
```

The test creates its own session, queues work during a held turn, cancels that
turn, requires a real `assistant/message` for resumed work, closes real WebSockets,
and checks the historical prefix after reconnect. Title text is not accepted as
proof of an assistant response. Stop this isolated Host by creating its `stop`
file. Never point this mutating test at personal session data or a real account.
