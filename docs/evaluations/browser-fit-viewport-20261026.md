# Fixed CSS browser viewport / fit-to-pane

## Scope

Keep the native Tauri browser and existing `plugin_mcp` observation/input gateway.
The desktop UI defaults to a requested 1280 x 720 CSS viewport, with 1440 x 900,
1920 x 1080 and an explicit responsive mode. Sidebar geometry is presentation,
not the website's layout viewport. No browser streaming loop or new browser
process is introduced. No installed application is replaced by this change.

## Implementation

- Pure, bounded presentation planning lives in `browser_viewport.rs`.
- Native page zoom and letterboxed child bounds fit the requested CSS viewport.
  Public AppKit content geometry accounts for a titlebar inset without assuming
  a fixed height. Actual observed dimensions, not a requested label, must pass
  verification before an observation/screenshot becomes an actionable frame.
- GTK needs an owned `GtkOverlay` slot for each child: Wry 0.55.1's GtkBox path
  packs expanding siblings and its `set_bounds` is a no-op on that path. The
  main renderer retains its existing box. Browser slots occupy only their actual
  rectangles; there is no full-window transparent input layer. Hidden tabs are
  never exposed via `show_all`.
- AppKit/GDK input maps observed CSS coordinates to native content points.
  WebView2 CDP already consumes CSS coordinates and is not scaled again.
  Display/image coordinates must not be multiplied blindly by DPR.
- Layout changes invalidate old frames, share the per-tab operation gate and
  recheck active-tab ownership. Native screenshot metadata reports actual PNG
  dimensions separately from CSS viewport dimensions. Small screenshots are not
  upscaled and represented as original high-resolution captures.

## Acceptance

The existing genuine native WebView probe now adds 426, 640 and 360 pixel pane
cases. Each must retain approximately 1280 x 720 CSS layout, dispatch real trusted
clicks to all four corners and a checkbox in a 1000-pixel centered panel, reject
an old frame after resize and restore responsive layout. An independent stdlib
PNG checker verifies all four colored corner pixels using actual image/CSS
ratios. Missing, duplicated or inconsistent evidence fails the overall runner.
This runs through the existing native probe CI entry on Linux/macOS/Windows;
Playwright UI mocks are explicitly not native acceptance.

## Validation status

- Strict UI types and reproducible repository-only build: passed.
- Chromium/WebKit browser-pane and native-boundary UI regressions: passed.
- Chromium/WebKit component picker: 10 cases each passed.
- Python native acceptance/checker regressions: 25 tests passed.
- Architecture freeze and formatting: passed at the recorded working-tree base.
- V100 Linux desktop unit tests: 92 passed; all-target Clippy passed.
- Initial genuine native fit test FAILED: GtkBox allocation stayed 800 x 300,
  yielding a 2403 x 901 CSS viewport after zoom. It was not accepted as a pass.
- Corrected native allocation uses explicit GTK overlay slot placement. Native
  tests measure the content allocation, not Wry's pre-margin allocated_size.
- A subsequent first-click failure was traced to the preceding picker's deliberate
  400 ms release-click suppression. The independent viewport probe now runs
  before the picker; picker assertions and suppression behavior are unchanged.
  Initial macOS CI independently exhibited that same fixture interference.
- V7 final functional Linux contract PASSED on three consecutive isolated runs:
  16.569 s / 16.647 s / 16.599 s; same compiled binary. All three narrow panes
  retained width 1280 and height 720/721 CSS pixels, all native corner/modal input
  checks passed, and the independent PNG checker verified all four corners.
  Original PNGs were downloaded and independently rechecked locally as well.
- V8 adds a cancelled-callback guard and checked margin arithmetic; its exact-source
  native rerun is pending. No new UI behavior is introduced by these guards.
- macOS/Windows exact-head native CI remains pending. The native matrix currently
  certifies the default 1280 x 720 viewport, not a blanket claim for every preset,
  OS, high-DPI display or installed package. No software was installed/restarted.

Rust compilation/testing is remote-only on WZU_Server. Intermittent SSH failures
were handled through its existing alternate SSH port; TLS/host-key checks and
installed software were not changed. Build resources include a cached genuine
Host sidecar solely to satisfy Tauri packaging prerequisites; the native probe
starts no Host or model. Interrupted/failed source transfers are not validation.

