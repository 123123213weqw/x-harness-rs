# Collapsed reasoning page motion — 2026-10-04

The owned conversation renderer now paces only the running, collapsed reasoning preview. Rate is a visual proxy from recent UTF-16 character growth, not model token accounting. Enter at 120 characters/s, exit below 80; observe at least 200ms. Keep an 800ms page deadline independent of incoming chunks. The newest readable line replaces the previous page with a 180ms upward fade. A newly-started line shorter than eight characters uses the previous complete line. There is no queue, no transcript mutation, and no animation backlog.

The row remains 24px high, with at most two visual lines. The outgoing line is aria-hidden and expires after the flip. Fast paging replaces the sweep, rather than layering two animations; ordinary low-speed reasoning retains the original sweep. Expanded reasoning remains the unmodified full text. Finish, expansion, and nonappend replacement bypass pending pages immediately. Visibility changes cancel timers, and reduced motion keeps reading cadence without the movement. Historical/restored text does not count as throughput.

All changes remain in the conversation presentation layer. No protocol, model, token accounting, persistence or Rust code was changed for this feature; no additional dependency was installed. The existing text renderer and automation work are preserved. The stylesheet parity test retains exact checks for every unrelated stylesheet; the reasoning-only delta must equal its maintained source and retain the old rules verbatim as a prefix.

## Verification

- 12 new deterministic model/hook/integration cases.
- 169 conversation, streaming, product, view and type-policy cases passed.
- 44 automation/navigation/task cases passed.
- Strict owned build, strict demo typecheck, deterministic build, motion-token checks and git diff whitespace checks passed.
- Real in-app browser used the production components with synthetic chunks; three consecutive 180ms flips were verified, as were expansion (5436/5436 characters), completion, low speed, reduced motion and narrow layout.
- `browser-checks.json` records observed DOM/CSS. `demo.png` is a real screenshot, not a mockup.
- Hidden-page cleanup and delayed callback behavior were deterministic hook/model tests, not native platform observations.
- Reduced-motion emulation was cleared. No paid model test, native WebKit test, desktop replacement or hosted CI run was performed here.

Open http://127.0.0.1:3267/ and choose high-speed thinking, then Replay. Think expands the entire reasoning body. The server is local-only and the fixture does not invoke any model API.
