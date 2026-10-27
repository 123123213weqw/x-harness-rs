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

## Extension-master integration and prior-head macOS evidence

PR #391 merged as `1b2e68f9982dae60afc443beb6815b30dc06b92c` after its full
exact-head CI succeeded. Integrating it into this branch produced one source
conflict in browser boundary guidance. The resolution preserves both the
preferred chat-owned background browser and explicit WebView selection, plus
the extension's Host-owned conversation identity and per-tab/origin authority.
The guidance regression now checks that neither backend's selection or
authorization rule disappears. No generated UI assets conflicted or changed.

After synchronizing the combined source to WZU_Server, the Host-app library
suite passed **155** tests with four existing opt-in cases ignored, and all-target
Clippy passed with warnings denied. The prepared real extension MCP opt-in test
also passed separately (**1** case): its native launcher and JS were built from
this synchronized source. Extension Node tests passed **31** cases with the
Windows-only ACL case skipped on Linux; that skip is not Windows validation.
Log: `dist/merge-reviewed-20261027/heartbeat-20261027-1113/404-with391-host-app.log`.

The previous head `4625b436a90f5062cb4e7655c592910ec4c12edd` also completed its
actual macOS arm64 CI job `122143373337` successfully in run `40490444606`.
It passed real owned-browser acceptance (**14** cases, **21** screenshots),
plus native WebView standard/overlay-titlebar probes. These are native Mac
results, unlike the earlier Linux/mocked checks. They establish success only
for that previous head. The newly integrated head still requires fresh full CI,
including actual macOS and Windows gates, before merge; #403 must merge first.
The original stale-geometry failure and unsuccessful experiments remain recorded.
No installed application, user profile or active conversation was changed.

## Final base integration after native-session merge

PR #403 merged as `8c098c50f71770108e59b95bba176e5fd936fc64`. Integrating
that actual master into the extension-integrated candidate changed ancestry
only: before adding this receipt, both trees were exactly
`b48773940b20b85848a7dfa8e51ff2a6fb547ee8`. Rebuilding the production UI
from repository source produced no asset differences; typechecking, browser
activity and all 24 conversation-source tests passed. This avoids treating
selected generated hashes as the source of truth.

The prior `4625b436` main CI is now fully successful, including its Windows
x86_64 native job `122143373524`: real owned-browser acceptance passed 14 cases
with 21 screenshots, and native WebView probes passed both normal and delayed
readiness. As with the Mac results above, these are prior-head receipts, not a
substitute for the new integrated head's full CI. Source and deadlines were not
weakened; no application was installed, restarted or deployed.

## CI follow-up: independent Windows repro compilation budget

Integrated-head `eaaea9f7` runtime diagnostics run `40497918748`, Windows job
`122167977680`, was cancelled at its unchanged 20-minute job deadline. This was
**not** the earlier #401 post-cache cancellation: here cache cleanup was skipped.
The production Host/sandbox release build took 12m07s. The next release stress
harness compilation spent the remaining 6m22s compiling another dependency/test
feature graph, ending at `Compiling xharness-host` before a test-start line. The
reasoning stress test is therefore unverified in that attempt; the journal,
100-cold-start and dynamic gates were skipped, not passed. Original job/log/
annotation evidence is retained in the `heartbeat-20261027-1203` snapshot.

The production Host/PDB build is an independent reproduction artifact, not an
input to those `xharness-host` library tests. It now runs as a separate required
`windows-host-repro` job, with the identical build command, Windows target and
matching Host/PDB upload. The existing native matrix retains every microtest,
Clippy, EXE/PDB parser, all four unchanged **release** stress commands, and offline
executable packaging. Both jobs keep 20-minute deadlines and fatal failures;
stress sizes, original assertion timeouts and profiles are unchanged. No serial
`needs` dependency is added. Both PR jobs restore caches without saving them.
The local diagnostic installer/deployment job and workflow event/permission
settings are unchanged.

