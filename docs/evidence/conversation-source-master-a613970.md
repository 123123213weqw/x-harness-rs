# Conversation domain source acceptance — master a613970

Immutable baseline: `a613970c78a36a024de56100078323df25b96004`, `ui/reference/master-a613970/`.
The frozen artifacts were checked against `REFERENCE.json`; no new generated output is used as the old baseline.

The [machine receipt](conversation-source-master-a613970.json) records exact source/test paths and SHA-256, 14 canonical factory bytes/revs, immutable artifact hashes, individual sanitized log hashes, and initial failures with their repairs.
Owned-source tree SHA-256: `9cadbad6f6f28395db8f6d3d45d2dbf191afc35a8553fac3c75175a6e0dfd5e8`.
Canonical graph SHA-256: `1701546a23a71c98da7e13dd15c36d07c6b28d861622c5947e2203fc019f56b2`; manifest SHA-256: `8627589b5c61e4b252341ceebd94de6009009a283fa0d8b295bebcf8472ab908`.
Final current-disk recheck: graph rev `98d9274175676f9b`, asset manifest SHA-256 `578db3c05802a89c3acd167c91e21d5533071a1ab8e5a3028f9bb245e0a8ea27`; all 14 scope artifact hashes and 383 owned source-file hashes still match.

## Scope and results

Owned production modules: Conversation, ClientConnection, UserQuestions, SettingsModels, ModelSelection, Context, PermissionPresets, AgentPreset, Subagent, Tool, Commands, InputTrigger, Reference, TypertRegistry.

- **14/14** strict production factories + owned hard-policy + compiled-byte/source freshness PASS.
- **82/82 Node cases**, zero failed/skipped: seven original/source suites (64), actual Core services (10), connection boundaries (6), real Session rollback (2).
- **28/28 browser A/B runs**: seven suites × Chromium/WebKit × source/immutable frozen. Additional canonical Context/Terminal layout tests **4/4**, including 19 Context cases per engine.
- Canonical MessageEdit (**94 lifecycle assertions + 3 contracts + 4 foundation runtime differentials**), Compaction UI, Progress, Projection (**705 checks**), Wire (**33 compatibility cases plus original indexes 67/70**), NetworkWait, AssistantProjection, RetryTurnProjection and UILifecycleRecovery all PASS. These assertion totals are not added to the 82-case total.
- Canonical Question and Goal each **4/4**, using actual platform and actual scoped/public production components, not copied private implementations. Goal production was not changed during this final loader acceptance.

## Retained domain behavior and honest boundaries

Latest compact progress retains eight stages, nullish metrics/counts, manual/automatic lifecycle, projected/history-only facts and terminal late-progress stability. Network retry keeps producer correlation, started-only partial history, cancellation, ∞/normal/30s feedback and reconnect ordering. Live/reload/page cuts, foreign history, local history reuse and atomic malformed-known-compaction rollback are checked through real Session/assembler tests.

Transcript retains full model data while windowing DOM, measured anchors/live follow, temporary selection/input protection and independent row state across two evictions. Tool/Cordis callId state, reasoning/compaction disclosures, native details, draft state, diffs and process-mode/manual choices survive remount. The 350-row measurements are synthetic DOM/JS heap evidence, **not** native process footprint.

Conversation/composer/queue/approval/permission, durable attachments, source-authorized edit/fork/IDB recovery, ancestry, execution-limit checkpoint, context accuracy, model selection and settings conflict/credential generations remain covered. SettingsModels includes the frozen discovered `imageInput` tri-state/read-only checkbox behavior. Question covers deferred draft/no implicit answer, replay/isolation/folds, IME/custom/multiselect, retry/one-shot/skip/plan decisions. Goal covers one card, complete/confirm/failure, stale/pending actions, **paused and blocked resume**, budget and narrow layout.

Actual Cordis SDK tests prove caller tracking, namespace injection and cleanup. Commands registration does not acquire an unrelated `remote.commands` namespace. Root generic RPCs are routed before session-only decoding and preserve explicit unsupported-endpoint errors. Typert erased lookup/invocation results remain honest `unknown`, without introducing a mandatory new codec ABI.

Fixture fork summaries and Host frames retain `origin: 'fork'`; a fixture-only carrier decoder does not weaken the frozen production HTTP schema. Archive metadata missing on old payloads stays missing, not `[]`; native-provided title/null/zero timestamp fields survive decoding. The direct unarchive/delete helpers are honest **source-only protocol extensions**: frozen JS has no direct helper, so no absent-helper A/B parity is claimed.

## Initial failures retained, not rewritten as passes

The JSON failure history preserves the initial SettingsModels image-capability omission; fixture fork-origin/schema mistake and its explicitly revoked preliminary deletion; archive missing-field fabrication; root RPC agentId misdecode; eager Commands namespace guard; malformed known compaction rollback risk; Cordis eviction state bug; malformed Chat toy DTO/reader geometry; UMD counter reliance on permanent clicked-button pinning; old fake React projection loader; missing attachment byte metadata; compaction setter fixture assumptions; obsolete Question/Goal platform loader; and old raw-CSS unit paths.

Initial transcript/CSS failure logs and the geometry diagnostic are stored alongside passing reruns. Where an initial temporary log was overwritten, the receipt explicitly cites the observed task/tool failure and does **not** fabricate an available initial log. Repairs preserved existing assertions: source-only guards were not disabled, invalid inputs were not silently ignored, and new output was not patched to satisfy old golden anchors.

## Reproduce

Supply dependencies through `UI_TEST_DEPS` (Playwright + React dependencies). No machine-specific path is required in these receipts.

```sh
node scripts/test-conversation-service-boundaries.mjs
node scripts/test-conversation-connection-boundaries.mjs
node scripts/test-conversation-history-rollback.mjs
node scripts/test-conversation-message-edit.mjs
node scripts/test-compaction-ui.mjs
for implementation in source legacy; do
  for browser in chromium webkit; do
    UI_TEST_IMPL=$implementation UI_TEST_BROWSER=$browser node scripts/test-transcript-windowing.mjs
    UI_TEST_IMPL=$implementation UI_TEST_BROWSER=$browser node scripts/test-question-continuation-browser.mjs
    UI_TEST_IMPL=$implementation UI_TEST_BROWSER=$browser node scripts/test-goal-runtime-browser.mjs
  done
done
# Remaining source/Node/browser/canonical entries are listed in the JSON matrix.
```

Source acceptance compiles the real graph or verifies exact canonical factory freshness. The test-only AST seam appends exports inside real unit closures without rewriting scope imports/production ABI. Patch-repeatability is limited to immutable golden artifacts. The first three browser suites use real React UMD with narrow controlled platform/service fixtures; Tool/Transcript/Question/Goal canonical A/B use actual platform singleton. They are not all equivalent to whole native application boot.

## Freeze and limits

**Production source is frozen.** Final repairs changed test loaders/fixtures/docs only, not compiled production bits. No local Rust compilation, commit/push/merge/release or native desktop installation/update was performed by this acceptance. This receipt does **not** assert CI green, all possible malformed-input permissiveness, every visual state pixel-identical, or native Host/WebView end-to-end execution.

Whole-graph boot/pixel comparisons, clean reproduction, remote Rust and CI are separate parent/peer evidence. Current-master Experience owns the completed-thinking compact CSS preference; its independent browser/pixel evidence is in the [views receipt](views-source-master-a613970.md). Hashes are the observed canonical build and require refresh after any production change/rebuild.
