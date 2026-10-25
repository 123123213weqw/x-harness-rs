# Turn-end file actions and built-in preview — 2026-10-24

Base: `4c6c9b12df00090a08bf5fa91c1d1470bfef686e` (master).
Work branch: `feat/produced-file-actions-20261024`.

## Implemented

- Keep the existing successful-write/edit location evidence and exact-path disambiguation. Closing prose is not evidence that a file was produced. Turn-end results use the approved attachment-card layout: type icon, actual filename, type subtitle and one Open in dropdown. Single results have no redundant heading; multiple files start with one card and expand/collapse the rest. The dropdown reuses the shared product Menu, with keyboard navigation and portaled viewport placement.
- Primary file clicks use the existing right-hand workspace file tabs; no second browser runtime or model tool is introduced.
- Per-file choices: built-in preview, reveal the exact file in its folder, and default-application hand-off. Actions are click-only, never automatically executed at turn end.
- Native actions use the current owning session's cwd, not the Host process cwd. Only a local connection advertising the capability exposes native actions. Old Hosts without `canRevealPath` never silently open a file instead of revealing it.
- Reuse `host.openPath`, adding optional `mode: reveal`; omitted mode keeps default-app hand-off. Native paths must be absolute, existing and NUL-free. Commands use literal argv with `--`, not shell interpolation. The short opener process is reaped, timed out, and checked for failure.
- Existing code/text, Markdown, raster image and diff renderers remain. PDF is a byte-sniffed, at-most-8-MiB preview-only variant with owned/revoked Blob URLs. Encoding runs under the existing preview semaphore on the blocking pool.
- HTML/SVG get a static sandboxed preview/source toggle. Scripts, frames, navigation attributes and external resources are removed or blocked; no Host IPC is exposed. Interactive HTML applications still require their normal browser/server workflow.
- Unsupported/binary/oversized/missing files get visible feedback without losing the native action toolbar. Native hand-off failure no longer destroys an otherwise working preview. Stale native replies cannot paint an error over a newly selected file.

## Regression evidence

All Rust commands were run on `WZU_Server`, after synchronizing source into
`~/codex-build/x-harness-rs/produced-file-actions-20261024/`; no local Rust compilation.

| Gate | Result |
| --- | --- |
| `cargo test --locked -p xharness-api` | 20 tests passed |
| `cargo test --locked -p xharness-host --lib native_path_tests` | 1 passed |
| `cargo test --locked -p xharness-host --test basic_host native_file_actions` | 1 passed |
| `cargo test --locked -p xharness-host-app --test file_display` | 18 passed |
| `cargo clippy --locked -p xharness-api -p xharness-host -p xharness-host-app --all-targets -- -D warnings` | passed |
| Display source/client guards | 14 passed |
| View/source registration and owner-session action routing | 78 passed |
| CI plan coverage/sharding guards | 14 passed; frozen baseline unchanged |
| Chromium and WebKit: produced-file component | both passed; exact paths, folding, capability gates, failure feedback, 460px layout; no page errors |
| Chromium and WebKit: full owned UI display chain | both passed; Markdown/code/image/diff regressions, isolated HTML, PDF Blob lifecycle, owner isolation, missing-file fallback; no page errors |
| Strict owned production and fixture builds | both passed: 61 modules / 190 assets |
| Rust DTO → committed TS/Zod contract check | passed |
| Architecture dependency/freeze and formatting | passed; content-bound compatibility record retained |

New component browser regressions are enrolled in the existing Chromium/WebKit
CI plan (`browser-240` / `browser-241`). No existing suite was removed.

Local detailed logs and screenshots: `dist/file-actions-evidence/` (ignored).

## Honest acceptance boundaries