Implementation references: [pinned Wry GTK backend](https://github.com/tauri-apps/wry/blob/wry-v0.55.1/src/webkitgtk/mod.rs), [GTK overlay placement](https://docs.gtk.org/gtk3/signal.Overlay.get-child-position.html). No vendored dependency source was modified.

## Review follow-up (2026-10-27)

Reconciled with current master (`98ba4c30`) without editing the original dirty
research checkout. The unrelated Swarm CI blockers used TurnEnd as if it also
proved a committed Delivered marker and an idle driver. Tests now wait for those
separate facts before issuing a revision-sensitive review or an unrelated send;
the 15-second deadlines, exact execution-reference assertions and CAS rules are
unchanged. Shared Host validation on WZU_Server: 470 passed, 8 existing explicit
opt-in tests ignored, all-target warning-denying Clippy passed, and 30 subsequent
rounds of all 29 Swarm tests passed. This is not a production scheduling change.

For this reconciled viewport source, WZU_Server desktop library passed 92 tests,
all-target tests and Clippy passed, and the genuine Tauri/WebKitGTK probe passed
all core/lifecycle/subframe/production-input/fit-pixel/cleanup gates in 16.587s.
Exact-head Mac and Windows CI are still required. The PR remains a draft until
those gates actually pass; no installed app was touched.

## Windows baseline diagnostic and mobile integration

The first CI attempt for `d9e30eb4` failed the existing
`every_upstream_rpc_has_baseline_behavior` test: `subagent.interrupt` did not
settle within its unchanged ten-second assertion. The root cause remains unknown;
this viewport change does **not** claim to repair that scheduling failure.

One predeclared diagnostic rerun of the identical head completed successfully
(job `122127199802`, workflow `40477404526`, attempt 2). The baseline test passed,
its 24-test binary passed with no skips, and the existing Windows native WebView
DOM/input acceptance step succeeded. The original failed attempt and the success
log are retained under `dist/merge-reviewed-20261027/`. This is evidence of a
non-reproduced failure on the rerun, not proof of a root-cause fix; no repeated
rerun-to-green, timeout extension or weakened assertion was used.

The local integration with accepted mobile-layout master `0f36ef82` regenerated
manifest/graph/HTML from source. Source browser-activity and 24 conversation tests,
formatting and architecture checks passed. Rust sources are byte-identical to
`d9e30eb4`; the integration changes only the mobile UI, tests/docs and generated
assets. This updated head still requires an entirely fresh cross-platform CI run
and remains a draft until those exact-head native gates pass.

## Diagnostic CI post-cache timeout

The new-head diagnostic run `40491024148` / Windows job `122144688911`
completed every mandatory test, warning-denying Clippy check, release build,
offline projection stress/cold-start gate and artifact upload successfully.
It was then cancelled in `Post Run Swatinem/rust-cache@v2`: the annotation
explicitly reports the original 20-minute job limit. The final artifact upload
ended at 11:09:00 UTC and cache cleanup was cancelled at 11:09:09. This was **not**
a new `subagent.interrupt` failure and is not treated as green CI.

The diagnostic workflow now follows the main CI's read-only PR cache convention:
cache restoration is retained, but only a master push may save a target cache.
No test, artifact or compiler gate is made optional; the 20-minute job limit and
all assertions stay unchanged. A Node regression checks that exact save policy,
all required diagnostic/stress gates, absence of continue-on-error, and the
unchanged deadline; mutation checks reject cache-save, timeout and missing-gate
regressions. Fresh exact-head Windows CI is required to validate the workflow fix.

## Integration with the merged extension and native-session master

Reconciled with actual master `8c098c50f71770108e59b95bba176e5fd936fc64`
after #391 and #403 merged. The probe registration conflict retains **both**
`viewport_probe` and `session_request`, and both awaited run calls. The three
generated manifest/graph/HTML conflicts were rebuilt from combined source.
No hash was selected by hand.

An initial isolated desktop build lacked a staged Host sidecar and did not reach
tests. After building the real Host from the same synchronized source and staging
it plus system ripgrep, all-target compilation exposed a real integration error:
the newly imported session-request probe still called the pre-viewport three-
argument `desktop_browser_bounds`. It now passes `None` for its normal responsive
viewport. The production API and both probes' assertions were not weakened.
Original failed logs remain in `dist/merge-reviewed-20261027/heartbeat-20261027-1134/`.

The corrected synchronized source passed on WZU_Server:

- Desktop all-target tests: 100 library, 46 browser-inspect example, six Host-
  recovery example and 43 native-browser-bench tests; all-target Clippy with
  warnings denied; actual browser-inspect probe build.
- Real isolated Tauri/WebKitGTK probe in **17.602 seconds**: native core, lifecycle,
  subframe, production-input and fit-viewport pixel gates, plus profile cleanup,
  all passed. The fit receipt verifies three narrow panes and responsive restore.
  The unchanged session-request probe also executes in that same native run.
- Chromium and WebKit each passed the UI native-bridge race/visibility fixture
  and actual-runtime dock fixture (their Tauri transport is mocked, not native).
  A first local browser attempt had no installed Mac Playwright executable and is
  not counted as passed; the successful browser runs were isolated on WZU_Server.
- Repository UI rebuild, typechecking, activity tests, 24 conversation tests and
  the fit-evidence verifier unit test passed; formatting and architecture passed.

Logs are `401-final-master-rust-native.log`, `401-integrated-browser-fixtures.log`
and `401-integrated-source-tests.log` under that snapshot directory. Native PNGs
and receipts are retained in `401-native-linux-evidence/`. Only documentation was
added after executable-source validation. This is **Linux** evidence, not fresh
Mac/Windows certification. The integrated head remains draft and must pass fresh
full exact-head CI before merge. The earlier intermittent Windows interrupt
failure still has no established root-cause fix. No installed software changed.

## Fresh-CI follow-up: nested formatting, procfs observation and build budget

The `55e9af41` attempt is not green. Actual completed-job logs were retrieved
through the job-log API while the overall workflow was still pending:

- Windows/macOS Rust and Linux Tauri jobs stopped at the nested desktop workspace
  formatter: `session_request` and `viewport_probe` module declarations were not
  sorted. Root `cargo fmt --all` did not include that excluded workspace. Applied
  its own manifest formatter and now check **both** workspace formatters. Both
  modules and their awaited native acceptance calls are retained unchanged.
- Linux Rust failed the process-cancellation test's **observer** after a managed
  PID disappeared: reading `/proc/<pid>/stat` returned ESRCH, not ENOENT. The helper
  treated that as an inspection failure. A deterministic read-result regression
  first reproduced the original panic before the correction. The Linux-only test
  helper now treats only ESRCH and the existing NotFound case as disappearance;
  permission/I/O errors and malformed stat still panic. Live and zombie states
  remain distinct. No production executor/process-lifecycle code changed.
  The entire original cancellation-test body, including immediate owned-root
  reaping, no-live-descendant checks and both three-second bounds, is byte-identical
  (receipt `401-cancellation-assertions-receipt.json`).
- The runtime Windows job also hit 20 minutes **during release stress-harness
  compilation**, after its 12m16s production Host build. Subsequent mandatory
  stress gates did not run, and post-cache was skipped. Ported the already
  validated shared workflow correction: independent required Host/PDB job plus
  the original native matrix/stress/packaging gates, unchanged profiles and
  20-minute deadlines, with read-only PR caches. This is not an unchanged-head
  rerun or an extended assertion deadline.

After synchronizing the corrected source to WZU_Server, coding-tools all-target
regression passed **41** tests, with seven pre-existing explicit opt-ins ignored;
all-target Clippy denied warnings successfully. All 12 bundle tests passed,
including three new procfs tests. All **30 predeclared** consecutive runs of the
original process-cancellation test passed, with no added retries or longer
bounds. The genuine isolated Linux Tauri probe also passed all native core,
lifecycle, subframe, production-input, three-pane fit-pixel, session-request and
cleanup checks in **17.253s**. Node lifecycle/workflow-policy and its nine negative
mutations pass. Only documentation was appended afterward.

Original failures, the expected failing before-fix test, successful regression
log and unchanged-assertion receipt are retained under
`dist/merge-reviewed-20261027/heartbeat-20261027-1218/`. The procfs helper was
byte-identical on #404, so the same narrowly scoped test-only correction is also
applied there; this does not assert that #404's current CI had failed. Both
candidates still need fresh full exact-head CI, especially actual Mac/Windows.
The earlier intermittent Windows interrupt root cause remains unknown.


## Windows workflow-policy line-ending regression

The `9cedc9e2` runtime Windows job `122190939306` failed in the Node policy
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
