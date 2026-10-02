# Workspace memory acceptance — 2026-10-14

Scope: local workspace notes on top of #291/#292, no new model tool, no paid
provider calls, no desktop deployment or native mouse/keyboard automation.

## Evidence

- V100 `WZU_Server`, source seeded from the independently tested #292 checkout,
  then rsynced with the current overlay (including uncommitted source). Dedicated
  target cache; no local Rust compilation.
- `cargo test --locked -p xharness-host -p xharness-host-app -p
  xharness-coding-tools --no-fail-fast`: **567 pass / 16 existing ignored**.
- `cargo test --locked -p xharness-server`: **13 pass**.
- Latest memory-focused unit rerun: **11 pass**, ten overlapping the full runs
  and one additional real HTTP integration case: **581 distinct passes** total.
- Strict `cargo clippy --locked` on all targets of the four affected packages:
  passed. Local `cargo fmt --check` (does not compile): passed.
- Chromium + WebKit, canonical committed UI + freshly compiled source:
  **4/4 variants pass**, no page errors. Browser RPC is scripted, not a model
  eval. Test is enrolled in existing CI browser shards for both engines/forms.
- UI strict build/typecheck/rebuild byte parity, 50 source/type-policy checks,
  14 CI-shard contracts, 123 foundation checks, six question-source tests,
  Profile regression and architecture checker + five checker tests passed.
- Full generated-UI frozen/source differential: three implementations/layout
  runs per Chromium/WebKit; exact text/control and settled conversation pixels
  pass. Only the explicit workspace-memory plugin addition changes the load set.

Raw complete remote output, source archives, SHA-256 receipts and local UI logs
are retained in the task workspace under
`dist/regression/workspace-memory-20261014/` (not shipped as repository assets).

## Behaviors verified

Persistence/reopen; manual default and explicit auto; off revokes old executor
calls; canonical cwd sharing and other-workspace isolation; no new tool names;
read-before-edit observations and stale CAS; invalid URI/settings escape denial;
64 KiB writes; bounded UTF-8/line index; corrupt/oversized note repair; invalid
settings repair; symlink/FIFO rejection; timeout retaining its owned I/O slot
without holding Host state. Actual scripted Host/Loop/JSONL tests pin notes within
one Loop and refresh queued turns. Native factory wiring exercises ordinary file
tools. Real HTTP covers workspace discovery and UI memory routes, and confirms
that UI bodies are not duplicated into RPC debug logs.

UI covers late workspace replies, draft retention across switches and conflicts,
explicit reload discard, auto/clear confirmations, off, unavailable deployment,
both languages, unmount cleanup and strict source/artifact parity.

## Corrections during acceptance

The first full run found one **test fixture assumption**: the existing native
image-sniff adapter treats an absent ordinary file as an error. The unaffected
normal-path regression now reads an existing fixture instead; the native memory
URI absent-read/CAS cases were already passing. The final full run is green.

The initial UI mock did not catch a wrong workspace-discovery spelling. It was
corrected to the fixed `workspace.list` endpoint and a real HTTP regression was
added. Memory request/response body omission was also added at the existing
server debug boundary. Large rsync streams stalled; bounded small overlays were
used successfully. No Rust work was moved to the local Mac.

Initial GitHub CI also caught the frozen boot allowlist still expecting 57
plugins. It now expects exactly 58 and names the single new memory-module path;
the immutable legacy list and pixel/text/control assertions were not relaxed.
The complete differential passes locally on both engines; CI was retriggered.

## Limits

No real-model memory selection/curation quality claim. Auto is optional model
policy, not a second autonomous writer or a guarantee of per-turn updates. No
new cross-process unfinished-turn snapshot protocol, account/cloud memory sync,
secret scanning/encryption, or native macOS GUI acceptance. Clear does not erase
historical request/tool records. File publication and control receipts remain
separate stores, with identical-content retry recovery and stale-write rejection.
GitHub CI must be reviewed separately; this report does not claim it has passed.

## Global Settings follow-up

The same PR now also provides profile-global notes. Settings defaults to Global
memory; no workspace/session is required for UI editing. Workspace notes keep
their original storage paths and a separate tab, mode, draft and CAS observation.
The existing file tools accept exactly one additional URI, not an additional
model tool. Global facts are shared only within one local app profile, not an
account synchronization service. Project facts are not automatically promoted.

- V100 full four-package run (`xharness-host`, `xharness-host-app`,
  `xharness-coding-tools`, `xharness-server`): **584 pass / 16 existing ignored**;
  strict all-targets Clippy passed. This run includes the earlier HTTP case;
  do not add the previous 581 count to it.
- New coverage: global CRUD without any workspace, restart persistence, scope
  validation and receipt replay/conflicts; cross-workspace sharing with isolated
  project facts; independent modes and live revocation; alternating native file
  mounts retaining both observation ledgers and rejecting stale writes. Actual
  scripted Host/Loop snapshots now check global notes as well. Real HTTP checks
  that neither global nor workspace note bodies leak into RPC debug records.
- Chromium/WebKit × source/committed UI: **4/4 pass**, scripted RPC. Global
  editing works even when workspace discovery fails; scoped drafts, late replies,
  conflict handling and confirmed clear preserve the other scope. Both languages,
  strict build/typecheck/parity and 71 contract checks pass. Full frozen/generated
  UI differential passes three runs on each engine.
- Previous GitHub failures were inspected, not ignored: Windows Clippy reported
  a Unix-only `mut`; the builder is now mutable only inside the Unix block. A
  second migration allowlist also needed the exact Memory module ABI; a negative
  mutation test was added. The downstream layout gate was failing on that same
  UI-contract failure, not an independent layout issue. No frozen reference,
  strict lint, contract or pixel guard was weakened.

Complete remote/local receipts for this follow-up are retained at
`dist/regression/global-memory-20261014/`. As above, there were no paid model
calls, local Rust compilation, native macOS GUI control, merge, release or desktop
replacement. The latest GitHub CI run is tracked separately from V100 results.
