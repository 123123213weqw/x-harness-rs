# Composer attachment menu implementation plan

**Goal:** Put file picking inside the existing chat composer plus menu and remove the separate attachment toolbar.

**Design:** Reuse the existing plus position and shared Menu primitive, opening above it. First row: paperclip + “添加图片或文件”; second row preserves the current command launcher. Keep image/file preview cards only when there are attachments. Preserve drag/drop, paste, validation, retained drafts and model routing. Prefer this over making plus open a picker directly (loses discoverable commands) or adding another icon (keeps clutter). No theme/font redesign or native platform fork.

**Implementation:** Code/frontend-design with writing-plans and executing-plans guidance; user has supplied the interaction direction. Work on a clean master-based branch. Shared React helper at `ui/overrides/composer-add-menu.js`; exact-signature, idempotent migration in `scripts/patch-composer-add-menu.mjs`, invoked by the existing attachment patch for both assembly and checked-in bundle refresh.

1. Update `scripts/test-attachments-browser.mjs` to exercise actual shipped InputBar + attachment slot, not a synthetic picker. Cover no extra toolbar, plus menu, mixed picker, cancel/reselect, command callback, keyboard/outside close, blocked input, drop/paste, previews and narrow/dark layout. Establish failure on old bundle.
2. Implement helper/patch and refresh the two affected plugins plus immutable boot graph. Picker stays within composer instance; callbacks recheck capability, preserve selection and use the existing intake validator. Reuse Menu theme/placement. No global upload event bus, backend or multimodal policy changes.
3. Run Node attachment contracts, Chromium/WebKit browser fixtures and related composer regression tests; inspect screenshots. Submit focused upstream PR per repository preference. Do not publish a new release or replace the user App as part of this UI-only request.

## Verification

- Original bundle fails the new standalone-toolbar removal regression. Fixed attachment contracts pass, including mixed payloads, retained failed drafts, count/size limits, idempotent patching and source/helper parity.
- Actual shipped InputBar + shared Menu + attachment slot passes Chromium and WebKit: command callback preserves caret, Escape/Tab/outside dismissal, picker multi-select, cancel/reselect, image decode/lightbox, drop/paste, late picker result rejected while locked, session-switch closure, narrow-menu bounds and actual dark-palette change.
- Both browsers pass existing message-edit regressions and 19 context/composer layout cases each. Message-edit lifecycle (40 assertions + 3 contracts), context-accounting and desktop asset checks pass.
- Screenshots inspected at `dist/attachment-ui-evidence/`, including empty, menu, mixed, narrow and dark states. All fixtures are isolated from real user sessions, models and the running App.
- No local Rust compilation. CI retains these existing browser test entry points; upstream CI is separate from local verification. No release or local App update performed.