Validation before pushing:

- Local and WZU Node UI/lifecycle/workflow-policy tests pass, including nine
  negative mutations covering missing jobs/gates/symbols, cache saves, release
  profile removal, optional stress, timeout extension and restoring the old
  serialized Host build. A YAML semantic comparison confirms every original
  native step remains identical except the cache policy and relocation of the
  two Host artifact steps.
- After synchronizing current source, WZU_Server passes the **four original
  release stress invocations** unchanged, with no private journal supplied.
  This verifies the test job's independence from compiling a production Host in
  the same job. These are Linux results, not native Windows certification.
- Rust/application sources, runtime defaults and installed software are unchanged.

Logs: `404-ci-original-release-stress.log`, `404-ci-policy-tests.log`,
`404-server-ci-policy-tests.log` and `404-workflow-semantics.log` under that snapshot.
Fresh full exact-head CI, including both native Windows jobs and the browser
Mac/Windows gates, remains mandatory. No unchanged-head rerun or deadline
extension is used to turn the cancelled attempt green.

## Shared Linux cancellation-observer regression

The exact-head #401 Linux log exposed a shared test-helper bug: after a managed
process disappeared, `/proc/<pid>/stat` could report ESRCH rather than ENOENT,
causing the observer itself to panic. The original `bundle.rs` blob was identical
on #401 `55e9af41` and this branch's `b3b80fd2`
(`5ce2cd28d3010ea4e4762035878a253c68bd081d`). The same narrow test-only correction
is applied here; this is not a claim that #404's pending CI had failed.

Only Linux ESRCH and the existing NotFound case mean disappearance. Permissions,
I/O failure and malformed procfs data still fail the test; live and zombie states
remain distinct. Three deterministic helper regressions cover these cases. The
original cancellation test body is byte-identical, preserving its immediate
root-reap/no-live-descendant assertions and both three-second bounds. A before-
fix regression reproduced the original ESRCH panic on WZU_Server, followed by
30 predeclared consecutive successful runs of the original cancellation test.
No production executor, process cleanup, browser routing or runtime code changed.

After synchronizing **this** candidate, WZU_Server coding-tools all-target tests
passed **41** cases with seven pre-existing explicit opt-ins ignored; all-target
Clippy with warnings denied and Node workflow-policy/mutation tests passed.
The common helper, workflow and policy files now match the reconciled #401
candidate to avoid resolving the same issue differently on two branches.
Provenance, unchanged-assertion receipt and full separate branch validation logs
are in `dist/merge-reviewed-20261027/heartbeat-20261027-1218/`.
This branch still requires fresh full exact-head CI, including the independent
Windows Host/PDB job and the actual Mac/Windows browser acceptance gates.


## Windows workflow-policy line-ending regression

The `587992dd` runtime Windows job `122192296162` failed in the Node policy
checker with `missing required job native`, not a missing YAML job or a Rust
failure. Windows checkout line endings left `\r` on the header when the helper
split only on `\n`. A new CRLF fixture first reproduced the exact assertion
before the fix. The parser now accepts LF and CRLF line boundaries and returns
the same job scope for LF, CRLF and mixed input.

The existing nine negative mutations are preserved and exercised under all
three line-ending variants (**27** rejecting cases), including deleted jobs,
missing stress commands, optional gates, release-profile removal, lost symbols,
PR cache saving, deadline extension and serial Host builds. UI/lifecycle tests
and these policy tests pass locally and independently on WZU_Server after each
branch's current-source synchronization. Both Rust formatters and architecture
checks pass. No workflow, Rust code, assertion deadline or runtime setting changed.

Original Windows logs, the expected before-fix failure and WZU output are retained
in `dist/merge-reviewed-20261027/heartbeat-20261027-1242/`. This is a portable
line-ending fixture regression, **not** a claim that current native Windows or
Mac acceptance has passed. Fresh full exact-head CI remains required before
merge. No installed software or running task was changed.
