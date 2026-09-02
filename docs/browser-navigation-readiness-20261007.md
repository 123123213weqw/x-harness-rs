# Native browser navigation/readiness regression

## Reproduction (installed macOS 0.2.37)

The requesting desktop Host was on an ephemeral loopback port, not the separate
3082 Web Host. Three model opens of the desktop Baidu homepage returned the
30-second lifecycle timeout; Example Domain and mobile Baidu did load. An HTTP
200 from curl alone does **not** establish that all WebView requests completed.

A disposable two-origin localhost fixture was opened manually in a new native
browser tab. After its delayed iframe loaded, macOS AX reported the top document
at `http://127.0.0.1:49804/top`, while the XHarness address field changed to the
child `http://127.0.0.1:49803/child`. In the desktop Baidu diagnostic attempt,
`browser origin changed; synchronize the visible page again` appeared and the
native view was hidden. The temporary tab/server were closed; original tabs,
conversations, independent Web service and installed app were preserved.

## Cause and boundary

Wry 0.55.1's WKWebView navigation policy passes a URL without a main-frame bit.
The app treated that frame-agnostic policy as top-level location/load authority:
it changed `loaded`, revoked origin delegation and emitted `url`. The UI then
used this child origin when binding the actual top page. Separately, even a
duplicate `url` event reset the UI's completed-load flag.

## Correction

- Policy still filters schemes and conservatively invalidates action refs. It
  neither publishes the candidate URL nor changes top-level readiness/grants.
- Top-level page-load callbacks publish their native URL before load status.
- Policy hints coalesce into a trusted-shell-only sample of `WebView.url()` and
  native readiness; this also preserves same-document/fragment navigation.
- Newer page-load events supersede delayed samples. Duplicate URL notifications
  do not reset readiness. Explicit UI navigation revokes old refs/grants before
  dispatch. Guest pages cannot invoke the new state command.
- Existing single `plugin_mcp`, ownership/origin checks, provisional cancellation,
  30-second wait and non-replay semantics remain. This is not a claim that every
  public website will finish loading within 30 seconds, nor a full browser API.

## Regression gates

- Production AppFrame/BrowserPane with mocked transport, Chromium and WebKit:
  zero-tab open, load-before-promise, duplicate URL, top-level cross-origin
  redirect, native-authoritative iframe hint, same-document URL, stale sample,
  wrong owner, malformed requests, cancellation and late completion.
- Native disposable Tauri probe, each platform: post-load same-origin and
  cross-origin iframe; top URL/readiness/owner preservation; stale action refs;
  hash location notification; guest state-command rejection.
- Probe runner requires explicit subframe evidence and rejects missing,
  malformed, failed or duplicate records. Compilation success is not acceptance.

Native macOS/Windows results must come from their CI probe receipts. Headless
Playwright WebKit is not WKWebView acceptance. No installed-app update or public
release is part of this fix.
