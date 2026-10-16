# Durable channel session selection

Private Telegram /select changes only an existing granted conversation binding. The binding change, completed inbox result and private transition proof commit together. The original authenticated delivery stays unchanged, and a completed request never repeats the native metadata check or changes the route again after restart. This is Stage 1 library and native protocol composition, not real-platform or paid-model acceptance.

## Input and authority

The closed Select command carries SessionSelection with exactly workspace and session IDs. Telegram accepts /select {"workspace":"workspace-id","session":"session-id"}; /sessions includes this exact command for every listed entry. JSON preserves IDs containing spaces. Empty, oversized or control-containing IDs, unknown fields, positional arguments, extra text and accompanying media are rejected before downloads. Verified transport metadata supplies account, private sender and conversation; text cannot choose a principal, Host, grant or credential.

Admission retains the existing receive cursor transaction, stable deduplication and original principal revision and binding generation. Selection requires both target allowlists and a registered, unarchived native metadata cut for that exact pair. A cached catalogue page is not permission to select. No cwd browsing, generic RPC, Agent call, cancellation or new session is involved. Native archival after the cut remains possible; later commands and sends revalidate actual native ownership.

## One durable route transition

Dispatch acquires the original session FIFO and then the principal's exclusive policy gate. It never upgrades an existing read guard or calls the public selection primitive recursively. An earlier queued, dispatching or uncertain command in the original session still blocks selection. The command is not an escape hatch around unresolved native effects.

The target metadata read has a two-second deadline. A foreign grant or absent target becomes a durable rejection; malformed, failed or timed-out metadata becomes a sanitized completed failure under the unchanged original scope. These failures admit no mutation and never expose native error details. Generation exhaustion is a durable rejection before lookup. Selecting the current pair is a durable no-op with unchanged generation. Selecting another pair advances generation once while preserving the principal revision, principal ID, binding ID and conversation.

Only the final FULL SQLite transaction changes authority. It rechecks the exact original principal, binding and queued delivery, seeds any proven projection continuation, updates the binding and writes both the completed typed ControllerSelection result and a private selection-receipt entity. The entity fingerprints the entire completed original delivery and records both old and selected bindings. No delivery identity or original scope field is rewritten to look newly authenticated.

Selection never persists Dispatching because all its effects are in this one journal. Cancellation before the final transaction leaves the request queued with no route effect. Once queued, the blocking transaction owns the policy write guard through commit or rollback even if the async caller disappears. A cached completed result remains immutable after later selection or revocation. An unexpected legacy Dispatching selection fails closed as uncertain instead of guessing an effect or repeating it.

## Replies after the binding changes

The ordinary exact-scope command reply path would fence the successful selection's original generation. The candidate query therefore also joins the private transition entity by delivery key. A successful selection may be consumed only when its full delivery fingerprint, typed result, original and selected bindings, current principal revision and full current binding all match. A structurally plausible result alone cannot grant reply authority. A failure result uses only its unchanged original scope.

The existing result marker and outgoing batch still commit together. The formatter validates the closed transition DTO before displaying exact selected IDs and generation; generic accepted=true is not a selection receipt. Outgoing records use the committed target scope, not modified inbound snapshots. Account rotation, revocation, principal revision changes and another binding selection fence these records normally. A proof permits only this selection's own result reply in its immediate committed scope, not historical output, other commands or a chain of future bindings.

An uncertain provider send remains uncertain and blocks later replies for that recipient. Switching sessions neither abandons it nor guesses a receipt. An exact enqueue retry returns the existing records and consumed marker; restart, failed sends and later selections never redispatch the completed mutation.

## Projection continuity on revisiting a session

Each initialized output projection records a private resume descriptor linking the exact Host, principal revision, sender, conversation, binding ID and target workspace/session to its authenticated checkpoint. Ordinary checkpoint advances keep the same reference; the referenced cursor and formatter state are committed with outgoing output as before.

A validated inbox selection may reuse a previous visit only when this full provenance, stored scope, binding generation and checkpoint key agree. Its new-generation checkpoint copies the forward cursor and formatter state, including already rendered streaming parts, but clears edit links and pending-send references. Completed text, tool notices and media are not read again from sequence zero on a revisit. Unchanged streaming parts do not generate new replies; later changed text may create a new message, never an edit using an old-generation message ID.

The old outbox records remain untouched and retain their own uncertainty, rejection and audit rules. Selection does not regenerate pending or ambiguous output from the former scope; explicit /history remains available for deliberate review. A first visit still initializes from zero so a first prompt racing observer startup is not lost. A changed sender, conversation or binding identity cannot borrow this continuity. Ordinary permission revisions cannot borrow it either; exact certified additive creation revisions may inherit target checkpoints through their private parent proof, as described in remote-control-creation-commands-v1.md. Corrupt or conflicting resume provenance rolls back the entire selection, including its binding and completion proof. The standalone trusted controller_select primitive does not acquire this inbox transition contract automatically.

## Verification boundaries

Gateway fixtures cover exact/no-op selection, closed and unavailable target checks, original snapshots, complete grant preservation, cached completion, account generations, older FIFO uncertainty, abort before commit, queued revoke, reply proof mismatch and projection revisits. An internal queued-SQL cancellation fixture polls the actual native continuation to its final blocked transaction, cancels the caller, verifies the retained write fence and observes binding/proof/result together. It also rejects a missing or forged reply proof and rolls back selection against corrupt projection provenance. Full u64 scope comparisons and generation exhaustion have explicit coverage.

The native BasicHost, DurableLoopAgentRuntime and JsonlSessionStore fixture composes private Telegram-shaped HTTP, selection, a fresh Host/runtime/store/gateway reopen before result consumption, exactly one uncertain send, selection back and restoration of the actual native forward cursor. Original session journals remain unchanged, and the fixture model provider stays at zero calls. This is object/disk reopen and loopback protocol evidence, not process-kill, a production Telegram account, native system keychains or a real-model trial. Mobile relay/QR, iLink, Feishu, separate Lark, mobile creation and automation composition, required native OS/CI and real account/model acceptance remain in the active Goal.
