# Optional WordCraft plugin acceptance — 2026-11-10

Base: `3d41339a3595d8bb6d460fc8dcdc8858262fb6b2`. No dependency/version/lockfile
changes, local Rust compilation, production installation, release or Host restart.

## Inputs

- Upstream engine: WordCraft 0.5.0, commit
  `ad8c26442076e357f5bb88515b25dfbf73c81e2e`.
- Adapter: ZCode 0.2.3 artifact 12334267106, workflow head
  `67a942f9bfaad41630ab5214d03eedfdeba94d7b`.
- Audited source ZIP SHA-256:
  `c2f8f827f217a3c3b3b7ed263205947b7c601113a11d298a65dce03045f16a9f`.
- XHarness 0.1.0 plugin: 40,084,038-byte ZIP; SHA-256
  `ed0879f7548b1ce7e7a4920f2b89a0d55fbac0e70ffa365a52d9d983a749e22d`.
- Unchanged WASM: 88,453,355 bytes; SHA-256
  `75040b8ed95370c8e2bb71b5572e3bbabd89193f140c5bd089249c7a1fc32e0e`.
- Two independent repacks matched exactly. Unreviewed/traversal ZIP input is
  rejected before output can be created or overwritten.

## Checks

- WZU_Server: 719 affected Rust tests passed across MCP, plugins, HTTP carrier,
  Host-app and Host. Fifteen existing external/paid opt-in tests remained ignored;
  no new ignored test was added. Strict all-target Clippy passed for all five crates.
- Architecture: differential freeze/dependency gate and 34 mutation tests passed.
  The new control seam is enrolled in the existing recoverable-error guard.
- Actual remote compiler mutations: 56 Clippy cases and two unsafe-guard cases
  rejected the intended code, restored original source bytes and passed positive
  compilation. An initial guard-copy attempt encountered unrelated legacy remote
  benchmark permissions; the successful run used a clean source-only staging copy,
  not those old private datasets and not relaxed permissions.
- UI: strict TypeScript, owned-source production build/check and 80 contracts
  passed. Browser bridge tests passed in Chromium and Playwright WebKit, including
  the actual carrier CSP, external module loading in an opaque iframe, source
  spoof rejection, retention, busy-close rejection and confirmed close.
- Registry: nine archive/binding tests plus 33 existing developer-plugin tests
  passed, with existing packages preserved byte-for-byte.

## Real editor acceptance

A separate loopback fixture used the production plugin manager, session scope,
MCP runtime, asset carrier and React panel with the actual compiled WASM, no
model or account credentials. Chromium and Playwright WebKit both opened a
synthetic workspace DOCX, preserved initial text, accepted Unicode editing,
rejected hidden edits, resumed visible editing and saved a valid DOCX. ZIP/XML
readback confirmed the new Chinese text and absence of the rejected hidden edit.
The manual-save RPC also produced a valid DOCX; traversal, non-DOCX destination
and missing overwrite confirmation were rejected.

For these remote-control browser runs, the **same hash-verified public WASM** was
streamed locally to avoid repeated 88 MB transfers across SSH. HTML/CSP, JS, MCP,
resource reads and workspace writes used the actual remote Host. A real Host
asset stream was separately exercised. This is not a claim of remote-network
startup performance, current production WebView memory equivalence, system
WKWebView integration certification or full DOCX layout fidelity.

Two defects were found and corrected rather than waived: model/app traffic
serialization could deadlock a waiting tool, and WebKit did not match CSP `self`
for a module in an opaque sandbox. Sources are now bound to the exact Host and
capability path, without granting the whole origin or `allow-same-origin`.

First-version limits remain explicit: existing workspace DOCX entry, full-access
opt-in, visible/ready AI operations, DOCX-only manual save, two retained panels,
and no unsaved browser-memory recovery after reload/crash. Closing a busy panel
does not cancel its work; timeout never automatically discards a pinned editor.

## Merge follow-up

The exact Linux CI run found that a `null` UI pin expanded the legacy installed
plugin DTO's exact v1 key set. The optional pin is now omitted only for legacy
plugins (`None`); a present UI pin still serializes and round-trips through stored
state. The original Rust-producer/JS-consumer contract passes unchanged: 13 native
Host replies, one shared DTO reply, 11 endpoints and two error replies.

Review also found the old cancellation branch disconnected the entire plugin,
including other sessions. Editor model calls now send a cancellation notification
for the exact request/transport epoch, without closing either pinned editor.
A deterministic two-session stdio regression proves delivery, continued operation
in the other session and no dispatch for an already-cancelled call. Ordinary MCP
and its MRTR handling are unchanged. The explicit editor harness exercises this
same single-round model path. No prompt, Skill, package bytes or enablement policy
was changed by this follow-up.
The real compiled editor also accepted request-scoped cancellation on Chromium
and WebKit, then remained usable for inspection, Unicode editing and saving.
Saved DOCX ZIP/XML was checked again after cancellation. The same local supply
of hash-identical WASM and actual remote Host boundary described above was used.
