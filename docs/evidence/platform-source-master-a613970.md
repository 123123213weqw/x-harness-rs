# Strict-source platform / master a613970

The production builder reads only repository-owned TS/TSX/CSS, pinned original
third-party TS/SDK files, and this repository's `npm ci` installation. It never
reads `ui/reference`, `ui/legacy`, `ui/dist`, or the external upstream checkout.

- Runtime entry: `ui/src/modules/platform/main.ts`.
- Parser-time queue: `ui/src/modules/platform/bootstrap.ts`, a strict-checked IIFE.
- Platform exports: `primitives/index.ts`, `slots/index.ts` under the same directory.
- Runtime vendor aliases target original `vendor/{cordis,cosmokit,loader}/src/index.ts`.
  Compile-time aliases target their same-version, original `types/index.d.ts` SDKs.
  These SDKs are not fabricated declarations. All 50 original source/SDK/license
  inputs are SHA-pinned in the vendor `PROVENANCE.json`; no original library was edited.
- npm libraries: 104 pinned distributions (including original React 18.3.1,
  React DOM 18.3.1, KaTeX 0.16.47 and Shiki 4.3.1), installed by the checked-in
  package.json/lock. `platform-npm-provenance.json` and `source-vendors.json`
  retain version/license/package hash/integrity/full original distribution hashes.
  The first 3464 upstream npm files exactly matched clean npm-ci distributions.
  There is no copied or force-added nested node_modules production source.
- Browser compatibility defines match original platform bundling: production
  NODE_ENV, Node version "0.0.0", empty execArgv, absent CORDIS_SHARED.
  `node:module` remains the loud throwing browser stub on an unreachable Node path.

## Builder contract

`compilePlatformUi(ui,{source:'src/modules/platform/main.ts'})` returns `outputs`
(Map of dist-relative paths to bytes), `entryPath`, `cssPaths`, `preloadPath`,
`inlineBootBytes`, per-output hashes/roles, per-input hashes and runtime/typecheck
alias tables. It performs strict owned-source checking before bundling, with
`skipLibCheck:false`. It does not write production artifacts. The assembler owns
HTML, graph, activation and final output writes.

## Reproduce

```sh
cd ui && npm ci --ignore-scripts --no-audit --no-fund && cd ..
node scripts/build-platform-ui.mjs --primitives
node scripts/build-platform-ui.mjs
UI_TEST_DEPS=/path/to/playwright-deps node scripts/test-platform-source-browser.mjs
```

The A/B test reads the immutable latest reference's actual index.html main
`index-xhmotion-347f73ecba2d.js`, not its unused older entry/sourcemap, and runs
Chromium and WebKit. Both actual executions match for:

- exact seven platform keys and React/JSX/React-DOM singleton identity;
- actual parser-preloaded module/runtime registrations, queue→live handoff,
  failed-create queue mutation, repeated create rejection and seed identity;
- ten code-unit streamed math scenarios, unfinished delimiters, stable frozen
  KaTeX DOM, replacement/retry, settled projection, invalid-code isolation;
- exact semantic brand/SVG and genuinely lazy requested Python Shiki grammar;
- actual Core Service caller methods/getter rebinding (not fixed owner context);
- SlotCore list/keyed priority, chain ordering, abdication fallback, declaration
  lifetime/cascade, stale disposer and synchronous/microtask notification paths;
- twelve light/dark × 960/390px × base/menu/modal snapshots, equal full computed
  geometry/styles/pseudo-element styles and equal rendered PNG SHA values.

The new CSS module class names need not match, but the above actual styles and
pixels do. Global monochrome/data hooks and logo animation class remain intact.
Sidebar's hashed logo-motion selectors belong to the feature/source CSS map and
must remain covered by the separate whole-app/sidebar acceptance.

## Observed frozen asset gap

The frozen master includes 59 of the 60 original KaTeX font files. Its CSS refers
to a missing Size3-Regular.woff2; the source build emits that exact original font
(SHA256 `73d591271b1604960cb10bb90fee021670af7297017e0e98480b332d11f51995`).
All 59 existing frozen font bytes match source exactly. The additional dependency
is explicitly recorded, not counted as a fictitious 60/60 frozen comparison.

## Limits

This is platform-only acceptance, not completion of the remaining client-runtime,
Cordis lifecycle or every feature migration. Tests stop real Host boot and do not
open user sessions; full same-Host and whole-app integration remain root acceptance.
No Rust compilation, commit, push, release or restart was performed.
