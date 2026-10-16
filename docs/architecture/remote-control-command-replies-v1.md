# Durable remote command replies

Explicit Telegram commands now receive plain-text replies from their already committed native results. The gateway commits the consumed result marker and the complete outgoing batch together. A lost acknowledgement, failed send or restart cannot rerun a prompt, cancellation, history/catalogue read or native interaction answer.

## Exact scope and atomic consumption

The scoped observer checks one oldest unconsumed terminal delivery on its existing 500 ms timer, before forward output projection. The read requires the current account lease, Host, principal revision, verified sender, conversation, full binding and generation, plus native workspace/session ownership with a two-second deadline. A stale account or revoked grant cannot consume a result from an older scope. Ordinary changed bindings and permission revisions fence old results; successful inbox selection and creation have separate narrow exact-current transition proofs described below. Command replies share the existing maximum 32 subscription workers; there is no additional Agent or global subscription.

A private command-reply entity records the delivery state, full delivery fingerprint, reply-plan fingerprint and outgoing keys. The existing FULL SQLite transaction checks the exact terminal delivery snapshot and unchanged scope, inserts the entire outgoing batch, then writes the marker. A conflicting reply identity or snapshot rolls back all of these changes. Exact retry returns the same outgoing records; different content for the same consumed state fails. The marker limit is 100000, with 1–64 reply plans and an 8 MiB batch bound. No controller endpoint accepts these markers or raw native RPC results.

A partial inbox index covers terminal state and exact session/principal/revision/binding/generation. Revision and generation comparisons use JSON number text, preserving the entire u64 range rather than a lossy SQLite integer conversion. The index does not eliminate every scan of previously consumed results; long-journal performance remains a measurement and retention concern.

## Command outcomes

Prompt admission is reported as accepted, not as task completion. Cancellation reports an accepted cancellation request, not proof that native execution stopped. An interaction answer reports that the native response was recorded. Rejected, abandoned, malformed and native failure outcomes use closed messages without raw diagnostics, request arguments or interaction identities.

An uncertain native command reports unknown outcome and directs the user to desktop reconciliation instead of suggesting a retry. If a trusted owner later records an observed accepted result, the changed delivery state can produce one new notification. This notification does not reconstruct missing history or rerun the native command. Prior outgoing records remain available for audit.

## Explicit history and pagination

The private-chat command is `/history [count [before_seq]]`. The default count is 50; accepted counts are 1–500. The optional cursor must be a canonical positive u64. Extra arguments, invalid numbers and accompanying media are rejected before native dispatch. Native optional fields are omitted when absent.

The reply renders only the persisted native history result. Native user-message data is the message directly; assistant-message data contains a nested message. Entries must have strictly increasing sequences and lie before the requested cursor. The history reducer may fold native events, so contiguous sequences are not required. A page containing the final message suppresses partial chunks for that same turn and step. Earlier pages retain the requested count and use the first native event sequence as the next before cursor. A page claiming more history without a positive continuation cursor fails explicitly.

Plain user and assistant text is preserved, with an interruption marker where applicable. Tool names are bounded to 512 bytes; tool results show only a validated finished/failed status. Reasoning, provider chunks, usage, raw tool stdout/arguments, projected views, metadata, diagnostics and attachment paths are not forwarded. Images/files queue separate event-owned attachment records for the requested page, including user media only on explicit history requests. Captions/bytes remain bounded; a queued marker is not proof of external receipt. See remote-control-media-v1.md.

The renderer permits at most 8192 native events, 128 content blocks per message and 200000 UTF-8 text bytes. Each outgoing part fits 4096 UTF-16 units, with at most 64 parts. Oversized or malformed history receives a closed failure reply rather than a successful truncation. No HTML or Markdown parse mode is enabled.

## Catalogue results

Telegram /sessions uses the same exact-scope terminal-result candidate and atomic consumption marker. It renders only the durable, closed ControllerCatalogue receipt with matching principal revision and binding generation, valid order/bounds and continuation. Every page identity is exact; title previews are explicit. A later page is another freshly authorized command, not a pinned snapshot or grant. Unknown send outcomes never reread a completed native catalogue cut. See remote-control-catalogue-commands-v1.md.

## Selection transition results

Telegram /select keeps its original delivery scope immutable. The candidate joins its separately committed transition proof and permits a result reply only in the exact selected current binding with the same principal revision. Full original-delivery fingerprints, typed old/new binding receipts and live ownership must match; a result alone or a newer binding cannot carry authority forward. Failure results retain the unchanged original scope. The same consumed marker/outbox transaction prevents a second batch or repeated selection. See remote-control-selection-commands-v1.md.

## Creation transition results

Telegram /new retains the original delivery revision and unchanged binding. Its private creation proof certifies exactly one session addition and revision advance, original native receipt and creation policy. Only the exact committed after-principal can consume its result. Outgoing records use that new revision; a result alone cannot grant authority. Later permission edits, creations, selection or revoke fence the proof. Atomic result-marker/outbox behavior is unchanged. See remote-control-creation-commands-v1.md.

## Delivery and recovery

The independent outbox sender owns external delivery receipts. Definite rate limits follow existing bounded retry rules; ambiguous sends remain uncertain across restart. A consumed command marker does not mean Telegram received the reply. Unknown delivery never causes native redispatch, automatic resend or a guessed edit target. Trusted outgoing receipt review is separate from native command reconciliation.

Fixtures exercise exact-scope rejection, batch rollback, lost-ACK retry, process death after commit, uncertain cancellation and owner reconciliation, Unicode/history limits and actual loopback HTTP uncertainty. A genuine native deterministic-provider composition also reads tail and earlier history pages, sends their committed results and reopens the gateway without another provider call or duplicate send. This is not a real bot/model trial or a complete native Host process restart.

## Saved automation results

Private /automations and /automation results use closed native Schedule projections, never generic accepted JSON. Reads cache the original versioned cut. Successful controls additionally require the private full-delivery proof and exact current authority before atomic reply consumption. A failed send never repeats a view or control. Replies distinguish historical control receipts, native run admission and task completion. See remote-control-automation-commands-v1.md for forms, rendered budgets and original-proof-only recovery.
