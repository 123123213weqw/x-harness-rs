# Owned browser production integration — 2026-10-27

## What changed

New website tasks can discover `@xharness/native-browser / browser` through the
existing `plugin_mcp` tool. The desktop runs its Rust CDP adapter against a fresh
installed Chrome/Edge instance. The sidebar is a scaled preview, not the owner
of the browser or its control grant. Existing explicit `webview` tasks remain
on their original backend; their request envelope stays compatible with older
Desktop bridges (no new selector field on the legacy wire path).

No running app, installed Host, real conversation or model service was restarted,
replaced or deployed during this acceptance. Rust compilation ran on WZU_Server,
with the worktree synchronized first. Loopback synthetic fixtures, new profiles
and test-owned processes were used throughout.

## Completed evidence

| Layer | Actual result | Scope |
| --- | --- | --- |
| Production Rust browser manager + installed Chrome 155, V100 Linux | 14 cases passed, including 100 consecutive hidden observe/input/PNG cycles | Actual browser and trusted effects; no renderer or model needed |
| Images | 102 PNG files verified at 1280×720; JPEG preview verified at 640×360 | RGB marker effects and scroll offsets checked; hashes in adjacent JSON |
| Browser lifetime | Normal close and unexpected controller SIGKILL both released the owned process tree and temporary profile | Pipe-lease helper; no scan/kill of unrelated user browsers |
| Host library | 151 passed, 3 pre-existing explicit opt-in tests ignored | MCP discovery/routing, actual owner, schema reuse, media pipeline, session retirement and existing Host coverage |
| Desktop library | 95 passed; all-target tests and Clippy passed | Includes cancellation/no-replay, capacity, stale closure, profile validation and existing shell tests |
| Existing native WebView | Genuine isolated Tauri/WebKitGTK contract passed (15.129 s) | Lifecycle, subframe navigation, native input/PNG and cleanup; no full browser parity claim |
| Preview and new-page routing UI | Chromium and WebKit passed | Real source-built AppFrame/BrowserPane, mocked Tauri only; hidden polling stops, no backend close on collapse, no foreground stealing, one in-flight preview, exact-owner close, owned default and explicit WebView option |
| Existing browser UI | Chromium and WebKit passed | Native bridge, access/overlay/async guards, dock fallback/native dock, persistence; ordinary Web pane on both engines, restore runtime on WebKit |
| Tool row presentation | 15 strict-source tests passed | Exact built-in browser label and legacy/foreign fallback retained |
| Build/static contracts | Strict source UI build (61 modules, 190 assets), architecture/freeze/fmt, browser routing fixtures, startup/bootstrap/assets, updater (32 cases) passed | No Rust compilation on the Mac |

The three ignored Host tests require separately opted-in deployment metadata,
external browser-use process-chain acceptance, and a live product-package
HTTPS download. They are not counted as passed.

The transport-level UI and Host socket tests are **not** a real LLM/installed-app
end-to-end test. Playwright WebKit is **not** macOS WKWebView. Linux Chrome success
does **not** establish macOS/Windows runtime success; those real-engine checks
are enrolled in their existing desktop CI jobs and must pass before merging.

## Issues caught and corrected during acceptance

- Installed-browser discovery initially reached a reqwest TLS-provider panic:
  explicitly install the existing ring provider before creating the local client.
- Cross-origin iframe messages can mutate the parent between observation samples:
  retry only invalidated reads, at most three times. Never replay an effect.
- Immediate browser killing raced cache writers during profile cleanup: use
  `Browser.close`, a separate helper lease, child reaping and bounded cleanup.
- An old ready page could satisfy a new navigation: require the new document's
  loader and committed frame URL before reporting readiness.
- Screenshot clipping must use the current visual viewport offsets after scroll,
  not the document origin. Pixel assertions cover this case.
- Full all-target Clippy exposed example-only bridge module omissions; examples
  now register the same manager and honor the helper entry point.
- Preserve the legacy bridge's deny-unknown-fields contract: the new backend
  selector is sent only for the new server.

A local browser-runtime test attempt could not launch an absent cached Playwright
revision; it was rerun using the isolated V100 dependencies. A persistence test
attempt used `canonical` for a deliberately source-only unit seam; it was rerun
with `UI_TEST_IMPL=source`. Neither failed attempt is represented as a pass.

## Limits and follow-up

- One page/chat, at most four live chat browsers, fresh ephemeral profiles. No
  inherited login/cookies/extensions, arbitrary JS, recording, cross-origin DOM
  traversal, popup/dialog tool or downloads (downloads are explicitly denied).
- Collapse stops **preview** traffic, not the site's JavaScript or an active
  model task. This is not a promise of zero hidden-browser CPU usage.
- No new production Rust-versus-WebView CPU/RAM A/B result is claimed here. The
  prior Playwright prototype measurements cannot be relabelled as this adapter.
- No installed Mac/Windows runtime, real Edge-only fallback or signed-package acceptance occurred locally.
- Independent native viewport/login PRs are not merged into this branch. Preserve
  their native backend when integrating; do not transfer credentials to headless.

## Reproduce

See `docs/owned-headless-browser.md`. The real-engine runner uses no model/API
credentials. CI runs 20 hidden cycles on Linux/macOS/Windows and uploads PNG and
receipt evidence alongside the existing native browser artifacts. Local acceptance
on V100 used 100 cycles. The adjacent JSON preserves completed cases and all PNG
hashes; full local logs and image files remain in this worktree's ignored
`dist/headless-host-20261027/` directory.

## Review follow-up: preview timeout isolation

The first macOS CI rejected input after a preview. A disposable Mac Chrome/CDP
experiment confirmed that disconnecting the session owning device emulation
changes `innerHeight` from 720 to 633. Preview previously used that same socket;
its 350 ms cancellation could therefore invalidate an otherwise stable model
frame. Preview now uses an independent, read-only CDP connection. Its timeout
cannot disconnect the control session or reset its emulation.

A deterministic fake-CDP regression stalls the production preview path, cancels
it, and successfully consumes the original frame on the *same* control session.
On WZU_Server the updated desktop library passed 96 tests, all target tests and
warning-denying Clippy passed, and installed Chrome passed all 14 real-manager
cases including 100 hidden input/screenshot cycles (101 RGB-verified PNGs plus
the scroll PNG). macOS/Windows exact-head CI is still required; the Mac CDP
mechanism experiment is not a claim that the complete app passed on Mac.

## Joint native-login / background-browser integration

This branch now includes the native-login request branch as a dependency, so CI
compiles the combination rather than relying on two individually green PRs.
The private bridge explicitly rejects `request` and `read_response` on the
background backend before accessing native WebView state. Host rejects those
calls before opening the bridge socket as well. Background discovery selects
exactly control/observe/perform/screenshot/input by name, not a positional zip
that would accidentally expose WebView-only login tools after the native catalog
grows. Shared schemas are compared by tool name; native login remains available
only on its explicit backend. Both production examples register both adapters.

Combined validation on WZU_Server: desktop all-target tests and warning-denying
Clippy passed; Host application library passed 153 tests with 3 existing opt-in
ignores, and all-target Clippy passed. New tests verify the exact five-tool
background surface, unchanged shared schemas, early no-connection rejection of
login tools and no native-login fall-through. No cookies are moved between the
isolated background instance and the native WebView. Exact-head cross-platform
CI is still required before merging.
