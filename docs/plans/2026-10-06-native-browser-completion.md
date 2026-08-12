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
4. Exact `b6e2c65` CI receipts: Windows trusted mouse/key, cross-origin coordinate
   click and changed-color foreground PNGs passed (23.109 s); a hidden snapshot
   timed out and is **not** marked supported. macOS changed-color foreground/
   hidden PNGs passed, but native input produced no trusted events (19.190 s).
   The callback-only gate incorrectly passed that probe. The strict core gate
   now fails unsuccessful input. On `4216067`, the coordinate-only hypothesis was
   rejected: WKWebView reported `flipped=true`, correctly converted points, but
   no input events; the strict CI gate failed as intended (15.245 s). An owned,
   invisible, nonpersistent WKWebView diagnostic reproduced window `sendEvent`
   dropping input; direct scoped native responder dispatch plus focus settling
   produced trusted click/key/input/key-up and `z`. That diagnostic is not Tauri
   acceptance. The next candidate uses the owned WKWebView's public responder
   methods and waits for observed input focus before sending keys; it must be
   retested in actual Tauri. This is not three-platform parity.
5. Paid DeepSeek: actual Host with only `plugin_mcp`, genuine native WebView and
   canonical AppFrame; starts with zero tabs and natural prompts (no tool-name
   hint). Each trial has an independent fixture-state grader and accounting/
   teardown gates. Outcome counts and retained admission failures are recorded below.

Paid trials use a **new browser-only USD 1 ceiling**, with verified 2026-10-06
peak cache-miss rates (USD 0.30/M input, 1.20/M output). Every request durably
reserves the full 1M-input/8192-output envelope before forwarding. Missing usage
retains that reservation; transport retries are charged. Existing CNY ledgers are
not reset or relabelled. The key stays in local memory; the remote Host receives
only an expiring loopback capability. USD numbers are conservative bounds, not a
provider invoice. Source: <https://api-docs.deepseek.com/quick_start/pricing/>.

## Real DeepSeek zero-tab outcomes (2026-10-06)

Machine-readable, numeric-only result: `docs/acceptance/native-browser-zero-tab-20261006.json`.
Raw receipts/histories and the closed ledger are retained in the local acceptance
evidence directory, not checked into the public repository. Large raw transfer
timed out; compressed essential receipt/history/log transfer completed.

Exact native/Host candidate: `b6e2c65d811f4b0e7867b00210e5a5ec3ec45cd4`.
Each accepted trial checked real fixture state, settled provider accounting,
zero pending requests and owned-process/profile teardown. Natural prompts did
not name `plugin_mcp` or any browser operation. Only that tool was available.

| Disposable browser task | First complete run | Second complete run | API calls |
| --- | ---: | ---: | ---: |
| Issue form + independent issue state | 45.962 s, pass | 43.188 s, pass | 18 + 17 |
| PR review + independent review state | 46.749 s, pass | 40.310 s, pass | 18 + 18 |
| Dynamic page controls | 67.829 s, pass | 46.280 s, pass | 17 + 20 |
| Keyboard/game page state | 81.196 s, pass | 72.444 s, pass | 25 + 25 |

There were **12 attempted trials, not 8/8 attempts**: eight fully executed trials
passed; four intermediate trials were blocked by the evaluator's original
80-call gate (2/0/0/0 admitted calls), before complete execution. These original
failed receipts are retained; they are not erased, marked successful or blamed
on model quality. No real GitHub Issue/PR was created; these are disposable web
fixtures for browser-control acceptance.

The original USD 1 financial ledger was explicitly closed/settled, then continued
with a 200-call limit, preserving the initial 80 calls, rows, denials and
USD 0.1262214 cumulative bound. Its money ceiling never increased. Final closed
ledger: **160 requests, pending 0, conservative USD 0.2628189**, eight numeric
admission denials. This is a peak-cache-miss cost upper bound, not an invoice.
Original CNY experiment accounts were untouched; the ephemeral remote provider
capabilities were removed and the local controller stopped.

The runner now separates `passed`, `blocked_by_budget_gate`, `evaluation_failed`,
`task_failed` and `not_evaluated`. A numeric admission failure stops later doomed
trials; provider/Host error turns are not silently counted as task-quality scores.
No output/action is replayed or edited to make a failed trial pass.

Engineering validation: 62 portable Python tests, 54 remote desktop library
unit tests, strict source UI typecheck/build equality. Remote Linux prototype
core APIs passed; the independent CI repeat also passed in 11.745 s, plus 4/4
pre-opened and 4/4 genuine-zero-tab contracts. Core native feasibility now
requires trusted state AND decoded changed-marker pixels, not merely receipt
presence. Full browser parity remains a separate gate. Apple documents NSEvent's
window coordinates and view conversion; WebKit's public WKWebView responder
methods route to its native input pipeline. References:
<https://developer.apple.com/documentation/appkit/nsevent/locationinwindow>,
<https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/mac/WKWebViewMac.mm>.
The retained failures, not those references alone, determine acceptance.

## Remaining release gates

- Retest scoped WKWebView native responder/focus acknowledgement and the strict core gate on macOS/Windows.
- Review cross-origin **element discovery/refs**, full recording/encoding,
  background policy, non-ASCII/IME/shortcuts, transfers and ownership revocation
  before enabling native inputs/screenshots as production capabilities.
- Require all current PR checks green before merge. Build/package and installed
  application smoke tests are separate from source/native probe acceptance.
- No local app replacement, release or ongoing-user-task interruption in this
  iteration. The macOS AX Computer Use backend is a separate failure domain;
  this browser work does not claim to fix that backend's permission/timeouts.
