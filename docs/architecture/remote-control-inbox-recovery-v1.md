# Desktop review of uncertain inbox outcomes

The local desktop can inspect and review uncertain remote requests without replaying them or forwarding another native interaction answer. A review changes the private inbox and appends an audit; it is not native task completion, cancellation, a permission grant or a fresh interaction handle.

## Access and metadata

The dedicated desktop administration route retains desktop authentication, loopback binding, exact Host/Origin checks, same-origin headers, JSON/body limits and no-store responses. Bot credentials, mobile controller identities and arbitrary RPC text cannot access this route. The handler accepts closed uncertain_inbox and resolve_inbox actions. Actor identity is always authenticated-desktop, not a caller-supplied field.

uncertain_inbox takes a nonnegative sequence cursor and selects 26 uncertain rows. It returns at most 25, with a next cursor only when a further row exists. Each entry contains its immutable delivery identity, original principal revision and complete binding, a closed command type and an optional approval/question classification. It contains no input text, answer, ticket token, nonce, native frame, raw reason, provider diagnostics or result body. A bounded serializer prevents oversized metadata responses.

The identity digest is the raw lower-case SHA-256 of the immutable delivery key, sequence, principal, principal revision, complete binding and normalized input. Delivery keys remain opaque IDs; they are not assumed to be bare SHA-256 digests. Live authority changes do not rewrite this historical identity or grant a result permission.

## Exact review and audit

resolve_inbox accepts the full expected identity, a 64-character lower-case evidence SHA-256 and a closed resolution. The existing session gate serializes reviews with dispatch. In one FULL SQLite transaction, the gateway compares the expected immutable identity, checks the uncertain state, seals an associated interaction and appends the audit with the terminal inbox state.

- ObservedAccepted records that the owner observed acceptance. It does not certify task completion. Session creation and automation control reject this resolution because successful results require their original native receipts.
- VerifiedNotApplied rejects the delivery without replay. It does not resubmit the command or re-enable an old interaction.
- AbandonWithoutReplay abandons this delivery without replay or cancellation of native work.

An identical review is idempotent and returns the original audit. A different actor, evidence or conclusion conflicts with an existing audit. A changed expected sequence, revision, binding or digest cannot commit. Native recovery that completes before the review wins; the stale review cannot overwrite it or create another audit. Evidence records are digests, not secret text or arbitrary paths.

The response certifies the full identity, audit sequence, fixed actor, evidence, resolution and previous/current states. The desktop client validates all of them before displaying success. Transport loss, timeout, invalid receipt or conflicting state remains an explicit unknown/error, never an automatic retry.

## Interaction sealing

The ticket record and the global instance fence must both belong to the original delivery and exact original scope. A review changes both to reviewed in the same transaction as the inbox/audit commit. Any ownership mismatch rolls back the whole review.

All three conclusions keep the original native instance sealed. No review invokes Host, changes native approval policy, cancels a task, remints a ticket or permits a duplicate button to answer again. VerifiedNotApplied does not reopen the old instance. A genuinely new native nonce may mint its own ticket under current authorization; the old handle remains unusable.

## Desktop behavior

The bilingual monochrome Settings view shows command type, original principal/version and workspace/session/binding generation. It distinguishes sealed interactions and mutations requiring original proof. No request content or handle enters the rendered page.

Evidence must be valid before submission. Mutations requiring original receipts omit the manual acceptance choice. A confirmation explains that recording a review does not replay, cancel native work or unseal the interaction. Success explicitly reports that a review was recorded. Background status polling does not collapse loaded inbox pages or silently retry a write. Full refresh and explicit pagination are separate reads. Large integer identities that cannot be represented exactly in JavaScript fail closed instead of being rounded.

## Verification boundaries

Corrected WZU_Server regression passes 763 tests with zero failures and 11 unchanged ignored, plus eight-package all-target Clippy with warnings denied. Six gateway inbox cases, 16 ticket cases and seven desktop administration cases also pass targeted execution. Nine emitted-client contracts and Chromium/WebKit protocol fixtures pass. See docs/acceptance/remote-control.md for source identity and verification scope; earlier pending evidence remains historical.

Native gateway fixtures use durable fault cuts to exercise pagination, immutable identity comparison, evidence validation, idempotent audit/reopen, native completion races and original-proof restrictions. Ticket fixtures issue actual scoped handles, lose the native acknowledgement and verify atomic ticket/fence sealing, corruption rollback, approval/question privacy and old-handle denial. A fixture child process exits after an interaction effect and fresh gateway objects review its original uncertain delivery without another answer. This is a fixture backend, not a real approval or model account.

Desktop route fixtures verify middleware, metadata privacy, closed action shape, identity conflict and fixed-actor audit semantics. Actual emitted React/client code runs in isolated browser protocol fixtures for evidence gating, hidden native-proof acceptance choices, interaction copy, pagination, unknown writes without retry and bilingual responsive rendering. These do not certify live channels, real models, mobile remote transport or native OS desktop acceptance. The complete Goal remains unfinished.