- No installed app was restarted/replaced, no deployment/release/merge was performed.
- Native command planning and RPC refusal/capability behavior were tested on Linux. A macOS signed candidate still needs the actual Finder/default-app click-through smoke test; this report does not claim it happened.
- Browser tests verify the PDF container, bounded bytes and URL disposal, not every browser's PDF plug-in rendering or every encrypted PDF. An explicit default-app fallback remains.
- Office archives, audio/video, and other unsupported binaries are not converted by the built-in viewer; users can open them in their default applications. Text is capped at 512 KiB, image/PDF encoded source at 8 MiB.
- Arbitrary Bash/Python-produced artifacts without mutation-location metadata are not silently discovered. A future explicit artifact contract can cover those without treating assistant prose as filesystem proof.
- The Git aggregate review design remains the separate UI prototype; this patch adds file actions to the existing production file pipeline, not a claim that every prototype control has been integrated.

## Attachment-card layout follow-up

- Replaced the inline chip/probe/action row with the user-supplied card design. Existing mutation evidence, Host routing and native action boundaries are unchanged.
- Added extension-based visual classification only; a type label does not claim that unsupported formats can be rendered internally.
- Regression covers single/multiple results, exact duplicate-basename path actions, no automatic native launch, local and legacy Host capability gates, failure feedback, 460px card geometry, scroll-edge menu placement, keyboard entry/navigation/Escape/focus restoration.
- Shared Menu gained only an optional list ID for the owning trigger's aria-controls and focus; its existing model-picker bilingual/theme regressions are exercised as a compatibility check.
- Standalone visual demo uses the real component; native menu actions there are message-only. Private screenshot comparison and QA: `/Users/wangyue/codex-build/xharness-diff-demo-20261024/design-qa.md`.
- Current-run evidence: `card-view-tests.log`, `card-ui-production-build.log`, `card-browser-final.log`, `card-menu-compat-regression.log` in the ignored evidence directory. The initial keyboard test failure and missing remote build prerequisite remain in `card-browser-regression.log`; neither is hidden or treated as a pass.

Final card follow-up results: Chromium and WebKit component regressions passed with no page errors; shared Menu model-picker compatibility passed four bilingual/theme scenarios per engine; 78 view/source tests and the strict 61-module/190-asset production build passed. No Rust implementation changed in this layout follow-up.

## Office/PDF attachment glyphs follow-up

- PPT/PPTX: orange presentation board; DOC/DOCX and document formats: blue text document; XLS/XLSX/CSV: green spreadsheet; PDF: red PDF page. Distinct shapes accompany colors; displayed filename and type remain text, so color is not the only cue.
- Four static Tabler glyphs are adapted to the existing IconProps/exports, with unchanged upstream path geometry. Upstream commit and full MIT notice are retained in `docs/licenses/tabler-file-icons.txt`; the legal source comment is preserved by the existing platform builder. No npm/runtime dependency or network request is added.
- This is icon metadata only, not added Office document rendering. Existing preview/default-app behavior is unchanged.
- Added upper/lowercase legacy/current Office extension unit cases and browser checks for all four semantic kinds, distinct geometry/colors, subtitles, 320px fit and exact DOCX native-action path. Evidence: `office-icon-view-tests.log`, `office-icon-build.log`, `office-icon-browser.log`.

Office-icon final gates: 78 view/source tests passed; strict production build passed (61 modules/190 assets); Chromium and WebKit both passed, including Office glyph/320px/exact-DOCX-action assertions with no page errors. Strict standalone demo TypeScript passed.

## Complete file-card follow-up — 2026-10-25

