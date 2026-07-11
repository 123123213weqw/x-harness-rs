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
- Remote desktop unit tests passed (31 library tests; the example additionally repeats 7 existing module tests), and `clippy --all-targets -- -D warnings` passed. The native probe and dual-engine contract are now CI gates; this checkpoint still requires that CI to finish.

This is **only the native observation seam**, not a completed model-facing Browser Use implementation. No new model tool is registered and the production UI does not invoke it yet. The next integration must add scoped tab/session delegation and action identity/side-effect rules, reuse the existing executor/cancellation path, and then test actual Host → model → native browser actions. macOS AX/vision, real authenticated form interactions and public benchmark comparison remain unverified.
