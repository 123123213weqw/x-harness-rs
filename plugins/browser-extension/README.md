# XHarness Browser extension — automatic connection candidate

An opt-in Chrome/Edge 123+ Manifest V3 extension, not Computer Use or an embedded
WebView replacement. One existing `plugin_mcp` entry controls explicitly authorized
browser tabs without activating them or using the system mouse/keyboard.

## First setup, then automatic use

1. Install the matching **complete platform plugin archive** through the existing
   verified plugin installer and enable its MCP server. Node 20+ must already be
   available to the MCP runtime. On its first invocation the enabled plugin
   automatically registers its bundled native launcher for the current user's
   Chrome, Chromium and Edge. No terminal command, administrator access, download,
   browser-profile copy or restart of XHarness is performed by that setup.
2. Install/load the browser extension once. This candidate is not yet published
   to the Chrome/Edge stores; it cannot silently install or enable itself. Open
   its toolbar popup and choose **启用自动连接** once.
3. The popup discovers Host-bound conversations automatically. Select the intended
   conversation and tab, and authorize that site/tab. There is **no pairing code**.
   New tabs, sites and different conversations are not implicitly authorized.
4. The model uses `plugin_mcp`: plugin `browser-extension`, server `browser`,
   tool `browser`, starting with `{"action":"status"}` then `tabs`/`observe`.
   Discovery alone does not grant control or prove that a page is ready.

Connections are reestablished automatically after a native helper failure (bounded
30s–5min backoff), browser startup or service-worker restart once enabled. An idle
MCP process can be recreated without re-pairing: Host identity is stable across
that conversation's process lifetimes. Unknown effects are **not replayed**.

### What is remembered

- `storage.local`: only the opt-in automatic-connection preference, persistent
  across browser restarts. An explicit disconnect turns it off.
- `storage.session`: exact tab ID + granted origin + opaque Host conversation ID.
  It survives worker/native/MCP restarts **within the same browser session**, not
  a full browser restart. It never reinterprets a recycled tab ID from an older
  browser session. After a full browser restart choose the intended tab again;
  there is still no manual pairing code.
- **停止全部操作**, a tool stop/cancellation, user debugger detachment, site permission
  removal, tab closure and origin change clear the relevant consent. Automatic
  reconnection cannot restore it. A transient transport/client exit only retires
  live control; exact saved consent can be restored to the same conversation.
- Two live clients claiming the same context are ambiguous: control is revoked,
  not assigned to whichever arrives first. Other conversations cannot inherit it.

## Architecture

```
model → plugin_mcp → Host-injected context → per-chat MCP broker
                                                  ↕ private token + loopback TCP
                               browser-owned Native Messaging helper
                                                  ↕ bounded native frames
                               MV3 worker → approved tab CDP + fixed DOM functions
```

The context is a SHA-256 namespace of canonical plugin-store path and Host session
ID, injected by Host after removing reserved selectors from plugin environment
configuration (case-insensitively). It is not accepted as model tool arguments.
The private per-process transport token and random RPC identities remain separate
from stable context identity. A label/ID is not a transport credential. This is
protocol scoping, not an OS sandbox against arbitrary same-user executable code.

Only packaged popup messages can create a new grant. Saved grants restore only an
exact current tab/origin/context after verifying current site permission, client
uniqueness, pending operations and cancellation generation. Ref observations are
invalidated on retirement. Native disconnect never resurrects an old queued effect.
The helper rotates its bounded registration scans so stale crashed-client files
cannot permanently hide live conversations.

No independent model tool, arbitrary JavaScript/CDP, cookie export, profile copying,
remote debugging port, system accessibility permission or cross-browser fallback is
introduced. Embedded `native-browser` and isolated headless `browser-use` retain
separate login/session boundaries. HTTP-only login cookies remain in their browser.

## Build and install integration

```
npm ci --prefix plugins/browser-extension --ignore-scripts
npm run build --prefix plugins/browser-extension
node plugins/browser-extension/scripts/package.mjs \
  --platform linux-x64 --native /absolute/remote-built/xharness-browser-extension-host
```

Supported package IDs: `linux-x64`, `win32-x64`, `darwin-arm64`, `darwin-x64`.
The browser ZIP and platform MCP ZIP are separate. A complete MCP ZIP includes the
native launcher and installer; packaging refuses to label a helper-less archive a
complete plugin. `--extension-only` deliberately builds just the browser ZIP.
Rust compilation must follow the repository's remote-only policy.

`Browser extension` CI builds and uploads all four platform candidates and SHA-256
receipts. They are **not automatically published, installed or promoted**. Those
native candidate binaries are not a signed/notarized public distribution yet. This
PR does not modify the desktop release channel or public plugin catalog.

