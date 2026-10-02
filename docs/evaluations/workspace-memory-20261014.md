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

## Limits

No real-model memory selection/curation quality claim. Auto is optional model
policy, not a second autonomous writer or a guarantee of per-turn updates. No
new cross-process unfinished-turn snapshot protocol, account/cloud memory sync,
secret scanning/encryption, or native macOS GUI acceptance. Clear does not erase
historical request/tool records. File publication and control receipts remain
separate stores, with identical-content retry recovery and stale-write rejection.
GitHub CI must be reviewed separately; this report does not claim it has passed.
