# Multimodal capability acceptance — 2026-10-18

## Scope and result

Text/image capability wiring is implemented and automated checks passed.
The existing Loop, image encoder, attachment persistence, sandbox and approval
policies are reused, not replaced. This is not a release/deployment acceptance.

Base: `97296a19135c1b765b2cc3acaf83a858b4bce86c`.
Rebased after upstream PR #348; only generated asset indices conflicted. They
were regenerated from the merged source. The complete Rust test/Clippy batch,
UI build/type checks, model/settings browsers, and upstream native-browser
visibility regressions were rerun successfully after the rebase.
Initial Reasonmap executable-source pin: `160ff392ae74af14205ba1dd0c7d0538d4777e97`.
Reasonmap review: https://github.com/123123213weqw/reasonmap/pull/1

## Validation

| Check | Result |
| --- | --- |
| WZU_Server XHarness Rust tests | 759 passed, 0 failed; 9 existing opt-in cases ignored |
| WZU_Server Clippy: host-app, host, api, all targets, warnings denied | Passed |
| WZU_Server Reasonmap | 10 catalog tests + 1 doctest; Clippy passed |
| Reasonmap Python acceptance-runner regression | 6 passed |
| Settings/model-selector/capability-refresh Node tests | 30 passed |
| Production image capability wire decoders | Supported/unsupported/unknown/provenance/legacy passed |
| Chromium + WebKit settings and model-selector scenarios | Both engines passed; Auto/Enabled/Disabled, read-only, persistence drafts, complete catalog efforts and provider-default choice |
| Production UI assembly/rebuild | 61 modules, 190 assets; pinned repository inputs |
| TypeScript strict type checking and generated terminal protocol | Passed |
| Architecture/freeze checker | Passed; content-bound compatible-addition record |
| Architecture checker regressions | 30 passed |
| cargo fmt / git diff whitespace | Passed |

Rust commands (after syncing current source, including uncommitted changes):

```sh
cargo clippy --locked -p xharness-host-app -p xharness-host -p xharness-api --all-targets -- -D warnings
cargo test --locked -p xharness-host-app --lib
cargo test --locked -p xharness-host-app --test reasoning_compat_wire --test model_settings --test process_model_settings
cargo test --locked -p xharness-host -p xharness-provider-openai -p xharness-attachments -p xharness-context -p xharness-api
```

All Rust compilation ran on WZU_Server, with the existing Cargo target cache.
No Rust compilation ran on the Mac. Remote/local SHA-256 comparison
matched all 36 changed executable/configuration artifacts (including the deleted
legacy fixture), with no mismatches. Source snapshots exclude .git, target,
node_modules, environment files and keys. A server-to-GitHub TLS failure was
handled by transferring a verified public Git bundle of the same pinned commit
into the remote Cargo Git cache, then building offline. TLS checks were not disabled.

Regression coverage includes independent reasoning/image overrides, upstream
aliases, exact official routes, unknown/proxy rejection, active-registry authority
over stale settings, nullable Auto reset, wire metadata preservation, both image
wire formats, context image deferral, session-scoped upload/fork/restart behavior,
and unchanged opaque reasoning replay. Fixtures now declare actual vision support
rather than relying on contradictory raw settings or undeclared capabilities.

## Evidence boundaries

No paid/live vision-provider call was made. Documentation is not live-acceptance
proof. No model/projector was installed and no current model endpoint was changed.
Audio/video/PDF native inputs and subagent image-upload continuations remain outside
scope. No PR was automatically merged, no desktop release was published, and
previously paused automatic candidate builds remain untouched.

Full logs are retained locally outside the public source tree. SHA-256 digests:

- `xharness-final-incremental.log`: `95c51a4e198c6a55d363b7827d546240e18f64b9e4018b2b5c3d757fe0b64b34`
- `reasonmap-final.log`: `86c8581d507e6dcc65aabeebe99b647e8489b927869537907b08baf233bbcd1c`
- `ui-all-unit.log`: `cc919aa57b35036e134ae3da9663360dc0b4fc8082aff2f1a3b733f0351c6575`
- `ui-model-browser-chromium.log`: `1d51692814551604dae3417ab3f3d7d20fb1c095d1a08c894896e6ba020b4298`
- `ui-model-browser-webkit.log`: `ac4a39c75bd527f94b6ff91167df0baf33f485140f703e34eaf7c213a3a0037d`
- `ui-browser-chromium.log`: `c3c67a3e89eb3bb777f374ab106487f6948a8e65da1f46104830395c0ce77be2`
- `ui-browser-webkit.log`: `9e23bf53c15ddedf9f4ad4e323085830383945aa6c2912e0a832d00a57ff4d7f`
- `ui-build.log`: `2514aaff95b8896469a9d829e2491fa00c6053fdb14d5abd6f1bfc46e114e40a`

