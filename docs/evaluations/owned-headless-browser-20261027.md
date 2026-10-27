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

The final combined browser source also passed the genuine isolated Linux native
WebView probe (15.003s, all enrolled lifecycle/input/pixel/cleanup gates), plus all
14 owned-Chrome manager cases with 100 hidden cycles. Chromium and WebKit both
passed source-built lifecycle/preview/hidden/owner/close/single-flight UI checks
(mock transport). Combined desktop library: 105 passed. These results do not
substitute for the still-required macOS/Windows exact-head CI gates.

## Exact-head macOS failure and completed-read isolation

The independent-preview-connection change above was **not sufficient**. The
macOS job for `56289057` still rejected the first input after preview with
`stale observation geometry; observe again`. Downloading that exact CI-built
arm64 probe and running it against an isolated loopback fixture on Mac reproduced
the failure. No Rust was compiled on Mac, and the installed app was not used.

Preview now keeps one bounded, read-only CDP task alive across the 350 ms caller
wait. A timeout returns `busy`, not cancellation: the next preview poll collects
that same capture. The task owns only the preview connection, never the control
instance lock. Closing the chat still retires its slot and terminates its owned
browser; late preview results cannot cross that boundary. The deterministic
regression delays capture for 700 ms, consumes the original model frame while
the preview is in flight, and verifies exactly one capture rather than replay.

An initial Linux acceptance attempt with that fix completed the effects but
failed cleanup: a Chrome network-service descendant recreated a profile file
after the browser root exited. That attempt is not counted as passed. The helper
now reuses `xharness-process` lifecycle ownership on every platform (Unix process
group / Windows kill-on-close Job), waits for the owned tree to quiesce, and only
then removes its exact temporary profile. It neither attaches to nor kills the
user's personal browser. This moves an existing desktop dependency from
Windows-only to cross-platform; no new external crate is introduced.

After source synchronization, WZU_Server passed desktop all-target tests
(including 105 library tests), all-target Clippy with warnings denied, and the
same real Chrome acceptance: **14 cases, 100 hidden cycles, 101 screenshots**, with
profile cleanup and owned-process reaping both passing. Full logs are in
`dist/merge-reviewed-20261027/managed-preview.log`; remote receipt and PNGs are in
`dist/review-preview-managed-tree-20261027/`. Fresh exact-head macOS and Windows
CI are still mandatory. These Linux results do not establish that the previously
reproduced Mac failure has been resolved on Mac.

## Integration after the mobile-layout merge

After #399 merged, combined the native-session branch's rebuilt mobile assets
with this background-browser branch. Only generated manifest/graph/HTML files
conflicted; all were regenerated from the combined source, not selected by hash.
The native/headless Rust sources are unchanged from the managed-tree validation
above. Source browser-activity and 24 conversation tests passed. On WZU_Server,
Chromium and WebKit each passed model-control lifecycle/preview/hidden-owner/
close/single-flight checks (mock native transport), the actual-runtime browser
dock fixture, and all 20 light/dark composer viewport cases including Stop,
Queue, Send, draft/caret, menus and Goal/Todo controls. No page errors occurred
in the dock fixtures. Fresh cross-platform CI for this integrated head remains
required before merging.

## CI follow-up: input-triggered blocked-navigation settlement

The GUI candidate's existing server-browser `origin` gate failed at head
`0fc56d1e`: after clicking a forbidden link, its pending Chromium error-page
commit interrupted the next allowed navigation. The forbidden origin still
received zero requests; the failure was command sequencing, not permission
relaxation. The existing rejected-`goto` settlement did not cover successful
input dispatch that initiated a later navigation.

The same event-based main-document barrier now covers semantic clicks, coordinate
clicks, targeted key presses and page-level key presses. A bounded constant
renderer read orders input dispatch before checking navigation events. This was
necessary: an initial event-observer-only patch still reproduced the problem on
real page-level Enter input, whose request arrived after dispatch returned.
Readback and future commit/load settlement share the existing two-second bound;
no fixed sleep, effect replay, deadline increase or origin-policy exception was
added. Non-navigation input has one renderer read but no terminal-load wait;
failed input without navigation preserves its error without waiting. Late
site-initiated autonomous navigation is not promised away.

Validation after source synchronization on WZU_Server:

- Before the production correction, five new deterministic assertions failed.
  The final navigation suite passes all **19** tests, including readback ordering,
  context invalidation, an unresponsive readback, close/listener cleanup and
  truthful bounded failures.
- Five preplanned additional mixed-input stability rounds pass: **60** forbidden
  link inputs across semantic click, targeted Enter, page Enter and screenshot-
  bound coordinate click, followed by exactly one recovery navigation each.
  Actual request counts prohibit replay; the forbidden server receives zero
  requests. Each targeted round runs one real case, not the whole suite.
- The unchanged full server gates pass: **24** engine cases, **6** stdio cases,
  **30** legacy checks, with current source/build provenance. Gate and policy
  mutation tests remain enrolled; required cases and assertions were not removed.
- Chromium and WebKit each pass **243** fixed native DOM contract checks. These
  are browser-script checks, not the native Tauri callback seam.

Full final log: `dist/merge-reviewed-20261027/heartbeat-20261027-1026/input-final-server.log`.
The first unsuccessful observer-only experiment and original CI failure remain
alongside it. A local negative-name-filter experiment unintentionally selected
real-engine tests without an installed cached browser; its owned test process was
stopped and fixture startup cleanup was corrected. It is not counted as a pass.
The successful real-engine runs above took place only in the isolated Linux
checkout. No model credentials, installed app or user conversations were used.
Fresh exact-head cross-platform CI is still required before merging this PR.
