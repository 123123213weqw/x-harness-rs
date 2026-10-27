# Browser extension first candidate — 2026-10-25

> Historical manual-pairing baseline. Current automatic setup and validation:
> [automatic connection receipt](browser-extension-autoconnect-20261025.md).

Base: `58d894140cb566865023481b49eed437b6ccb5fe`.
Branch: `feat/browser-extension-20261025`.

## Implemented

- Chrome/Edge MV3 toolbar icon and trusted popup: native connection state, per-chat
  pairing code, explicit tab/site authorization, current grants, stop/disconnect.
  A native connection is not presented as authorization or browser task success.
- One `browser-extension/browser` MCP server through the existing `plugin_mcp`;
  no new top-level model tool. Additive discovery is configured/not-probed, never
  automatically launched or paired. Existing tool approvals remain authoritative.
- Fixed, bounded main-frame DOM observations and one-shot, expiring node identity
  references. Browser-owned click/fill/keypress, same-origin ready navigation,
  and real PNG MCP image results. No OS mouse/keyboard or arbitrary script/CDP.
- User-owned tabs stay in their existing browser/profile. Existing login state is
  used by normal browser requests, not by copying/exporting cookies. The real
  test proves a synthetic HTTP-only fixture session, not a real account login.
- Exclusive tab leases, pending-grant epochs, per-tab serialization, bounded
  queues, cancellation, balanced input cleanup, stale-ref/replacement rejection,
  no queued-effect borrowing after reauthorization. Stop and disconnect revoke
  before native cleanup; old operations must settle before a new grant.
- Native Messaging launcher and explicit per-user registration plans for
  Chrome/Edge/Chromium on macOS, Linux and Windows. Native runtime snapshots use
  digest directories; Windows launcher/children hide console windows. No API key,
  Keychain, OS accessibility or screen-capture code is used by this new backend.
- Strict TypeScript, no owned `any`, type assertions or compiler suppressions;
  action-discriminated schema agrees with the runtime decoder. Deterministic
  browser/plugin ZIP builders, stable development extension identity, setup docs.

## Observed acceptance

All Rust compilation/tests/Clippy ran on WZU_Server after source synchronization;
no Rust compilation ran locally. Remote project:
`~/codex-build/x-harness-rs/browser-extension-20261025/`.

| Gate | Observed result |
| --- | --- |
| Strict TS build, protocol/lifecycle/transport/type tests | 19 passed locally |
| Native launcher unit tests | 2 passed remotely |
| Host browser-boundary tests, including optional extension discovery | 8 passed remotely |
| Explicit real PluginManager → plugin_mcp → rmcp → Node MCP status/denial | 1 passed remotely |
| Affected-crate Clippy `--all-targets -- -D warnings` | passed remotely |
| Architecture/freeze and local `cargo fmt --check` | passed |
| Real isolated Linux Chromium + popup + native launcher + MCP | 18 controlled checks passed |
| ZIP inventory and CRC validation | browser and MCP plugin archives passed |

The 18 real-browser checks cover: unpaired status/code, real popup/native grant,
non-secure HTTP observation without page `crypto.randomUUID`, trusted key events
and no foreground key leakage, retained HTTP-only session, inactive-tab fill and
click without foreground-tab change, one-shot/replaced/expired refs, continued
connection after the MV3 idle window, hard UTF-8 observation size, another
client's denial, actual PNG image result, same-origin committed-loader readiness,
cross-origin command denial before navigation, UI stop, manual origin change,
client-process exit, and native disconnect without replay.

Local ignored logs/screenshots/JSON: `dist/browser-extension-evidence/`.
Current real evidence: `real-final-acceptance.log`, `acceptance.json`,
`rust-verified-final.log`, `node-final.log`. Actual popup and returned-page PNGs
were visually inspected; the page shows the inserted text and incremented state.
No real account, user page or model API spending was involved.

## Corrections found during implementation

- The private-profile browser searches that profile's `NativeMessagingHosts`
  directory, not only the browser's default per-user location. The isolated
  fixture now registers there; it never changes the operator's real profile.
- Playwright/debugging can virtually keep a renderer visible even while its
  actual Chrome tab is inactive. Background acceptance explicitly asserts
  `tab.active=false`, unchanged foreground tab, and no foreground key events.
  It does not silently equate this to `document.hidden=true`; observed renderer
  visibility (`visible` in the current fixture) is preserved in the JSON.
- A single oversized CJK text node initially clipped correctly but did not set
  the truncation flag. That production flag was fixed; the real byte-bound and
  truncation assertions now pass. No observation-size assertion was removed.
- A temporary fixture string quoting error was fixed and syntax-checked before
  rerunning. Earlier failing logs remain available, not counted as passes.

## Limits / next release gates

- This is a candidate, **not installed, published, merged or released**. No user
  browser, running XHarness app or current agent was modified/restarted.
- Only Linux Chromium's real native chain was exercised. macOS/Windows actual
  browser installation, Windows ACL execution/native console behavior, Chrome/
  Edge optional-site-permission prompts, signing/Gatekeeper and real-account/
  CAPTCHA handoff remain gates. Portable registration tests are not substitutes.
- The production extension requests site permissions from a popup click. The
  isolated test variant pregrants only its ephemeral fixture origin and records
  `productionPermissionPromptTested=false` honestly.
- CI enrollment is added but is not a claim that the new workflow has run. Native
  launcher distribution is not wired into desktop releases or the public catalog.
  Node 20+ and an explicitly registered matching native launcher are required.
- No cross-origin DOM traversal, coordinate/canvas input, uploads/downloads,
  recording, Safari/Firefox, OS/network sandbox or stopped-browser operation.
  Tab/site control boundaries do not block ordinary browser subresource traffic.
- No long-duration memory/CPU benchmark or complete ZCode parity is claimed.
