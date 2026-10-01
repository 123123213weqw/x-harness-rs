# Computer Use and Browser Use acceptance

## Scope and controls

The user authorized real DeepSeek testing and iterative improvements, with a total API spending ceiling of **CNY 200** and an acceptance report at **2026-10-01 08:00 Asia/Shanghai**. These confirmed controls supersede the initial Goal's provisional 09:00 time and pending budget.

Keep the current tool registry, Core execution loop, Host persistence and platform adapter boundaries. Do not replace the user's running desktop, interrupt their jobs, submit public Issues/PRs, or modify their GitHub repositories during capability tests. Use disposable workspaces, browser profiles and fixtures. Changes remain reviewable separately from releases.

## Evidence tiers

1. Contract regression: deterministic driver and UI fixtures. This tests engineering correctness, not model competence.
2. Real model and controlled browser: fixed tasks, hidden grader, dedicated profile, genuine model calls and browser interactions. Identify the engine; Chromium automation is not evidence of controlling the embedded Tauri WebView.
3. Native macOS and embedded WebView: actual shipped Computer tool/Host loop, permissions, screenshots or accessibility nodes, no substitute execution path. Record permission failures separately.
4. Public comparison: pin OSWorld V2.1 assets and evaluation settings before reporting comparable results. A small local suite cannot establish SOTA.

## Spending admission

Use the existing benchmark credential broker rather than passing the real credential to models, child processes or files. Resolve the local credential in memory. Reserve a whole allowed provider input window plus the configured maximum output before each paid request; charge missing usage conservatively, including transport failures and retries. Checkpoint the ledger before forwarding so a process crash cannot reset spending. Never increase the CNY 200 ceiling on resume.

Official pricing checked on 2026-09-30: Flash peak cache-miss input CNY 2/million and output CNY 8/million; use these conservative rates even during off-peak and cache hits. Usage-based bounds and the account balance change are separate evidence: other clients may also consume this account.

