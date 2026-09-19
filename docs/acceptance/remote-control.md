# Remote control acceptance

The shared remote gateway, Telegram protocol composition and desktop scope/recovery UI are implemented. Mobile relay/QR, Weixin iLink, Feishu and separate Lark, persistent activation and real account/model/native OS acceptance remain unfinished. A fixture pass is not proof that a live channel is usable.

## Verification status

The 2026-10-12 CI repair checkpoint passed 789 tests with zero failures and 11 ignored across API, remote, Telegram, Host, Host app, projection, server and Schedule on WZU_Server (56 test harnesses), with all-target Clippy warnings denied. Nine emitted-client contracts, architecture/CI source-policy checks and static UI assembly verification passed. The exact UI migration/type/build contract gate passed all 69 cases, and the complete Chromium/WebKit boot comparison retained exact conversation pixel parity against the untouched frozen reference. Remote Settings also passed both browser fixtures.

The fix resolves validated journal-directory ancestors before SQLite NOFOLLOW without permitting a symlinked storage root or journal/lock leaf. Three new regression tests preserve those rejections, exclusive ownership, private modes and WAL/FULL behavior. Two Windows Host fixtures now use the native registered workspace path; production authorization comparison is unchanged. The exact remote Settings ABI and loader path are admitted by UI gates without changing the frozen reference or pixel tolerances. Current-head automated CI results are tracked on [PR 266](https://github.com/123123213weqw/x-harness-rs/pull/266).

The prior master integration checkpoint passed 786 tests, and the first convergence checkpoint passed 763; both had zero failures and the same 11 ignored. Ignored subprocess helpers are invoked by their parent cases; live CDN/offline diagnostic cases remain explicitly ignored.

This first convergence pass shares only identical scope setup across eight test harnesses: 59 named test bodies remain byte-identical, with 100 net lines of setup removed including the shared helper. All 63 names previously exported by ten wildcard module exports are now explicit and preserved. Fault backends and operation-specific assertions remain separate. Production transaction, authorization, delivery and recovery implementations are unchanged; no crate or dependency was added.

All 38 historical acceptance files were copied and SHA-256 verified before removal from the PR directory; reports, source snapshots and raw logs are preserved outside the repository. This summary is the single maintained acceptance entry. The plan was reduced from 217 to 153 lines without dropping the remaining implementation or acceptance scope.

All 1321 selected CI-repair file hashes match the tested remote files. Source-manifest digest (compact sorted-key JSON files map): `907871cff0f806dcfd2c033313c3004f06c0ee8e283df6d92c37bb8ac2111c93`. This report itself is separately hashed, not included in that digest.

## Coverage and limits

| Boundary | Verified implementation behavior | Remaining real acceptance |
| --- | --- | --- |
| Host and scoped gateway | Workspace/session grants, exact revisions and bindings, durable admission/dedup, FIFO and revoke, narrow API capabilities | Native system/keychain behavior on all supported OSes |
| Commands and output | Scoped catalogue/select/create, history/live/media, once-only approval/question tickets, saved automation reads/controls and original native receipt recovery | Live accounts and real models |
| Delivery and recovery | SQLite/outbox atomicity, durable receive cursors, uncertain sends without replay, exact desktop audits and sealed interactions, fixture process exits and reopen | Real network/account restart trials |
| Telegram | Official-shaped loopback HTTP, parser/formatting, media, callbacks, polling and durable result/output composition | Actual bot round trips, including restart, repeated three times |
| Desktop Settings | Bilingual monochrome grants/capabilities/status/recovery, typed receipts, unknown writes without retry, Chromium/WebKit responsive fixtures | Persistent activation and native desktop runtime trials |
| Other channels and mobile | Shared scoped primitives only | Mobile outbound relay/QR/UI, Weixin iLink, Feishu and separate Lark implementation and acceptance |
| CI | Native steps enrolled in all three PR workflows; source policy checks; current-head outcomes recorded on PR 266 | Native product acceptance beyond automated CI |

## Reproduce regression

Synchronize the current uncommitted source to WZU_Server at ~/codex-build/x-harness-rs/, excluding .git, target, node_modules, .env and .env.*, keys, cookies, credentials and transient .xharness-ui-stage-* directories. Verify remote Rust-idle state and hold the owned build lock before synchronization or compilation. Do not compile Rust locally or silently use another node.

Run in that remote project directory:

```sh
export RUST_TEST_THREADS=2
cargo test --locked -p xharness-api -p xharness-remote \
  -p xharness-channel-telegram -p xharness-host -p xharness-host-app \
  -p xharness-projection -p xharness-server -p xharness-schedule
cargo clippy --locked -p xharness-api -p xharness-remote \
  -p xharness-channel-telegram -p xharness-host -p xharness-host-app \
  -p xharness-projection -p xharness-server -p xharness-schedule \
  --all-targets -- -D warnings
```

Local non-compiling checks include cargo fmt, architecture/mutation/CI policy tests, emitted-client contracts, static UI assembly verification and the two browser fixtures. Browser fixtures use an isolated loopback server and configured Playwright dependencies, not a real desktop keychain or live platform token.

## Completion requirements

For every real channel, verify scoped pairing/binding, task input/output/follow-up, approvals, cancellation, supported attachments and scheduling; then test disconnect, Host restart, duplicates and revocation. Repeat the real round trip three times and distinguish Agent completion from reply delivery. Obtain fresh authorization before paid model trials, and configure secrets locally without publishing them in evidence.

No production application restart, deployment, merge or full-goal completion is implied by this checkpoint. As requested on 2026-10-11, this implementation may be submitted as a Draft PR for review before the full goal is complete. Draft submission is not release readiness; all unfinished implementation and real acceptance gates above remain open.
