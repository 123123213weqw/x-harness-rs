# Native browser bootstrap: implementation and acceptance gates

## Shared control chain

Use the existing `plugin_mcp` tool, not another top-level Browser tool. The
Desktop advertises `@xharness/native-browser` even with zero tabs, but discovery
is not a page grant. `control/open` routes to the actual AppFrame and BrowserPane,
expands the sidebar and creates a native child WebView. `ready` is a native
page-load + session binding receipt. Observation/action authority remains the
current visible session/tab/origin; no page data is returned by unbound discovery.

Cancellation, socket EOF, tab close/chat switch, navigation, stale callbacks,
invalid schemas and origin changes have explicit no-effect/unknown-effect
semantics. Once navigation is admitted, cancellation cannot claim `not_started`.
No arbitrary JS-eval tool or global desktop-input bypass was added.

## This iteration

- MSVC: embed Common Controls v6 exactly once through a dependency-only linker
  manifest, including library-test executables. Disable Tauri's duplicate RC
  manifest only on MSVC; retain its icon/version resources. Portable tests and
  `mt.exe`/`dumpbin` inspect the actual executables before running unit tests.
  `e1e6994` initially hit duplicate resource `MANIFEST/1`; `81e1751` fixes that.
  On `81e1751`, Windows desktop check/unit tests/Clippy and native DOM probe passed.
- Linux: the real zero-tab fixture reproduced X11's
  `xcb_xlib_threads_sequence_lost` abort. GDB recorded the main X11 event queue
  and Tao's X11 device thread. Initialize Xlib threading before Tauri/GTK opens
  a display; pure Wayland skips this initialization. The post-fix isolated
  zero-tab suite passed 12/12; this is regression evidence, not a claim about
  every Linux compositor/distribution.
- Readiness tests retry only bounded read-only observations when presentation is
  settling. They record every denial, never replay actions or hide transport/JS
  errors. Persistent hidden/mismatched ownership still fails acceptance.
- Public native APIs have **test-only** thin adapters: GDK/WebKitGTK,
  NSEvent/WKWebView snapshot, WebView2 CDP. They do not change production tool
  schemas, permission semantics or advertised capabilities. Mouse/key success
  requires real fixture state and trusted events; screenshots require native PNG
  CRC/dimensions and changed-marker pixels, not just a successful callback.
- A hidden-view marker changes to yellow before capture. This checks background
  script/snapshot behavior separately from production hidden-tab policy.

## Exact evidence scopes

1. Portable Python contracts and strict UI/build equality: engineering regression.
2. Linux disposable native AppFrame + BrowserPane, four task families × three
   repetitions: 12/12, cleanup 12/12, zero provider requests, 97.475 total seconds.
   Those 12 repetitions recorded zero readiness retries. A preceding run caught
   one transient laid-out/active observation denial; its failure is retained.
3. Linux native-API prototype: trusted click and z key down/up/input, cross-origin
   iframe coordinate click, three changed-color screenshots and hidden yellow
   pixels all verified. 11.282 seconds; API calls zero. This is not OS-global
   automation, general iframe element traversal, or a video recorder.
4. macOS/Windows prototype: require the new candidate's native CI receipts; older
   DOM-only probe success does not establish these new API results.
5. Paid DeepSeek: actual Host with only `plugin_mcp`, genuine native WebView and
   canonical AppFrame; starts with zero tabs and natural prompts (no tool-name
   hint). Each trial has an independent fixture-state grader and accounting/
   teardown gates. Outcome counts are recorded separately after completion.

Paid trials use a **new browser-only USD 1 ceiling**, with verified 2026-10-06
peak cache-miss rates (USD 0.30/M input, 1.20/M output). Every request durably
reserves the full 1M-input/8192-output envelope before forwarding. Missing usage
retains that reservation; transport retries are charged. Existing CNY ledgers are
not reset or relabelled. The key stays in local memory; the remote Host receives
only an expiring loopback capability. USD numbers are conservative bounds, not a
provider invoice. Source: <https://api-docs.deepseek.com/quick_start/pricing/>.

## Remaining release gates

- Collect new macOS/Windows native-API results on the exact candidate SHA.
- Finish and independently grade all paid zero-tab trials; close their ledger.
- Review cross-origin **element discovery/refs**, full recording/encoding,
  background policy, non-ASCII/IME/shortcuts, transfers and ownership revocation
  before enabling native inputs/screenshots as production capabilities.
- Require all current PR checks green before merge. Build/package and installed
  application smoke tests are separate from source/native probe acceptance.
- No local app replacement, release or ongoing-user-task interruption in this
  iteration. The macOS AX Computer Use backend is a separate failure domain;
  this browser work does not claim to fix that backend's permission/timeouts.
