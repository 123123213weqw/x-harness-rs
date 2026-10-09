# Output-budget migration acceptance — 2026-10-08

Source branch: `fix/output-budget-migration-20261008`, based on `d9c9db8d`.
No installed application, published package, remote main branch or user history
was changed by this acceptance run.

## Passed

Rust compilation/testing ran only on WZU_Server (V100), after syncing current
source to `~/codex-build/x-harness-rs/output-budget-migration-20261008/` with
Git, target, dependency directories, sensitive environment files and temporary
UI build stages excluded. Remote tests used the existing shared Cargo cache.

| Suite | Passed | Existing ignored |
| --- | ---: | ---: |
| `cargo test -p xharness-host --lib` | 243 | 6 |
| `cargo test -p xharness-host-app --lib` | 78 | 1 |
| `cargo test -p xharness-host-app --test model_settings` | 14 | 0 |
| `cargo test -p xharness-host-app --bin xharness-host` | 7 | 0 |
| Total | **342** | **7** |

New checks cover backup preservation/permissions, interrupted backup attempts,
failed writes without a false completion marker, CAS retries preserving a
concurrent edit, fresh-install marking, restart idempotence, later manual edits,
matching deployment output-default inheritance, route/alias fences and adaptive
minimum versus maximum validation.

The native integration case loads a legacy invalid max/min pair through the
real control store, migrates it, restores via BasicHost + NativeModelSettings,
verifies deployment target 65536 and automatic minimum 1024, changes them through
settings RPC to 32000/8192, restarts and verifies the manual values survive.
The existing real HTTP-adapter fixture also passed; its provider is a local
controlled server, not the production DeepSeek API.

Frontend: strict TypeScript check; 11 settings source tests; Chromium and WebKit
interaction suites; reproducible owned build/check (55 modules, 190 assets);
protocol and plugin-API generation checks. New browser coverage rejects hidden
minimum 8192 versus maximum 4096 before RPC, then accepts `32K` as 32000 and
preserves hidden/unrelated model metadata when saving.

## Failures found and resolved during acceptance

The initial new migration fixtures attempted to seed settings revision 8 as the
first event. ControlStore correctly rejected this invalid history (first settings
revision must be 1). Fixtures now use valid contiguous revisions, including the
concurrent/manual-edit cases. The full rerun completed with exit code 0. The regular suites skipped seven existing tests. The directly relevant
`diagnostic_max_tokens_notice_survives_next_turn_start` was then explicitly run
on V100 with `--ignored --nocapture` and passed (one additional distinct test).
Its controlled cases show the output-limited turn ending and the queued followup
starting, with another user "continue" accepted into the queue. This does not
prove a stale UI notice is cleared or reproduce the reported Windows user issue.
The other six ignored tests were not run and do not count as passes.

Full initial and final Rust output was returned locally under
`/tmp/xharness-output-migration-evidence/`, together with the complete frontend
interaction output. SSH relay instability interrupted one transfer; source sync
was retried, and detached remote execution preserved the final test log.

## Not verified / not claimed

* Windows executable installation and real-machine upgrade were not run.
* The reported old Windows user's precise failure is not reproduced; no exact
  version/model/error log was supplied during this implementation.
* No real DeepSeek quota was spent in this run; provider hard output limits are
  not inferred. Missing declared limits still fall back to 4096.
* Explicit deployment-file/env/CLI output settings are not rewritten.
* No PR, merge, release or local application replacement occurred.