Sources: [DeepSeek pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/), [vision format and limits](https://api-docs.deepseek.com/guides/vision/), [OSWorld V2.1](https://github.com/xlang-ai/OSWorld-V2).

## Fixed task families

- GitHub Issue search, filtering, opening and retrieving a specific fact; signed-out/read-only live task plus a deterministic local counterpart.
- PR title/body typing and validation, never submit; a local counterpart grades exact field state and absence of submission.
- Dynamic form and modal with delayed controls, scrolling, stale observations and re-observation.
- Small target-click game with fixed seeds; report accuracy, action latency and end-to-end model latency separately.
- Navigation/history, cancellation, timeout, disappeared targets and network interruption; no automatic replay of an already applied side effect.

Freeze tasks/seeds before baseline. Repeat tasks; keep AX-only, screenshot-only and hybrid results separate. Grade actual browser/native state, never the model's own success assertion. Record task failures, tool errors, latency, steps, token usage and conservative cost. Failure-driven additions are new versions, not retroactive changes to the baseline.

## Work sequence

- [x] Create the Goal and schedule the 08:00 report.
- [x] Inspect the existing Computer contract, macOS adapter and embedded browser boundary.
- [x] Run existing Computer UI tests in Chromium and WebKit; these mock the native boundary.
- [x] Check local credential availability, free model listing and balance API without printing credentials.
- [x] Add a reusable, fail-closed tool allowlist at native composition for isolated GUI evaluation.
- [x] Add crash-resumable CNY budget admission and tests; reuse the credential broker's transport.
- [x] Build the exact candidate on remote/CI and download only the needed macOS artifact.
- [ ] Establish native permission/observation baseline in an isolated test surface.
- [x] Run fixed real-model task repetitions; investigate and fix measured failures.
- [x] Re-run overnight regression and baseline after each fix, including remote Rust tests.
- [x] Report verified overnight results, limits, costs, optional features and outstanding work at 08:00.

## Initial findings

The current Computer surface is one tool with nine actions and a macOS adapter. Linux/Windows have no real Computer adapter. The embedded browser is an unprivileged child WebView with UI navigation/download commands; it currently has no model-facing DOM observation/action API. Its page must not receive privileged Host or updater IPC to implement Browser Use.

The current frame guard identifies the most recent observation, not arbitrary UI mutations occurring afterwards. Whether this causes stale-target actions must be established with a regression/real fixture before claiming a fix. AX traversal budget/depth may omit deep browser controls; measure before changing defaults.

## Overnight checkpoint (07:20 CST)

- First CI candidate and every required general CI job passed. Exact binary/source hashes and private artifacts are recorded per trial; all Rust compilation/tests ran remotely or in CI.
- Four fixed local GUI families ran three times each through **real XHarness Host → real DeepSeek Flash → existing plugin_mcp → isolated Chromium**, with actual field/game state grading: 12/12 passed. This is a small semantic browser suite, not a public benchmark.
- The signed-out real GitHub task searched closed Issues, opened #143 and retrieved its priority risk areas. Full archived tool evidence and all text pages must be combined by the grader; original erroneous scores remain in the private artifacts rather than being overwritten.
- Native macOS trial: three Accessibility observations timed out; the independent desktop surface reported that the Mac was locked. This is **infrastructure-blocked**, not a model failure. No permissions were changed and no unlock was attempted. Await manual unlock.
- Measured production corrections: preserve MCP `isError=true` as an outer executor failure (with full bounded evidence); apply deployment composition policy to Host-injected history/goal tools as well as native factory tools. Default production registration remains unchanged.
- Browser candidate improvements: explicit action field descriptions, latest-frame/element identity validation, no blind replay of uncertain/applied effects, and bounded/paged semantic observations. Long JSON results previously forced many `history` reads; node and text paging preserve access without injecting the entire page.
- Optional adapter lives under `plugins/browser-use`. It has **not** been installed in the user's application, merged, or released. It adds an isolated Playwright runtime only when opted in; it is not part of the zero-extra-runtime core application.
- Spending uses the one original CNY ledger; missing provider usage retains the entire reservation. Conservative upper-bound estimates are not claimed to be exact billed fees.

## Outstanding acceptance gates

1. Final candidate CI and post-fix real-model repetitions, costs and failure categories.
2. Actual unlocked macOS AX/vision/hybrid tasks, permission/cancel/timeout behavior.
3. Embedded Tauri WebView observation/action bridge. Keep visited pages unprivileged: a trusted desktop broker must own scoped commands/results, never grant remote pages Host/updater IPC.
4. Screenshot-driven browser tests, authenticated PR draft UX (only with explicit account scope), cross-frame and download/upload integration.
5. Pinned public OSWorld/BrowserGym evaluation before any SOTA/comparability claim. The overnight suite is an engineering baseline, not sufficient evidence of SOTA.

## Native WebView observation checkpoint after acceptance

The 08:00 report does not end the Goal. Paid admission has been closed with no pending requests; the original ledger is retained and must not be replaced to obtain a fresh budget. Subsequent work in this checkpoint uses no model/API calls and does not replace the user's application.

The pinned Tauri 2.11.5 dependency has `Webview::eval_with_callback`, confirmed in both its actual remote dependency source and [API documentation](https://docs.rs/tauri/latest/tauri/webview/struct.Webview.html). A fixed read-only evaluation function can return native page evidence directly; there is no need to expose Host/updater IPC or a credential-bearing callback endpoint to visited pages.

- `browser_inspect` owns the typed, bounded observation boundary; browser tab lifecycle stays in the existing `browser` module. Only `main` is granted the new command. Guest callers are rejected again by label.
- Each live tab owns a serial observation gate and navigation epoch. Selection, close/recreation or even a same-URL document reload invalidates a pending result. Callback waits are bounded; late callbacks cannot resolve another request.
- Fixed page/main/dialog scopes, text/node/option paging, password redaction and byte limits are implemented. No caller-supplied JavaScript/selector, action or network callback is accepted. Page data stays explicitly untrusted.
- Chromium and WebKit execute the exact evaluation function: 196 assertions per engine, including 180 long multilingual controls and recovery of all 100 select options. This is a DOM contract, not by itself proof of Tauri integration.
- V100 compiled and ran the **real Tauri/WebKitGTK callback** on a disposable Xvfb display/profile. Native redaction, unchanged input, guest IPC denial, hidden-tab denial and selection changes during a pending callback passed. Portal/FUSE warnings remain in the complete log; the probe exited successfully without changing server permissions.
- Remote desktop unit tests passed (31 library tests; the example additionally repeats 7 existing module tests), and `clippy --all-targets -- -D warnings` passed. Commit `8195903` subsequently passed the general CI (including desktop compilation/unit tests on all three platforms), GUI candidate and runtime diagnostics gates. Only Linux had an actual native WebView runtime probe at this checkpoint. Gitee mirroring failed twice with a connection reset; this is retained as a failed infrastructure check, not reported as all-green CI.

This was **only the native observation seam**, not a completed model-facing Browser Use implementation. No new model tool was registered and the production UI did not invoke it. macOS AX/vision, real authenticated form interactions and public benchmark comparison remain unverified.

## Native DOM action checkpoint after the user's continuation

The existing Desktop boundary now has a separate, strictly typed `desktop_browser_perform` command for click/fill/select/scroll. These are **DOM-script interactions**, not OS pointer/keyboard synthesis. No new model tool or Host executor has been added; production UI/model delegation is still pending.

- A bounded latest observation keeps refs to the actual page elements. Native state checks the current tab/navigation epoch and allows at most one scheduled effect per frame. An identically labelled replacement, changed value, removed/disabled/inert target or replaced option is rejected; every action requires a new observation afterwards. Only options included in that observation's option page can be chosen.
- A renderer callback is not task-success evidence. Receipts distinguish `not_started`, `applied` (DOM operation dispatched), and `unknown`. Callback timeout, malformed receipt or selection/navigation change after scheduling stays uncertain. The native frame is consumed before scheduling, so these failures cannot trigger blind replay. A queued operation expires before the callback deadline, mitigating arbitrarily late effects from a stalled renderer.
- A hide/reselect cycle previously could revive a pending observation because only the final active tab was checked. Selection now invalidates the old and new tab epochs, including returning to the same tab. Observation/action serialization remains per tab rather than a second scheduler.
- Guest pages receive no new native IPC capability or Host credentials. The page-local DOM map is untrusted identity evidence, **not a security authority**; native state owns frame admission. No caller-provided JS, selector, key or submit operation is accepted. A click still invokes page-defined behavior and could submit a form, so the future broker must enforce the user's task/delegation scope; absence of a `submit` action is not a no-submission guarantee.
- Chromium and WebKit run 226 contract assertions each. The V100 executes real Tauri/WebKitGTK fill/select/click and grades actual input/selection/text; native tests also exercise guest denial, repeated frames, replacement nodes, intervening edits, effects preceding an error, a stalled renderer/expired action, hidden tabs and hide/reselect while a callback is pending. This is no-model native adapter evidence, not an end-to-end model or public benchmark score.
- Remote desktop unit tests: 34 library tests passed; the example repeats 10 of those tests rather than adding 10 unique tests. Remote clippy passed. A common isolated probe runner records the compiled binary hash, OS, elapsed time, exit code and explicit `model_calls=0` / `os_input=false`; real probe execution on macOS/Windows is added to CI and remains pending until those jobs finish.
- The original paid ledger remains `closed=true`, 527 requests, CNY 40.089932 conservative upper bound, no pending reservations. This continuation has not made paid requests or reset the CNY 200 ceiling. The user's application and jobs have not been restarted.

### Next integration boundary

1. The trusted main UI delegates a specific tab to a specific existing Host session, with an explicit origin/task scope. Hide, close, revocation and session end invalidate its lease; no default sharing across parent/child Agents.
2. A private desktop broker transports typed operations and bounded untrusted evidence. Visited pages get no broker token, callback endpoint or Host/updater IPC. Do not use page labels or model-supplied owner IDs for authorization.
3. Reuse `plugin_mcp` discovery/call, the existing executor approval/cancellation path and session lifecycle. Keep broker transport/platform concerns out of Core and transcript projection; never add a second Agent loop. The stdio/native transport choice must not introduce a hidden Node/Chromium requirement into the core desktop path.
4. Cancellation after dispatch must retain uncertain effect state and require observation before any new decision. A native queued JS operation is not generally retractable; do not describe cancellation as proof that no page effect occurred.
5. Test actual Host → real model → scoped native tab on disposable fixtures, then signed-out GitHub and no-submission PR drafts. Keep DOM, screenshot/hybrid and native OS-input scores separate. Authenticated pages/file transfer and public comparison require their own acceptance, not extrapolation from these contracts.

## Private native bridge checkpoint (2026-10-01, server/CI only)

The user chose server/CI continuation without local pointer/keyboard use. This checkpoint does not change the 08:00 acceptance results or the closed paid ledger; no additional API calls, local application replacement, merge or release were performed.

- Desktop owns a private length-framed loopback bridge and an ephemeral per-tab grant. Only the trusted main UI can grant one exact Host session access to the currently visible native web origin. Read-only and interactive scopes are distinct; children do not inherit their parent's grant. A grant expires after ten minutes; hide, close, UI reload, another grant and cross-origin navigation revoke it. Same-origin navigation invalidates observation frames without extending the grant. Returning to an old tab/origin does not resurrect a revoked grant.
- The bridge's random credential goes only to the Host sidecar environment. Guest pages, tool metadata, transcript events and saved tabs receive neither the credential nor privileged IPC. Existing process environment isolation strips it from coding tools; explicit MCP environment interpolation of Harness-private browser variables is rejected. This is a structured tool/guest boundary, not an OS sandbox against arbitrary full-access programs.
- Host App reuses the **single existing `plugin_mcp`** discovery/call entry point. Native `observe`/`perform` schemas are lazy; ownership is captured by `SessionToolFactory`, not model arguments. Core, Host library, transcript projection and the Agent loop remain unchanged. The core native route has no new Node/Chromium dependency. Optional Playwright remains a separate opt-in plugin.
- One-shot frames and typed native receipts are retained across the bridge. Revocation is checked before dispatch and after callbacks. Cancelled/lost action replies are uncertain and non-retryable, not silently successful or automatically replayed. Cancellation after native dispatch cannot guarantee that no page effect occurred; observe actual state before a new decision.
- V100 regression passed: 38 Host App tests, 36 unique Desktop library tests, the example's 12 repeated module tests, and Host App/Desktop all-target clippy. Plugin configuration tests verify private environment isolation. Three actual Tauri/WebKitGTK broker probes passed with cleanup verified (9.233 / 9.235 / 9.236 seconds; binary SHA-256 `2814916d0669ad57605a49d577d75555108da5d4d7d5f88dbe453245f2a7dd56`). This time includes an intentional seven-second renderer stall, not model task latency. The probes check guest denial, exact parent/child ownership, read-only denial, delegated observation/fill, one-shot replay denial and hide/reselect revocation, alongside the earlier native action fixtures.
- Chromium and WebKit still pass 226 exact DOM-contract assertions each. Budget/runner/native-probe Python contracts pass 21 tests. These are deterministic contracts, not model competence measurements. Host executor-to-framed-peer tests use a **mock native peer**; Desktop broker probes use a **real native WebView**. Neither establishes the complete real DeepSeek → Host → embedded WebView chain.

### CI failure corrections and remaining gates

Commit `d6f4671` passed Linux/macOS runtime probes, GUI candidate, runtime diagnostics, terminal tooling and mirror gates, but Windows general CI failed before `main` with `0xC0000139`. Import evidence identified `comctl32!TaskDialogIndirect`; the example had no Common Controls v6 activation manifest. The candidate now embeds an **example-only**, `asInvoker` manifest and inspects that executable's manifest, rather than the diagnostic PowerShell process's v5 DLL exports. The speculative build-DLL PATH workaround was removed. Windows success is pending the next actual CI run, not inferred from this diagnosis.

Linux's earlier post-success `ENOTEMPTY` profile cleanup race is covered by bounded cleanup retries, owned process-group teardown and an always-written cleanup receipt. Persistent cleanup failures still fail the gate; they are not suppressed.

Still required: production UI consent/revocation controls and session-end lifecycle integration; exact Host/real-model/native WebView repetitions under audited continuation of the original budget; screenshot/OS-input, cross-frame/file-transfer tasks and a pinned public benchmark. The new backend command is not yet invoked by the production UI, so this checkpoint does **not** claim a usable shipped native Browser Use feature or SOTA.

## 17:30 continuation: native consent UI (2026-10-01)

Resumed by the user-requested one-shot heartbeat. No existing user application/service or job was stopped. This checkpoint uses no paid requests; the original ledger remains closed at the CNY 40.089932 conservative upper bound under the original CNY 200 ceiling.

- The production browser component now includes a compact **Agent access** disclosure, with bilingual session/origin scope, explicit read-only versus interactive selection, grant and revoke controls. Selecting a radio does not grant access or escalate an existing lease. A grant does not start an Agent. Interactive clicks can submit page forms; the UI states that limitation rather than promising a no-submit sandbox.
- `AppFrame` passes its actual current session ID through the existing workspace slot. No session ID comes from a persisted browser item or model argument. A missing session disables consent. Changing the session also disposes/deactivates the native presentation coordinator, even when a reused tab ID is unchanged.
- Desktop adds one **UI-only** status command and a receipt to the existing consent command. Status contains only the native origin and that exact owner's ephemeral permission/remaining duration, not another owner's lease or any credential. Confirmation carries the reviewed origin; a redirect before dispatch is rejected. Only trusted `main` has these commands. No additional model tool, Agent loop, scheduler or Core/Host dependency is introduced.
- The native geometry coordinator returns readiness. The inline disclosure pushes the native WebView rectangle down; it is not an overlay in front of a live native page. A modal/popover/hidden or switching page cannot be granted. Hide, close, cross-origin, expiry and main reload keep the existing native revocation guards.
- No optimistic success or persisted consent: grant/revoke status comes from native receipts; unavailable/malformed status is **unconfirmed**, not falsely granted. A late grant after session/tab/page change is explicitly revoked before the next queued IPC operation. Polling does not supersede an in-flight user grant, and it resumes after a context change. Missing/mismatched grant receipts trigger a revocation attempt and cannot display success. Expiry clears the display without waiting for another model request.
- Ordinary Web explicitly says it cannot authorize a native page; grant is disabled. The isolated visual preview uses the exact checked-in BrowserPane without a native bridge, Host session, model or iframe. It is a UI review, **not** end-to-end browser capability evidence. The regular isolated Host's empty/unconfigured welcome screen currently lacks a usable visible browser toggle; the standalone component preview avoids inserting a fake model turn merely to expose a session header. A welcome-screen entry remains a separate UX follow-up.

### Regression receipts

- V100: 36 Desktop library unit tests and all-target clippy passed; the Rust example was built remotely. Three real Tauri/WebKitGTK native probes passed with cleanup: **9.336 / 9.285 / 9.234 seconds**, binary SHA-256 `8977675529a085d564d31d9096cfb0ede1d875d705bee682be0e5b5133bd2c47`. Includes the intentional seven-second renderer stall. New native assertions cover reviewed-origin mismatch and owner-filtered status. `model_calls=0`, `os_input=false`; this is not a model competence/latency score.
- Real Chromium/WebKit run the shipped React component with **mock Tauri IPC**: bilingual Web limitation, scope/read-only/interactive/revoke, inline geometry, slow grant versus polling, delayed grant after a session switch, hide/resize, modal, stale origin, expiry, missing/malformed/cross-session receipt, missing session and unmount. A WebKit timing test caught a polling lifecycle regression during development; it was fixed rather than skipped.
- Existing browser pane, native visibility/async races, workspace dock/native dock, persistence/history and restoration tests are rerun in both engines. Bundle/source equality and patch idempotence are checked. The new access regression is included in normal CI for both engines.
- Commit `5a649d0` previously passed all required general CI including actual Linux/macOS/Windows native probes. CI for this new UI checkpoint must be checked on its own exact SHA before describing it as passed.

Remaining: full real-model → Host → native consented WebView repetitions, session disposal beyond the UI/native visibility lifecycle, original welcome-screen entry, screenshot/OS-input and cross-frame/file-transfer tests, and pinned public benchmark comparison. No merge, release or local desktop replacement is performed by this continuation.

## User-directed simplification: AI-selected browser operations (2026-10-01)

**Supersedes the manual access disclosure above.** The user rejected the session/origin/radio/grant panel and asked the AI to choose what browser operations a task needs.

- Removed the entire access bar/disclosure, read-only/interactive radios, grant/revoke buttons and permission explanations from the production BrowserPane and checked-in bundle. The component remains a compact toolbar plus page; ordinary Web retains its truthful native-engine limitation, not a simulated grant.
- The existing native presentation coordinator silently binds only the visible tab and its native-verified origin to the **actual selected Host chat**. Anonymous/global workspace tabs have no model owner. On navigation, binding waits for load completion rather than authorizing an outdated URL. Owner/origin are not model arguments. Popovers, global modals, hide/close, session changes and stale/malformed IPC replies deactivate/revoke; returning to a visible chat establishes a fresh exact-owner binding, not shared parent/child access.
- Reused the single `plugin_mcp` path. AI chooses `observe` or typed `perform` from task needs; **normal Host approval and Full Access settings still apply**. Automatic presentation binding does not approve, resume or execute a model action. A dedicated Host App regression asserts that `plugin_mcp` still requires approval. No new model tool or Agent loop was introduced.
- Removed the two-second status polling hook. A visible binding renews before the existing native expiry with one bounded timer; timers stop on hide/disposal. Native renewal of a live identical owner/origin/mode preserves the observation frame. Changed or expired bindings invalidate it. The real native probe renews between observation and fill, verifying that renewal neither consumes the frame nor permits replay.
- Chromium and WebKit pass the simplified component's mock-IPC regressions: absent controls in both languages, Web honesty, automatic owner binding, no polling or action execution from layout work, timer renewal, modal/popover/hide, delayed binding across session/close/overlay boundaries, missing receipt, navigation/load sequencing, redirected origin, anonymous scope and unmount. The existing pane/visibility/dock/persistence/restore regressions pass in both engines. These are UI contracts with a mocked native boundary, not model competence results.
- V100: 39 Host App library tests plus its CLI/integration suite, 37 Desktop library tests and all-target clippy passed; the native example was compiled remotely. Three real Tauri/WebKitGTK native probes passed with cleanup verified: **9.292 / 9.293 / 9.340 seconds**, binary SHA-256 `9b727e848c82e9fc1d30ed2ee6a60d44fb8c491ddebb4b5f397b0bdebc9be458`. Each still includes the intentional seven-second stall; `model_calls=0`, `os_input=false`. A first remote run encountered a stale rsync/build-cache trait artifact; source hashes matched, touching the affected crate roots forced fresh artifacts and the full rerun passed. The initial failure log is retained separately.

The updated 3091 component preview is isolated and uses the production BrowserPane without a native bridge/Host/model. No local desktop application, production Web service or running user job was replaced or restarted. No paid model calls, merge or release occurred. The original paid ledger remains closed at CNY 40.089932. Exact-SHA CI must be checked separately after pushing this revision; earlier CI applies only to the earlier manual-UI commit.

Still not claimed: real DeepSeek → Host → native WebView end-to-end results, session-end lifecycle outside UI visibility, public benchmark/SOTA, native OS-input or screenshot capability on Linux/Windows.

## Genuine native WebView model continuation (2026-10-01 evening)

The user approved continuing the experiment with an **additional CNY 20 ceiling on the original cumulative ledger**, not a new budget. Checkpoint `02443d9` passed general CI [36852681605](https://github.com/123123213weqw/x-harness-rs/actions/runs/36852681605); the changes in this section require their own exact-SHA CI.

### What was tested

A small disposable Tauri example reuses the existing native browser, private bridge, inspection/action modules and production BrowserPane. The trusted test renderer mounts that actual component, including its automatic session binding; a genuine isolated Host exposes only `plugin_mcp`. DeepSeek discovers the native tools and drives the actual WebKitGTK guest. The evaluator serves fixtures and grades their reported state; it does not complete tasks or inject target refs. Neither a substitute Chromium browser nor simulated Tauri IPC is used. This is component/Host/native integration, **not a full packaged-AppFrame navigation test or OS-pointer/screenshot test**.

Natural prompts specify tasks but not tool names, discovery steps, frame ids or action schemas. Model: official `deepseek-flash` alias, low thinking, deliberately capped at 8192 output tokens per request. [Official pricing/model page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) maps this alias to V4.1-Flash; that mapping is not a measured backend build identifier. Three fresh processes/sessions per task, fixed executable hashes, separate disposable Xvfb/DBus/profile for every trial:

| Local task | Passes | Model-loop seconds (three trials) | Model requests (including helpers) |
|---|---:|---|---|
| Issue search, open, marker answer | 3/3 | 68.466 / 60.948 / 77.190 | 17 / 17 / 17 |
| PR draft, exact title/body, never submit | 3/3 | 63.272 / 49.341 / 35.761 | 17 / 13 / 14 |
| Modal, dependent provider/reasoning options, save | 3/3 | 54.817 / 56.983 / 51.698 | 17 / 17 / 17 |
| Eight moving Targets, zero Decoys | 3/3 | 90.976 / 95.758 / 91.338 | 23 / 25 / 25 |

All 12 trials passed, including teardown. The game moves after each click and has semantic labels; this is not a visual-only/realtime game benchmark. 219 admitted model requests, 796.548 summed model-loop seconds. Host-reported usage across these trials: 115455 uncached input, 1000064 cache-read, 25445 output tokens; 3993 reasoning tokens are a subset of output, not additive. The ledger also accounts for background title requests; Host turn usage is not an invoice. Sanitized, machine-readable trial receipts are in `docs/evaluations/2026-10-01-native-webview.json`.

### Findings and corrections

- The natural model can recover from lazy-discovery guesses and malformed action arguments. A real malformed `perform` was incorrectly reported as **unknown effect**, although native validation rejected it before scheduling any JS. The native bridge now returns a failed `not_started` receipt for pre-dispatch/validation/authorization/frame denials. Anything after scheduling remains `unknown` when its callback/navigation/result is uncertain. Host transport interruption still remains unknown. No automatic replay or extra tool is added.
- Remote regressions cover this classification through the actual framed Host transport and native callback probe. The probe sends forbidden `eval` arguments, checks `not_started`, then successfully fills using the same untouched frame; consumed-frame, read-only and after-effect guards remain tested. Actual native probe: 9.235 seconds including the deliberate seven-second stall, zero model calls, cleanup passed.
- The evaluator previously killed the Host while a background title request still awaited its final usage event. Unknown usage remained charged at the full reservation rather than being erased. Teardown now waits for no inflight broker requests and a stable request counter before killing only its owned process groups. A bounded authenticated numeric receipt endpoint does not forward a model request or reveal keys/bodies.
- A shared Cargo output changed to a different executable hash that lacked the candidate CLI option. That zero-paid setup failure is retained, not counted as model performance. The evaluator now freezes its input binaries once per suite and records their hashes. We do not attribute the replacement to a particular task without evidence.
- Disconnected portal FUSE mounts initially prevented profile cleanup. Only mounts under the generated disposable profile are unmounted; arbitrary user paths are rejected. No user's display/profile/apps are touched.

The classifier-fix candidate additionally completed two genuine natural-model Issue trials (54.453 / 65.422 seconds). The third timed out **before paid prompt admission** while the test tunnel was unstable; the exact failing transport stage was not recorded, so a provider/browser failure is not asserted. New receipts now record closed lifecycle phase labels for diagnosis. The second completed the page task but its per-trial accounting receipt timed out; the original local ledger reconciles all requests. This is **not a verified 3/3 fix-candidate series**. Real GitHub native loading also timed out before model admission; V100's direct connection probe timed out. No signed-in GitHub state, public submission, or model score is invented for that blocked case.

### Accounting, regression and remaining work

The original ledger is closed again, pending reservations empty, local capability removed and remote benchmark capability removal acknowledged. Requests: 527 → 895. Additional conservative bound **CNY 14.280580**, cumulative **CNY 54.370512**, below the incremental CNY 20 and original CNY 200 ceilings. Five missing-usage requests retain full reservations; known usage at conservative peak cache-miss rates accounts for CNY 3.952900 of the increment. These are conservative bounds, **not exact billed fees**; cache/off-peak discounts and unknown usage prevent an invoice claim. Explicit continuation preserves old counters, rows, policy and global cap; normal closed-ledger reopening still fails, and crash resumption cannot silently extend the incremental cap/deadline.

V100: 40 Host App library tests, 38 Desktop library tests and Desktop all-target clippy passed. Python benchmark contracts: 29 passed; existing broker transport contracts: 6 passed. Three zero-paid genuine BrowserPane→native binding probes passed before paid runs; the fixed candidate's zero-paid binding probe also passed. CI now includes the actual component→Host→native binding probe on Linux, in addition to existing cross-platform native probes and mocked Chromium/WebKit UI contracts. Exact-SHA CI for this continuation remains a separate gate.

Remaining: repeat the classifier-fixed series after a stable test tunnel, real GitHub search/view and realistic PR draft UI without submission, keyboard/default-form behavior, public benchmark comparison, full packaged desktop navigation and screenshot/native OS input. Lazy discovery and observe/action round trips dominate the simple-fixture latency; that is a measured optimization target, not a reason to bypass one-shot/unknown-effect guards or add a second Agent loop. No SOTA claim, merge, release, local mouse/keyboard use, app replacement or production deployment is made. Goal completion is not asserted.
