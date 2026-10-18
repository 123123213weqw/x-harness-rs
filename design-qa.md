# Composer polish: design QA

## Scope and visual truth

- Source direction: `/Users/wangyue/.codex/generated_images/01a0ff04-b83f-7f10-92b1-540a4e1a2cd6/exec-e7f3a906-d2b1-4841-ac4c-7dd424591951.png` (1536 × 1024 raster pixels).
- The user's latest instruction takes precedence: keep the original input layout, apply surrounding visual polish. This is not a pixel clone of the generated composer.
- Original input references: `/var/folders/jb/vq4jn1w94dsc2tt35tfkrvkr0000gn/T/codex-clipboard-374efe60-a47e-4271-a917-c1a985710b15.png` and `/var/folders/jb/vq4jn1w94dsc2tt35tfkrvkr0000gn/T/codex-clipboard-314ce2b5-c582-495a-8f35-3d7aaaf7683b.png`.
- Implementation: `http://127.0.0.1:3296/?polish&dark`; new-session variant adds `&hero`. Production components and input machine; synthetic Host projections only, no live requests.
- Browser capture viewport: 1280 × 720 CSS pixels, screenshots 1280 × 720 pixels (1×). Original design is an illustrative two-state board, not a same-density browser capture. Comparisons align content regions; no pixel-equality claim.

## Evidence

All paths below are under this worktree's ignored `dist/design-qa/` directory.

- First pass: `active-dark.png`, full combined comparison `comparison-before.png`.
- Final active state: `active-dark-final.png`; cropped input card `composer-card.png`.
- Final new session: `hero-dark.png`; light mode: `active-light.png`.
- Full composition comparison: `comparison-final.png` places the reference and both rendered states together, cropping browser-only canvas from the rendered regions.
- Focused comparison: `comparison-tasks.png` compares task count, state markers, alignment and completed-title strike. Crops are normalized to fit adjacent panels; source type size is not a CSS-size specification.

## Comparison history

1. First pass found two P2 issues: nested task/queue docks inherited standalone width calculations, misaligning their left edges; the isolated preview transcript had an unthemed heading in dark mode.
2. Fix: composer-scoped full-width rules in the dock styles, with matching inner padding; preview chrome uses the existing theme foreground and background tokens. Standalone dock widths remain supported. InputBar source and stylesheet were not modified.
3. Re-captured the same active dark state after the fix. `comparison-final.png` and `comparison-tasks.png` show aligned task, Goal and queue rows and readable dark-preview text. No remaining actionable P0/P1/P2 findings within the agreed scope.

## Required fidelity surfaces

- **Typography:** existing product font stack, native UI sizing, wrapping and focus behavior retained. Compact counts use tabular numerals. Long task titles wrap rather than disappearing behind ellipses. The larger generated-board typography is not imposed on the existing composer.
- **Spacing:** flat checklist/Goal/queue surfaces with consistent composer insets; no decorative vertical dividers added. The original hero/compact toolbar positions, writing surface, Send/Stop positions and slot registration order remain intact.
- **Colors:** existing light/dark tokens; neutral completed-task text and strikethrough. Existing semantic access-warning color is intentionally retained rather than hiding permission state.
- **Asset fidelity:** existing product orbital vector icon replaces the smaller model glyph; no raster approximation or external icon dependency. Existing checklist/status glyphs remain in use. The generated board is an art-direction reference, not a requirement to replace the product icon system.
- **Copy:** original Local/workspace labels, model names, reasoning labels and Goal wording retained. Existing Progress title remains for the durable task plan. Preview sample tasks correspond to the reference's three states. No hardcoded task content enters production.

## Interactions and regression coverage

- Manual in-app-browser inspection: task collapse/expand, original model menu, hero Local/workspace labels, light/dark states. No browser warning/error logs on the inspected final light page.
- Automated Chromium and WebKit: 20 light/dark viewport cases each (1280 down to 320 CSS pixels), long model names, file chooser, Stop/Queue/Send, draft/caret retention, Goal edit/budget, task default expansion, completed strikethrough, keyboard disclosure, long task wrapping, queue edit/remove and hero/active textarea continuity.
- Shipped Progress runtime tests in both engines: empty/clear, ordered statuses, completion count, strikethrough, keyboard collapse, literal unsafe-looking titles, parallel items and narrow layouts.
- Strict TypeScript and repository-only production build pass. Conversation, Goal and model-selection source suites pass 53 tests; reviewed stylesheet changes are explicitly pinned without changing the frozen reference or the InputBar hash.
- The installed app has not been restarted, replaced or deployed. No live agents or user queues were mutated. Backend behavior is outside this visual task.

## Intentional deviations and remaining gaps

- The generated board puts Goal before tasks and shows an execution row above both examples. Existing runtime slot order and active-chat layout are preserved instead of restructuring conversation behavior.
- The current product's original hero and compact input layouts differ from each other. They remain different as explicitly requested, including their model/reasoning controls.
- This is a component preview, not a full signed desktop installation or a live-server end-to-end acceptance run.

## Implementation checklist

- [x] Keep original InputBar TSX/CSS and handlers unchanged.
- [x] Retain Local/workspace language labels.
- [x] Reuse the product orbital model icon.
- [x] Flatten and align task/Goal/queue surfaces.
- [x] Show legacy tasks by default and strike completed titles.
- [x] Verify light/dark, keyboard actions and narrow layouts.
- [x] Keep fixtures outside production and regenerate production assets.

**Final result: passed**