- `remote-code-hashes.log`: `5984c7f1030fe1acc4f60c59c526cb2a5a5c2457fb22386c54c9d6af724144f0`

## Post-rebase verification

The integrated snapshot again passed 759 Rust tests (9 existing opt-in ignores)
and Clippy. Both Chromium and WebKit passed the settings/model-selector suites
plus automatic browser binding and native-browser/context-popover regressions.
Remote/local source hashes were checked again on the integrated snapshot.

- `xharness-rebased.log`: `78c5cd4e7187446e57c9d2d3d48b512a60c202f54aaa6ee65570c9b88cb49884`
- `ui-rebased-unit.log`: `f38525c352e6f8b4f52f74f39d0687b0ca775de57663baf202ee4d0f76121120`
- `remote-rebased-code-hashes.log`: `3ab5e6de3bb8fa9ae9e79f8bb1f1d49e1297d9f27f254473c5d531acd2bcca2c`
- `rebased-test-browser-access-chromium.log`: `35599d81e68c40a3752342ee4ffc6218785968a49c309ff40fac7d3a699ddba3`
- `rebased-test-browser-access-webkit.log`: `ff3b235ca5d3c2745b9563bd67b3fb9d6bfff3608e6ab0ef1b8c043a662f322f`
- `rebased-test-browser-native-bridge-chromium.log`: `5f7a4bb721d0cc0a1b71bd7ef1ba4eddad58ced6dea8faa135d9a42ba51bee2a`
- `rebased-test-browser-native-bridge-webkit.log`: `9e123e80ea70a901d0194d6fc671b92ea8aa0b16eb573710658f81a56dd3f990`

## Current-model expansion

Reasonmap `2026-10-18.2` is pinned at executable source
`44159024c3c7a16d175d2cb3a5d665c39fe47d63`
([catalog PR #2](https://github.com/123123213weqw/reasonmap/pull/2)).
Thirteen current-line model IDs have documented image input; nine work through
XHarness's existing Chat/Responses adapters. Four Claude IDs remain native
Messages catalog facts, not runnable XHarness routes. Legacy GPT-5.4 and the
retired DeepSeek vision-exp alias remain compatibility-only, not recommended
targets. Active user model settings and server deployments are unchanged.

After source sync, WZU_Server passed 760 selected XHarness Rust tests (9 existing
opt-in cases ignored) and the same all-target, warnings-denied Clippy batch. The
wire fixture now sends real PNG data through the real adapter to a local capture
server: 75 image requests across 14 current-model/protocol pairs, covering each
effort and provider/catalog default without changing the model ID. A missing
Astra default remains absent on the wire; OpenAI off is not confused with
DeepSeek's different off patch. These are fake-server contract tests, not live
provider acceptance. An initial expanded fixture still assumed DeepSeek-style
off encoding for every vendor; that test-only assertion was replaced with checks
against each catalog patch, and the complete suite was rerun successfully.

Reasonmap passed 12 catalog tests, one doctest and Clippy; six offline Python
regressions passed. Chromium and WebKit passed the full catalog effort selector
matrix; strict TypeScript and the architecture gate passed. Remote SHA-256
comparison matched all five changed executable/config artifacts. No Rust
compilation or paid model call ran on the Mac. Automatic candidate builds remain
paused; no release, merge or deployment was performed by this update.

Full logs remain outside the public tree; SHA-256:

- `reasonmap-current-models.log`: `2892c89ed51a41b07a832a4afa3bc8641420f5e10aba91b105a135112834e0af`
- `xharness-current-models.log`: `30632738482f818095cd545d07aab8b7f1190c4edadc7f964d2bec6405c764b1`
- `current-models-browser-chromium.log`: `1d51692814551604dae3417ab3f3d7d20fb1c095d1a08c894896e6ba020b4298`
- `current-models-browser-webkit.log`: `ac4a39c75bd527f94b6ff91167df0baf33f485140f703e34eaf7c213a3a0037d`
- `current-models-typecheck.log`: `d9c05db99b601ebce54191a08919805d02b97e6eb2ed5fd9270efd48037f851d`
- `current-models-source-hashes.log`: `89776785f091a33c634e35502fa1c66de033b5b20dd0a9b3f8484c32ace35174`