Native registration is user-scoped (Windows HKCU, Unix browser-specific manifests).
The helper is snapshotted by content digest outside app/update directories with a
pinned Node executable and immutable code. Concurrent chats converge on the same
snapshot; routine startup does not overwrite a running executable. Tampered
snapshots and unrelated native manifests fail closed, instead of being overwritten.
Changing/removing the pinned Node installation requires native setup to run again.
No provider API credentials are forwarded to the browser-owned helper.

For source-only development the installer remains inspectable:
`node plugins/browser-extension/scripts/install-native.mjs --browser chrome`
prints a read-only plan. Explicit `--binary /absolute/launcher --register` registers
it. Complete platform plugin users do **not** need to run this command. A development
MCP launched without a valid Host identity fails before installation/discovery.

Custom `--user-data-dir` browser instances use their own Unix
`NativeMessagingHosts` directory. Automatic registration targets standard per-user
Chrome/Chromium/Edge profiles, never scans other profiles, and cannot silently
opt a custom profile into control. The isolated regression registers its temporary
profile explicitly; this is not a production-profile modification.

## Interface and bounds

One tool, `browser`, with a closed discriminated schema:
- `status`, `tabs`, `stop`;
- `observe(tabId)` → bounded untrusted main-frame text and one-shot DOM identity refs;
- `click(tabId, observationId, ref)`, `fill(..., text)`, `press(tabId, key)`;
- `navigate(tabId, url)` within the granted origin; waits for committed loader/readiness;
- `screenshot(tabId)` → real PNG MCP image content, not base64 transcript text.

| Resource | Bound |
| --- | --- |
| Connected clients / authorized or remembered tabs | 16 / 16 |
| Registration scan batch / retry-name cache | 64 / 128 |
| Queued commands / per-client pending calls | 16 / 8 |
| Concurrent screenshots | 1 |
| Native frame / native-host → browser frame | 4 MiB / 1 MiB |
| Observation | 16,000 UTF-8 JSON bytes, 64 refs, 3,000 text nodes |
| Ref lifetime | 30s, consumed before an effect |
| Text insertion | 8,192 Unicode characters |
| PNG | 2 MiB bytes, 8,192 per dimension, 16M pixels |
| Native command / readiness / MCP deadline | 8s / 10s / 20s |

Passwords/values are excluded from DOM observations, but screenshots show rendered
content and are not redacted. Normal browser subresources are not firewalled.
There is no cross-origin DOM/frame traversal, coordinate API, file upload/download,
recording, Safari/Firefox support or operation after browser/Host/device shutdown.
Discarded/frozen tabs require restoring the tab first. Browser debugging indicators
and permission prompts are not suppressed.

## Regression and remaining release gates

- `npm test --prefix plugins/browser-extension`: strict types, closed schema,
  frames, actual MCP token validation, stale discovery, registration idempotency,
  concurrency, tampering, restore/stop/duplicate-context races.
- Remote Rust: `plugin_mcp` tests, native launcher tests, plugin crate tests,
  explicit `extension_status_uses_real_plugin_mcp -- --ignored`, and Clippy.
- Linux isolated real Chromium: first-use native registration, popup authorization,
  inactive-tab trusted inputs/PNG, MCP recreation, native helper crash/reconnect,
  cross-client/origin/TTL/stop gates. See the acceptance receipt in `docs/acceptance/`.

macOS/Windows browser + installer click-through, actual optional-site permission
prompt, signed/notarized public distribution, store publication, real-account/CAPTCHA
handoff and long-duration RAM/CPU measurements remain separate acceptance gates.
Linux tests pregrant only the ephemeral fixture origin; they do not claim that a
production permission prompt was clicked. Background is measured by actual tab
activity and unchanged foreground input, not `document.hidden` under Playwright.

References: [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
[MV3 lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle),
[Chrome debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger).

### Bounded observation pages

`observe` returns at most 64 controls and 8,000 text bytes within a 16,000-byte
JSON budget. Follow `nextCursor` with `{"action":"observe","tabId":123,
"cursor":"<returned nextCursor>"}` until it is `null`; scrolling alone does not
advance the page. Each page replaces old `observationId`/refs. DOM changes,
navigation or 30 seconds of inactivity invalidate a cursor: start again without
one. Traversal advances over at most 3,000 elements/text nodes per call, rather
than repeatedly returning the first controls. Password/hidden text exclusions,
one-shot actions and tab/origin/Host authorization remain unchanged.

Review regression on WZU_Server passed 30 Node contracts and 22 genuine
Chromium/extension/native-Messaging/MCP checks, including a 70-button document,
long CJK/emoji/escaped text, actionable offscreen control 70, old-page ref
rejection and mutation-invalidated continuation. This is Linux browser evidence,
not native Mac/Windows or installed-user-browser acceptance.
