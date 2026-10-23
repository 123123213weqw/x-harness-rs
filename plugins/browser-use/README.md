# Browser Use (server adapter)

> Unreleased server-core candidate. Isolated V100 acceptance covers 24 real
> browser cases, 6 stdio MCP cases and the unchanged 30-check legacy gate.
> This is not full ZCode API parity or proof of superior model task quality.

An opt-in isolated Chromium adapter over XHarness's existing `plugin_mcp`
registry, approvals, cancellation and per-chat process lifetime. It does **not**
attach to the embedded Tauri WebView, user Chrome profile, cookies or desktop.
Removing/disabling this plugin does not change ordinary chats.

## Build and configure

Inside `plugins/browser-use`, use Node 20+ and run:

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run build
```

Playwright and TypeScript are pinned in the lockfile. There is no runtime
TypeScript loader or arbitrary JavaScript/eval endpoint. The MCP entry remains
`node ${PLUGIN_ROOT}/server.mjs`; enabling the plugin and its MCP server remain
separate explicit operator decisions. Source-only installations need the above
build before enabling. No catalog, live configuration or production deployment
is changed by this candidate.

Required operator environment:

- `XHARNESS_BROWSER_ALLOWED_ORIGINS`: JSON array of exact approved HTTP(S)
  origins. Empty list means HTTP(S) is denied. Native CDP enforcement covers
  redirects, child frames and subresources too; approve required asset/CDN origins
  explicitly. Chromium without this enforcement capability fails closed rather
  than falling back to incomplete redirect routing. This is not an OS network
  sandbox, and does not make untrusted browser content a privileged authority.

Optional explicit server environment (not inferred from user credentials):

The Host clears arbitrary inherited environment variables. To use either option
below through `plugin_mcp`, explicitly add that variable to the operator-approved
server `env` configuration; setting it only on the parent shell is insufficient.

- `XHARNESS_BROWSER_ARTIFACT_ROOT`: a dedicated staged-files/output directory.
  If omitted, a private temporary directory is removed on orderly shutdown.
  Uploads resolve symlinks and must be regular files inside this root. Downloads
  use generated names, not website-provided paths. Abrupt process kill may leave
  temporary artifacts for operator cleanup.
- `XHARNESS_BROWSER_PROXY`: credential-free HTTP(S)/SOCKS5 proxy for this isolated
  browser only. Loopback fixtures bypass it; no OS proxy setting changes.

The previous external `XHARNESS_BROWSER_DEPS` lookup is no longer used: plugin
runtime dependencies are installed beside its own source/build.

## One tool, precise commands

The existing `browser` tool covers:

- `tabs`, `new`, `select(targetTabId)`, `close(targetTabId)`;
  `navigate(url,reuse?)`, `back`, `forward`, `reload`.
- `observe`: paged text, ARIA snapshot, node identity references, iframe IDs and
  open-shadow-root controls. Follow returned text/node/frame offsets rather than
  assuming an omitted control does not exist.
- Targets: `{ref,observationId}` or semantic locators such as
  `{by:"role",role:"button",name:"Search",frameId?}` and
  `{by:"label"|"text"|"placeholder"|"testId",value,frameId?}`.
- `click`, `fill(text)`, `type(text)`, `press(key)`, `hover`,
  `selectOption(values)`, `check(checked)`, `scroll(x,y)`, `drag(target,destination)`.
- `wait(target,state)` / `wait(loadState)` / bounded `wait(milliseconds)`.
- `screenshot(fullPage?)` returns a **real MCP image content block** and exact
  raster metadata. `mouse(screenshotId,x,y,operation)` uses viewport pixels;
  full-page captures cannot be used for viewport coordinate clicks.
- `dialog(accept,text?)`, `upload(target,files)`, `download(downloadId)`.
- `console(after?)`, `network(after?)`: bounded diagnostics, no response bodies,
  cookies or request authorization headers.

Refs are consumed before effect dispatch; replacement DOM identities cannot
silently inherit them. Coordinate actions bind the latest valid screenshot and
reject invalid navigation/layout/scroll geometry. Effects are never retried
blindly. Receipt outcomes are `not-started`, `possibly-applied`, `applied`;
`applied` describes dispatch completion, **not task completion**. Pending dialogs
and failed post-observations require checking real page state before retrying.

A late iframe navigation can invalidate an in-progress screenshot after the
parent's DOMContentLoaded. Only this discarded read-only capture may be retried
(at most three attempts, sharing the existing PNG timeout budget). Each attempt
rechecks navigation and layout, removes discarded PNGs, and never repeats the
preceding click/navigation. Continuously changing pages still fail without
publishing an actionable screenshot; unrelated errors and image budgets are not
retried.

Legacy `frame_id/ref`, `select(value)` and paged snake_case observation arguments
remain accepted at the MCP boundary. New semantic commands do not automatically
capture both DOM and screenshots after every action. Password values are
redacted; telemetry URL queries are stripped. Page observation URLs retain
navigation-relevant query fields but redact credential-like keys. Webpage text
and console messages remain untrusted and can themselves contain sensitive data.

## Images in XHarness

Generic MCP PNG content now projects through the existing session attachment
sink, rather than inserting base64 into transcript text. One PNG per call,
8 MiB decoded PNG bytes (base64 wire is bounded separately), maximum dimension 8192 and 16M pixels. Original
raster geometry is preserved. Text retains the existing 64 KiB budget. Malformed
images, unsupported MIME, multiple images or a non-vision model fail explicitly;
use semantic observations instead. These are not silent conversion fallbacks.

This requires the Host media-projection changes in this checkout: installing the
JavaScript plugin alone does not add image support to an older Host binary.
An explicit server-only integration test uses the actual plugin process, PluginManager,
durable runtime, production media sink and file attachment store. A scripted provider
inspects the resulting image block; the test checks rendered pixels, dimensions,
session isolation and restored attachment bytes. It does not assess an LLM's vision.

## Acceptance and limits

Run browser acceptance only in the isolated server checkout after building:

```sh
XHARNESS_BROWSER_TEST_SERVER=1 node scripts/browser_use/acceptance.mjs
XHARNESS_BROWSER_TEST_SERVER=1 node scripts/browser_use/stdio.mjs
```

The tests assert fixture-owned effects, trusted browser events, exact file and
PNG evidence, stale-target rejection and recoverability. They do not count
installation, API return success or model self-assessment as task success.

The aggregate runner also checks evidence integrity (26 positive/negative tests)
and seven native-policy control branches. It rejects missing/duplicate cases,
invented totals, changed source hashes and partial legacy results. Rust media
evidence and the opt-in browser/Host integration are separate gates.

### Navigation cancellation regression

The unchanged legacy gate exposed a real race: a same-origin request cancelled
by navigation returned `Invalid InterceptionId.` for `Fetch.continueRequest`.
Treating it as an enforcement failure closed the dedicated browser after an
already-applied click. Only this exact error for an already-allowed continuation
is now tolerated, without retrying the request or action. Denial failures,
unknown errors and timeouts still fail closed. A real cancelled-response fixture
and negative control-transport tests cover the distinction. See the pinned
[Playwright cancellation handling](https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/chromium/crNetworkManager.ts#L680-L694)
and the content-bound acceptance reports for the independently reproduced case.

Reference: official ZCode source revision
`3c5b227649371507ddc4eb46ac5133afe6db1cab`. This candidate uses public Playwright
APIs, not a wholesale copy of its desktop implementation. The feature matrix is
`docs/evidence/browser-use-parity-matrix-20261022.json`.

**Not full ZCode parity yet:** no JS Worker object-graph facade, arbitrary page
evaluation, clipboard, full network bodies, persistent user profile, CDP desktop
WebView adapter or full original-agent/runtime A/B benchmark. Public `ariaSnapshot`
materializes ARIA before output clipping; output bounds are not a renderer-memory
sandbox. Cross-origin support requires explicit origin permission; closed shadow
roots are not exposed. Performance superiority has not been established.


## Live DeepSeek A/B (2026-10-22)

The corrected primary experiment completed **48 trials on V100**: eight generated
workflows, three seeds per workflow, two backends. Both arms used
`deepseek-flash`, thinking enabled/high effort and Chromium 149.0.7827.55,
with a requested bootstrap viewport of 1280x800 and identical limits of 25 model requests, 40 tool actions and 300 seconds.
Arm order was counterbalanced. Models chose their own actions; page-owned final
state, not model claims or tool receipts, determined success. PNGs were sent as
real image parts when requested (17 screenshot calls per arm).

| Metric | XHarness candidate | Original ZCode headless backend |
| --- | ---: | ---: |
| Completed goals | 21/24 (87.5%) | 23/24 (95.8%) |
| Mean task duration | 21.0 s | 20.5 s |
| Median task duration | 16.2 s | 11.9 s |
| Provider-reported cumulative input tokens | 2,790,161 | 4,771,186 |

Candidate input tokens were 41.5% lower, but task completion and latency were not
better. Cumulative input includes repeated conversation input and cache hits; it
is not unique context size or monetary cost. This small suite is not evidence of
statistical superiority, external shopping performance or full ZCode app parity.
The reference used its unchanged pinned headless backend behind a disclosed test
broker, not its desktop UI or agent prompt/runtime. Native tool schemas differ;
reference Playwright-core 1.59.1 versus candidate Playwright 1.61.1 is a dependency
confound despite the common Chromium executable.

Failure traces expose target-schema/parser mismatches, unhelpful missing-field
errors and consumed/paged reference overhead. In both failed modal tasks the
model had already read the correct service facts but did not shortlist it within
the budget. No valid tool call was found to execute against the wrong target.
These are findings, **not fixes applied after the comparison**.

An initial full phase was retained but excluded from the primary comparison:
immediate browser cleanup could cancel a final page effect. A 40-case native
regression reproduced this in the original modal and a delayed-effect control.
The corrected evaluator passively observes final state for up to 500 ms before
closing, with no action replay. All 48 trials were rerun under that policy.

Reports in `docs/evidence/`:
- `browser-use-parity-model-ab-20261022.json`: audited primary totals, per-pair
  hashes, exact backend/build provenance and PNG verification.
- `browser-use-parity-model-ab-review-20261022.json`: trace-level failure review
  and phase/cleanup disclosure.
- `browser-use-parity-ab-teardown-20261022.json`: independent 40-case audit.

### Reproduce in an isolated V100 checkout

Use `scripts/browser_use/prepare-ab-reference.mjs --output=<new-directory>` to
extract and SHA/git-blob verify the pinned original source. In that directory run
`npm install --ignore-scripts --no-audit --no-fund`,
`node build-reference.mjs` and `node check-reference-shim.mjs` on V100. The helper
performs transpilation, not full upstream monorepo typechecking. The original
Apache-2.0 license stays beside the extracted source. Nothing is vendored into
the production plugin.

Build the candidate on V100, then run the fixture contracts there:
`XHARNESS_BROWSER_TEST_SERVER=1 node --test scripts/browser_use/ab-fixture.test.mjs`.
The task-specific `scripts/browser_use/run-ab-server.py` launcher forwards the
existing local evaluation keychain credential to V100 stdin, checks the synced
runner hash and sets the pinned reference/browser paths. Supply a **new** absolute
server `--output`, a private `--local-log`, `--repeats=3 --concurrency=4`.
Do not copy secrets into a config file, command arguments or the child MCP env.
On V100, audit completed evidence with
`node scripts/browser_use/ab-report.mjs <result-directory> <output-json>`.
The auditor requires all trials and image files, validates paired facts, page
scores, PNG hashes and settlement-before-cleanup, and rejects incomplete samples.

### Follow-up interface repair

Action-specific schema constraints and target alternatives now share the parser's
pre-dispatch validation. Missing `target.observationId`, conflicting target forms,
`fill.value` (instead of `text`), and action-inapplicable fields return named field
paths plus canonical examples; invalid arguments never reach browser execution.
The schema is 15,124 UTF-8 bytes, below the existing 32 KiB MCP schema limit.
Current observation identity, one-shot reference consumption, strict ambiguity,
DOM replacement and navigation guards are unchanged. Stale/omitted references now
explain how to re-observe or use returned pagination cursors without suggesting
an automatic replay or guessed index.

The server aggregate includes six schema/parser contract test groups (97 canonical
and 10 legacy examples plus negative mutations), three native reference-guidance
regressions and expanded malformed-call assertions through actual stdio MCP.
For the unchanged legacy gate, set `UI_TEST_DEPS` to an installed Playwright
package directory, e.g. the isolated checkout's `plugins/browser-use`.
The preceding A/B table describes the **pre-repair** candidate; it is not reused
as acceptance of the changed interface. A separate full rerun records its own
source/build hashes and output directory. In that rerun the candidate completed
24/24 goals (18.3 s mean), against 23/24 (19.1 s mean) for the original headless
backend. This does not establish universal superiority: the model is stochastic
and the generated suite is small. Candidate cumulative input rose 12.35% versus
its pre-repair run as the explicit schema grew, while model requests fell from
295 to 252. It still used 30.48% fewer input tokens than the concurrent reference.
The prior reports and failures remain preserved rather than overwritten.


Follow-up reports:
- `docs/evidence/browser-use-parity-interface-fix-20261022.json` records the fixes,
  regression proof, exact before/after settings and selected failure recovery.
- `docs/evidence/browser-use-parity-model-ab-interface-fix-20261022.json` is the
  untouched server-audited 48-trial follow-up, including all pair/PNG hashes.

**Additional comparison limitation:** the reference bootstrap requested1280x800,
but a later original `newTab` uses its native1280x720 default (directly observed
in the failed reference modal trial's `getState`). The previous description of
identical viewport sizes was too broad. This is disclosed rather than silently
changing the reference or relabeling trials. Candidate before/after viewport is
unchanged; no strict viewport-controlled horizontal ranking is claimed. The
candidate median15.1s also remains above reference12.6s despite its lower mean.

## Embedded versus background browser boundaries

The two backends remain separate, explicit `plugin_mcp` targets:

| Task | Target | Discovery label |
| --- | --- | --- |
| User-visible/current page, existing signed-in page, manual participation | `@xharness/native-browser` / `webview` | `backend: embedded`, `visibility: user-visible` |
| Independent public-page background task, no inherited login session | explicitly enabled `browser-use` / `browser` | `backend: headless`, `visibility: background` |

Embedded availability still comes from the existing owner-bound private bridge,
including zero-tab discovery. Headless discovery verifies the pinned server
configuration and existing MCP opt-in without resolving environment references or
starting a process. Its `availability: configured` / `readiness: not-probed` labels are **not** a live-browser
readiness claim, permission grant or security attestation of a package by name.
Other MCP plugins keep their existing discovery behavior.

Calls still specify plugin/server and use that backend's own tab/frame/reference
identities. There is no automatic backend rewriting, fallback, cookie/profile
transfer, credential scanning or new tool. Authentication/CAPTCHA/manual handoff
requires an explicit user decision and a fresh operation chain, not replay of an
uncertain action in another browser. Existing approval and disable/revocation
policies remain authoritative. The choice guidance is not an automatic natural
language classifier or a new access-control policy.

A synthetic server test checks that a headless context retains its own cookie
across actions, but other/new contexts do not receive it; it does not access real
accounts or claim real WebView login acceptance. The earlier A/B scores describe
the pre-boundary-discovery candidate, not a live-model routing test of this change.

### Invocation activity, not inferred model activity

The authenticated native bridge and open/close lifecycle publish compact
owner/tab/invocation metadata to the trusted main renderer. A scoped lifetime
guard ends activity on return, failure, timeout or cancellation. Discovery/status,
unbound callers, generic MCP activity and model thinking do not light a page.
No URL, input payload, cookies or credentials are included in these events.

The native BrowserPane displays a monochrome frame and a small accessible status
glyph. Its fixed border is outside the measured child WebView rectangle, so
starting/ending activity does not resize the page or rely on CSS overlays above
a native child view. The ordinary Web empty state is unchanged. Concurrent calls
are tracked independently; bounded finished-ID storage plus a monotonic retirement
watermark prevents late starts resurrecting ended calls. This is presentation
only: it adds no commands, polling, authorization or dependency on an observer
being mounted. A pane attaching after a start can miss that short indication;
provisional opens use their existing authenticated, non-persisted request ID.

Chat tool records distinguish exact embedded/background MCP call targets without
changing their existing run/error/stop states. A label is not proof of successful
input, browser readiness or task completion. Headless calls never illuminate an
unrelated visible WebView.

Current Linux acceptance is recorded in
`docs/evidence/browser-use-backend-boundary-20261022.json`: strict production UI
build, Chromium/WebKit component tests with mocked native transport, Rust tests
and Clippy, genuine native bridge ownership/cancellation, actual production
AppFrame zero-tab scenarios, and separate legacy-pane compatibility. These are
zero-model controlled-page contracts, not real-account or live-model routing
acceptance. Playwright WebKit is not macOS WKWebView validation; Windows/macOS,
real login/CAPTCHA handoff and complete ZCode parity remain separate work.

The GUI acceptance workflow now builds the locked plugin before invoking it and
runs the server acceptance suite in addition to the unchanged browser contracts.
It uses the repository's locked test dependencies instead of an ad-hoc Playwright
install. Hosted GitHub CI still needs to run when this candidate is submitted.

### Rejected navigation settlement

A rejected navigation can still commit an error document after Playwright returns.
The engine passively waits for a **future main-frame commit and load**, resetting
the barrier on a newer main navigation, with one bounded two-second deadline.
Reading the previous document's already-loaded state is not completion evidence.
Success adds no wait, and all Page listeners/timers are removed on every exit.
The original rejection/uncertain receipt remains unchanged: no automatic replay,
URL substitution or weakened origin policy. A missing terminal event still exits
at the deadline rather than hanging the queue.

`navigation-stability.test.mjs` covers deterministic event orderings and twelve
real Chromium blocked-redirect/allowed-parent cycles with zero forbidden requests.
The fixture waits for its child-frame load before asserting a single observation;
production observations racing navigation still reject stale snapshots. Eight
additional stress batches (96 cycles) passed after fixing that fixture boundary.
The old engine fails three deterministic boundary tests; the live baseline race
did not reproduce in twelve trials, so this is not a claim of deterministic live
reproduction. Current engine/MCP/legacy acceptance is 24/24, 6/6 and 30/30; see
`docs/evidence/browser-use-navigation-settlement-20261023.json`. Native platform
and real-account acceptance limitations above still apply.
