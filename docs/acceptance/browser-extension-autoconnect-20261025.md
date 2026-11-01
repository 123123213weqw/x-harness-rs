# Browser extension automatic connection — 2026-10-25

Branch: `feat/browser-extension-20261025`. Integrated master baseline:
`9c9dabe392d29dcaa1d0ddca71b398cd6972fd24` (includes #384 and #389).
This supersedes the manual-pairing setup in `browser-extension-20261025.md`;
that earlier receipt is historical, not the current user flow.

## Changed behavior

- No manual pairing code or model-specified context selector. Host derives stable
  store/session-scoped identity, strips case-insensitive reserved plugin selectors
  before environment resolution, and injects identity only into the extension MCP.
- Popup opt-in persists automatic native discovery/reconnect across browser
  startups. Bounded 30s–5min reconnect alarms plus handshake deadlines replace
  repeated manual connect. Missing native installation remains a visible status.
- Exact same-session tab/origin/context bindings survive native/MCP/worker
  lifetimes via trusted-only `storage.session`. Full browser restart does not
  reuse old tab IDs. New tabs/sites/conversations still require explicit consent.
- Stop/cancellation, user detachment, origin/permission change, close and explicit
  disconnect delete consent. Native/helper/client exit retires control without
  deleting exact consent; unknown operations are never replayed. Duplicate
  contexts revoke authority instead of choosing an arbitrary owner.
- Complete per-platform MCP archives include native launcher, installer and every
  required runtime resource. The enabled Host-bound plugin performs user-level
  native registration automatically, with immutable digest snapshots. It refuses
  tampering and unrelated manifests; concurrent clients converge without
  overwriting an executable used by a live browser. Native credentials never
  enter model messages. Node 20+ remains an explicit MCP runtime prerequisite.
- CI enrollment now builds four complete candidate platform archives, not just
  browser ZIPs. No public catalog, release channel, signed distribution or user
  installation is modified by this change.

## Actual validation

All Rust compilation/testing/Clippy ran on **WZU_Server**, after rsync excluding
Git, target, node_modules and sensitive environment/key files. No local Rust build.
Remote checkout: `~/codex-build/x-harness-rs/browser-extension-20261025/`.

| Gate | Result observed before PR |
| --- | --- |
| Strict TS build + Node contracts | **30 passed** on local macOS and remote Linux |
| Host `plugin_mcp` unit tests | **19 passed**, 2 explicit integrations initially ignored |
| Real verified plugin → plugin_mcp → rmcp → complete MCP automatic native setup | **1 passed explicitly** on Linux, including spoofed plugin identity removal |
| Native launcher | **2 passed** on Linux |
| Plugin crate | **10 passed**, 1 unrelated explicit network acceptance ignored |
| Affected Host/plugin crates Clippy all targets, warnings denied | passed |
| Architecture dependency/freeze + fmt + diff whitespace | passed |
| Architecture policy fixture tests | **30 passed remotely** |
| Real isolated Linux Chromium/native/popup/MCP | **21 checks passed** |
| Generated archive boot outside source checkout | covered by Node test; actual native binary separately verified by Rust integration |

Node contracts cover actual private MCP framing, incorrect-token denial, missing
Host identity, strict discriminated schemas/no unsafe TS escapes, stale-registration
scan fairness, immutable/tampered/concurrent installs, actual generated archive
inventory and bootstrap, old queued effects, duplicate contexts, restore/stop races (including origin changes during pending restoration),
worker-state hydration and manual-disconnect persistence. Windows unit runs
intentionally skip file-install tests that would modify HKCU; portable registration
plans still run. This is not a Windows installed-browser acceptance claim.

The 21 real browser checks include:
1. Host-context status + first-use automatic native registration, no pairing code.
2. Real trusted popup → Native Messaging → explicit tab grant.
3. Non-secure HTTP page observation without page WebCrypto.
4. Browser-owned trusted key event, no foreground keyboard leakage.
5. MCP recreation restores the same conversation without popup re-pairing.
6. Existing synthetic HTTP-only fixture session retained (no cookie transfer).
7. Trusted fill/click in an inactive tab without foreground change.
8. One-shot refs cannot replay.
9. Same-looking DOM replacements rejected.
10. Expired refs rejected while native connection survives MV3 idle interval.
11. Hard UTF-8 budget and truthful clipping for oversized CJK observations.
12. Other conversation cannot read the authorized tab.
13. **Actual isolated native helper process termination → automatic reconnect**,
    restoring exact consent with no repeated click or manual pairing.
14. Actual background PNG carried as MCP image content.
15. Same-origin navigation waits for committed loader/readiness.
16. Cross-origin tool navigation denied before dispatch.
17. Stop revokes before next effect.
18. Stop survives MCP recreation; no automatic re-grant.
19. Manual cross-origin navigation requires fresh consent.
20. Client process exit retires live control.
21. Explicit disconnect clears consent and disables automatic connection.

The fixture terminates only the native helper matching its exact random temporary
HOME/runtime path, never a user process. It closes its own Chromium/MCP processes
and removes its own profiles. No user browser/app restart, account or model spend.

## Evidence and corrections (ignored local output)

`dist/browser-extension-evidence/`:
- `node-auto-final.log`: 30 Node tests.
- `rust-auto.log`: Host/launcher/plugin tests and Clippy.
- `packaged-integration-auto-final.log`: real complete native archive integration,
  final Clippy and Python policy fixtures.
- `real-auto-final.log`: preceding 21-check run.
- `linux-auto-exact-final.log`: final remote strict build, 30 Node tests, complete
  plugin integration and 21 real browser checks for the final source.
- `architecture-auto.log`: exact-base freeze/dependency results.
- `popup-connected.png`, `background-page.png`, `acceptance.json`: real browser
  visual/JSON evidence (copied from remote after final run).

An explicit native-archive integration initially failed because the packaged runtime
omitted `dist/extension-id.json`. The missing resource was added to both the actual
package definition and integration inventory; a generated-archive bootstrap test
now prevents source-checkout resources from masking this failure. No assertion was
weakened. Earlier failed integration log is retained separately.

The macOS system Python 3.9 cannot execute the existing freeze fixture's
`Path.write_text(newline=...)`; the same unchanged fixtures were rerun with the
remote Python and passed. Architecture policy itself passed locally too.

## Remaining release gates (not reported as passed)

- New CI workflow's macOS/Windows jobs, real installed Chrome/Edge + optional-site
  permission prompt, Windows ACL/registry/console path, signed/notarized helpers.
- Store publication, public plugin catalog enrollment, bundled Node distribution
  (currently Node 20+ required), custom profile install UX and managed browsers.
- Full browser restart intentionally drops exact-tab grants; same-session worker
  hydration is unit-tested, not misreported as an actual cold-worker browser probe.
- Real login/CAPTCHA handoff, long-running RAM/CPU measurements, minimized/frozen
  tabs beyond explicit rejection, iframe/canvas/recording/other-browser parity.

Production still requests optional site permission from a real popup gesture. The
isolated browser fixture pregrants only its ephemeral local origin and records
`productionPermissionPromptTested:false`. Background assertions use Chrome's real
active tab/foreground input, not Playwright's virtually visible renderer state.

## Windows CI follow-up (2026-10-27)

The early-exit-safe teardown exposed, rather than fixed, the Windows startup
failure: Windows PowerShell could not autoload `Microsoft.PowerShell.Security`
for `Set-Acl` under the inherited module environment. Both MCP startup tests
failed with that concrete error; automatic discovery timed out before publishing
its client. Those CI attempts are not passes.

Directory protection now applies the same owner/SYSTEM-only, inheritance-protected
ACL through Windows PowerShell's .NET Framework `Directory.SetAccessControl`,
without cmdlet/module autoloading. There is no permissive fallback. A new Windows
regression starts the real Node adapter with an empty/nonexistent `PSModulePath`,
uses a path containing spaces, Unicode and shell metacharacters, and checks the
resulting owner and exact ACL rules through .NET. On Mac, 31 portable tests pass
and that Windows-only test is intentionally skipped; fresh Windows CI must pass
before this correction is accepted.

Integrated the accepted mobile-layout/current-master changes without source
conflicts. The merged Host application passed 150 library tests (4 existing
explicit opt-in tests ignored) and all-target Clippy on WZU_Server. A reused
Cargo target initially selected a stale `xharness-plugins` artifact despite the
synced source containing `storage_root`; refreshing that crate's source mtime
forced its rebuild and the complete tests/Clippy then passed. No API workaround,
source weakening or local Rust compilation was used. Portable Node tests still
pass (31 passed, Windows-only ACL case skipped on Mac).