### Implemented surfaces
- One shared file-type registry owns 13 visual categories, extension aliases, colors and conservative fallback preview policy. The existing deliverables facade stays compatible. Images, audio/video, archives, Markdown, data and unknown files now have distinct glyphs in addition to Office/PDF.
- Format identity is separate from actual Host inspection. `/api` → `display/inspect` is a session-owned, read-only metadata endpoint, with Rust-generated TS/Zod DTOs. No model tool or prompt/schema entry is added.
- Cards and the existing workspace FilePane show a neutral information state for unsupported/oversized files instead of entering a known-failing full document read. `display` intents can open that information pane too. Legacy adapters retain read validation, including the original relative-resource semantics.
- File size and, when available, original image dimensions appear in the second line. Modified time is tucked into optional information details. Failure/old Host metadata remains optional and never removes the basic card/actions.
- A viewport observer admits visible/nearby cards only. Folded rows are not mounted or read. Expanded sets use 20-row pages rather than creating every row at once.
- Raster thumbnails are opt-in, static and ephemeral; originals are never rewritten. The browser owns/revokes Blob URLs on invisibility, fold and unmount, and falls back to the type glyph on failure.
- Duplicate basenames reveal their parent directory. Open in adds exact resolved-path copying with success/failure feedback. The existing FilePane also provides path copying.
- Created/modified badges require successful tool-result evidence. Call-time or result-time `oldText: null` does not prove creation (it also represents overwrite without a before-image). Unknown cases remain unlabeled. Closing-sequence filtering is preserved; same-turn successful deletion removes the current card without rewriting historical earlier state.

### Resource and authority budgets
| Resource | Bound / behavior |
| --- | --- |
| Ordinary metadata sample | At most 4 KiB, with metadata from the same contained no-follow file handle |
| Thumbnail source | At most 2 MiB and 4 megapixels |
| Thumbnail output | At most 96 × 96, PNG, 48 KiB |
| Decoder allocation setting | 32 MiB; not a claim about total Host RSS |
| Browser metadata requests | At most 2 active; at most 64 queued; abort-aware |
| Browser cache | At most 24 entries and 1 MiB thumbnail Base64; 15s TTL; session/path/evidence-revision isolated |
| Old-Host endpoint fallback | Unknown inspection endpoint cools down for 30s; missing files do not disable other metadata |
| Full preview | Existing 512 KiB text, 8 MiB raster/PDF bounds remain |

Metadata/thumbnail reads do not authorize a later blind model write and do not enter model input or durable conversation content. Filesystem permission, symlink, cancellation and session checks remain in the native/Host layers; the UI is not the authorization boundary.

### Final observed gates
- WZU_Server: 22 native file-display integration tests, 5 Host display/cancellation tests, affected-crate Clippy with `-D warnings`: passed. No Rust compilation ran locally.
- JavaScript: 80 view/source tests, 16 file-display/client guards, 13 terminal/wire-contract tests: passed. Numeric schema lowering is tested for safe uint64 and nullable bound preservation, without dropping unknown constraints.
- Chromium + WebKit: both real source-component and full owned UI suites passed, no page errors. Includes 320px cards, keyboard/portal bounds, metadata, thumbnails and Blob cleanup, exact DOCX default-app/copy path, neutral unsupported Office information, pagination, and unchanged Markdown/image/PDF/HTML/Git diff behavior.
- Strict production build + committed production-artifact verification: passed, 61 modules / 190 assets. Standalone demonstration strict TypeScript also passed. Architecture/freeze and `cargo fmt --check` passed.
- Earlier WebKit thumbnail failures were traced to the isolated fixture aborting local Blob requests. The fixture now permits only browser-owned `blob:` requests while retaining other asset/network interception. The actual image-load and cleanup assertions remain required; they were not weakened.

Current evidence: `rich-card-final-browser-gate.log`, `rich-card-rust-final-verified.log`, `rich-card-view.log`, `rich-card-client-tests.log`, `rich-card-contract-tests.log`, `rich-card-production-check.log`, `rich-card-architecture.log` in `dist/file-actions-evidence/`.

### Boundaries retained
- This does not add an Office renderer, audio/video player, archive extraction, directory scanner, automatic app launch or model vision input. Unsupported formats use information/default-app options.
- Turn-end cards still require successful mutation-location evidence. Explicit display intents can independently open the existing right-hand pane, but do not automatically become turn-end cards. Arbitrary Bash/Python outputs are not guessed from closing prose or a filesystem-wide scan.
- The isolated browser demo uses clearly labeled synthetic metadata and read-only callbacks; actual filesystem behavior is covered by native integration tests, not the demo's sample file names.
- No PR, merge, release, installed-app replacement, restart or interruption of current tasks was performed. Native Finder/default-app behavior still requires the separate signed macOS candidate smoke test before release.
