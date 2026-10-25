# XHarness Browser extension — first candidate

An opt-in Chrome/Edge 123+ Manifest V3 extension, not Computer Use and not an embedded
WebView replacement. It controls only tabs the user pairs explicitly in the
extension popup. No system mouse, remote-debugging port, arbitrary JavaScript/CDP,
cookie export, profile copying or automatic fallback to another browser.

## Architecture

```
model → existing plugin_mcp → per-chat browser-extension/browser MCP process
                                  ↕ authenticated loopback channel
                        browser-owned Native Messaging process
                                  ↕ length-prefixed JSON
                        MV3 extension → approved tab's CDP + fixed DOM functions
```

The per-chat process publishes a random private rendezvous token and a separate
human pairing code. Only the pairing code is returned to the model. User actions
in the packaged popup are the only path to grant a tab. A tab has one owner.
Stopping, host permission removal, a client exit, native disconnect or an origin
change revoke the lease. Pending grants and queued effects cannot borrow a later
lease. Unknown effects are not replayed. Pairing does not bypass existing Host
MCP approval or installation controls.

The installed app needs its existing external MCP support; optional Host discovery
labels identify this candidate as `backend: extension`, `readiness: not-probed`.
No new independent model tool is introduced. The embedded browser and isolated
headless `browser-use` retain their separate login/session boundaries.

## Developer candidate setup (explicit, never automatic)

1. `npm ci --prefix plugins/browser-extension --ignore-scripts` and
   `npm run build --prefix plugins/browser-extension`.
2. Obtain `xharness-browser-extension-host[.exe]` for your OS through a tested
   remote/CI build. Downloadable launchers are not yet part of the desktop release
   packages; do not mistake the browser ZIP for a complete native installation. Rust builds/tests must follow the repository's remote-only policy.
3. In Chrome/Edge's extension management page, enable Developer mode and load
   `plugins/browser-extension/dist` as an unpacked extension. The checked-in
   public manifest key gives it a stable development identity; no private key is
   distributed. This is not a Web Store publication or automatic update channel.
4. Inspect the registration plan:
   `node plugins/browser-extension/scripts/install-native.mjs --browser chrome`.
   It changes nothing. To install deliberately, add
   `--binary /absolute/path/to/xharness-browser-extension-host --register`.
   Use `edge` or `chromium` for those browsers. Registration is per user, not
   system-wide. The native runtime is snapshotted by digest outside the main app.
   Node 20+ is an explicit runtime dependency in this first candidate. Re-register
   after removing/replacing its pinned Node executable. No passwords/API keys are
   read. Windows directories use a protected current-user/SYSTEM ACL.
5. Build packages with `node plugins/browser-extension/scripts/package.mjs`.
   The plugin archive is compatible with the existing verified catalog installer:
   publish/import it through a reviewed catalog source and enable its MCP server.
   No public catalog or user plugin store is modified by these scripts. This is
   per-chat protocol scoping, not an OS sandbox against arbitrary same-user code.
6. Ask the model to call `plugin_mcp` with plugin `browser-extension`, server
   `browser`, tool `browser`, arguments `{"action":"status"}`. In the extension,
   connect, select the matching code and a tab, then authorize that tab/site.

The browser shows its normal debugging permission/attachment indication; this
extension does not suppress it. Closing the popup does not stop authorized work.
The browser and Host/MCP process must remain alive: this does not run after device
sleep or after they exit. A disabled/uninstalled extension is not auto-restored.

Custom `--user-data-dir` browser profiles use their own `NativeMessagingHosts`
folder on Unix. The default installer targets the selected browser's standard
per-user directory; it does not scan or modify unrelated profiles.

## Interface and bounds

One MCP tool, `browser`, with discriminated schemas:
- `status`, `tabs`, `stop`;
- `observe(tabId)` → bounded untrusted main-frame text and one-shot DOM identity refs;
- `click(tabId, observationId, ref)`, `fill(..., text)`, `press(tabId, key)`;
- `navigate(tabId, url)` within the granted origin; waits for the committed loader
  and completed tab state, with a bounded deadline;
- `screenshot(tabId)` → real PNG MCP image content, not base64 transcript text.

| Resource | Bound |
| --- | --- |
| Connected per-chat clients / authorized tabs | 16 / 16 |
| Queued extension commands / one client pending calls | 16 / 8 |
| Concurrent screenshot capture | 1 |
| Native frame / host → browser frame | 4 MiB / 1 MiB |
| Observer | 16,000 UTF-8 JSON bytes, 64 refs, 3,000 visited text nodes |
| Ref lifetime | 30s, consumed before an effect |
| Text insertion | 8,192 characters |
| PNG | 2 MiB compressed PNG bytes, 8,192 per dimension, 16M pixels |
| Command / navigation readiness deadlines | 20s / 10s |

Model calls see only their authorized tabs. DOM observations exclude password
fields/values; screenshots contain the rendered page and are not content-redacted.
This is not a network firewall: a user-opened tab can load normal subresources;
origin changes revoke *control*. Existing HTTP-only login cookies stay inside that
browser tab/profile. No cross-origin DOM/frame traversal, coordinate actions,
file upload/download, browser-wide settings, video recording or Safari/Firefox
support is claimed by this first candidate.

## Regression

- `npm test --prefix plugins/browser-extension`: strict protocol, framing,
  per-user registration plans, actual unpaired MCP, wrong-token/disconnect,
  pending-grant/stop races, exclusive ownership and old queued effects.
- Remote Rust: launcher tests, `plugin_mcp::browser_boundary`, Clippy, and explicit
  `extension_status_uses_real_plugin_mcp -- --ignored` with the JS already built.
- Isolated Linux Chromium only:
  `XHARNESS_BROWSER_EXTENSION_TEST_SERVER=1 UI_TEST_DEPS=/path/to/locked/playwright
  XHARNESS_BROWSER_EXTENSION_HOST=/path/to/native/launcher xvfb-run -a node
  scripts/browser_extension/acceptance.mjs`.

The real suite starts fresh profiles and local fixture sites, registers Native
Messaging inside that temporary profile, and tests actual popup → launcher → MCP
round trips. Its test-only extension pregrants only that ephemeral fixture origin;
it does **not** claim that the production optional-host-permission prompt was
clicked through. Background means Chrome `tab.active=false` and unchanged active
foreground tab, not a guess from `document.hidden`: Playwright/debugging may
virtually keep the renderer visible. Its observed renderer visibility is recorded.

macOS/Windows real browser + installer click-through, real account/CAPTCHA handoff,
and long-running/RSS measurements remain separate acceptance gates. Portable plan
unit tests are not a substitute for those gates. Building a candidate does not
install, publish, restart or replace the user's browser or XHarness application.

References: [Chrome debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger),
[Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
[MV3 lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
