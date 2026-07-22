# Owned views: current-master source acceptance

Baseline: `a613970c78a36a024de56100078323df25b96004`. Frozen reference: `ui/reference/master-a613970/` (test-only; never a production input).

The companion [machine receipt](views-source-master-a613970.json) retains the source path/SHA list, 53 current canonical modules' byte counts/full SHA-256/revs, individual run/result/log hashes, and exact pixel pairs. Owned-source snapshot: `75ff1ae9ac9f25bb72d74a60d776ebf35218c1344c306ab25e0cf8569c52344c`.

## Results

- Strict production-closure Node tests: views **74/74**, product **22/22**, workspace **11/11**, Renderer **9/9**, Trajectory **14/14**, Cordis UI **7/7** PASS. Actual Core Settings/Gateway receiver tracking, caller fiber cleanup, wire/schema validation PASS.
- Browser A/B: **64/64 runs** across 16 scripts × Chromium/WebKit × strict-source/frozen. Tests use the actual platform React/JSX/primitives singleton, not UMD/proxy replacements.
- **18 pixel pairs byte-identical** between source and frozen. Full Layout `#root` dock/native frame screenshots additionally match rebuilt canonical in both engines: **4/4 canonical PASS**.
- Canonical terminal test PASS, including source freshness/graph/HTML boot and stable shortcut markers in both languages/closing phase.
- Layout window-controller original cases PASS in source/frozen; workspace reuse/fresh/neighbor/persistence bounds **3/3 per implementation** PASS. All former 73 view cases remain, plus independently verified `workspace.item` root-list declaration; open/close events are checked.

Run from the repository with browser dependencies supplied through `UI_TEST_DEPS`:

```sh
UI_TEST_BROWSER=chromium UI_TEST_IMPL=source node scripts/test-cordis-source-browser.mjs
# Repeat each script from the JSON matrix with webkit and legacy.
UI_TEST_IMPL=source node scripts/test-layout-workspace-source.mjs
UI_TEST_IMPL=legacy node scripts/test-layout-workspace-source.mjs
node scripts/test-owned-cordis-services.mjs
```

## Supplemental final loader migration

`test-workspace-directory-browser.mjs` and `test-request-audit-browser.mjs`: **8/8 PASS** across source/frozen × Chromium/WebKit; all original drive/refresh, virtual root, path memory/fallback, blocked storage/old Host, create/adopt/retry, stale/cancel/IME, narrow layout, audit retry/late/session/Diff/omission/unmount assertions remain. Both use `installOwnedViewPlatform`, actual source/frozen modules and real domain closure; fake `defineStore`/actions were removed, audit styles have actual lifecycle and RPC envelopes are correctly correlated. **4 additional pixel pairs** exactly match. The original 64-run/18-pair matrix remains intact; this is supplemental, not a relabel of old coverage. No production files changed.

## Latest-master behavior retained

Browser native leases/occlusion and keyboard menu focus (#192); compact completed-thinking preference (#191); Archive Settings Host metadata, original-ID restoration, permanent deletion confirmation/errors and parent-child retries; current-master PluginHub without WIP mirror/source/offline catalog; Profile metrics-pending; CSS selectors/classmaps/lifecycle; full Layout workspace pane, per-session/global spaces, saved-state bounds, live session addressing, native restore/serialized resize ownership, dock/drawer/scrim and shell-overlay layering.

Cordis Define cards now use the same frozen keys (`cordis-expanded:`/`cordis-source:` plus callId). Actual transcript heavy-subtree eviction/remount twice preserves independent alpha/beta expansion and source tabs. Terminal stable trigger/open markers likewise match the frozen artifact without weakening assertions.

## Historical failure, resolution and limits

**Full canonical Transcript is now 4/4 PASS** (source/frozen × Chromium/WebKit). The earlier line243 “append does not pull history reader to bottom” failures remain recorded under `historicalFailure` with their original hashes. The Conversation owner replaced invalid `data:{}`/missing assistant-kind fixture data with identical genuine user/assistant-step/compaction DTOs, explicitly observes reader wheel/scroll and the toBottom affordance, and retained the original scrolltop/prepend assertions. No production Scroll/Reader changed.

The browser matrix controls Host/Tauri IPC facts and stops platform boot before Host initialization. It proves real component/SDK/DOM behavior, not OS native-webview compositing or Rust Host end-to-end execution. The navigation-specific Workspace fixture controls its directory seat, but the supplemental full Workspace/Directory browser now executes both actual modules and the real runtime store engine. Trajectory ledger snapshots remain controlled observables; actual store engines have separate tests. Legal saved values/foreign properties are preserved; malformed-shape rejection by typed decoders is explicitly not exact permissive frozen malformed-input behavior.

Whole application startup, canonical artifact closure/HTML graph, clean reproduction, remote Rust Host tests and CI remain separate Root/peer acceptance. This receipt does **not** declare all UI migration or CI complete. Canonical hashes describe the observed rebuild and must be refreshed after any subsequent source changes/rebuild.

## Final confirmed Computer repair and canonical loader check

The final confirmed Computer omission was repaired only by importing the existing real Tool transcript-state adapter and using the frozen `computer:` + callId key. `test-cordis-source-browser.mjs` reuses the actual TranscriptWindowRow: two independent Computer call IDs retain expansion across two genuine heavy-subtree evictions/remounts, remain isolated from the Cordis cards with the same IDs, and match frozen behavior in **4/4 source/frozen × two-engine runs**. Combined row pixels also match exactly. No fake bridge/Map and no other business behavior changed; strict Product **22/22 PASS**.

Both late loader scripts additionally pass rebuilt **canonical 4/4** in the two engines, with pixels equal to source/frozen. Machine source pins and all 53 canonical module hashes were refreshed after the unified Computer rebuild. Original 64-run/18-pair results and original Transcript failures remain historical evidence alongside the current passing supplements.
