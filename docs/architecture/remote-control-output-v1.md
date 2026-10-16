# Durable remote session output contract

Telegram now projects native assistant text and closed task/tool statuses through the existing durable outbox. A forward cursor and formatter state survive account reconnection and gateway restart. This is not a second Agent, a global event subscription, or a replacement for native history. Explicit command-result replies, including paginated history, use the separate atomic result-marker path described in remote-control-command-replies-v1.md. Event-owned attachment output now uses the scoped byte capability and durable references described in remote-control-media-v1.md.

## Native forward pages and permission checks

ApiBackend.session_event_page is a trusted capability with a fail-closed default, not a public RPC method. BasicHost validates the registered workspace/session pair and requires an authoritative Agent runtime. It reads the actual durable session, checks identity and that the durable head has not regressed behind native state, then projects an unfurled contiguous event range. Unlike the message-oriented history reducer, this range preserves assistant deltas even when a final message follows them.

A closed ScopedEventPage records start_seq, next_seq, head_seq and no more than 128 typed session/event frames. An omitted cursor probes the current authoritative head without returning events; a supplied cursor must match the first event sequence. Empty pages cannot claim an unread suffix, and cursors ahead of the journal fail. Encoded pages remain below 2 MiB, returning a smaller contiguous prefix if needed; an oversized first event fails rather than disappearing. Native journal reads currently load the authoritative session on every poll; large-journal performance still needs optimization and measurement without replacing the authoritative head with a stale cache.

The gateway checks the account lease and exact Host/principal/channel/account/sender/conversation/binding/generation, native ownership, two-second native read deadlines, page size, contiguous sequences and canonical typed frame reconstruction. It rechecks lease and unchanged principal/binding before returning. No global mux, arbitrary response or general RPC fallback is permitted.

## Projection checkpoints and atomic outgoing batches

A checkpoint key hashes Host identity, exact Subscription and principal revision. It deliberately survives account-generation rotation but changes with binding generation or authority revision. Its initial cursor is zero: the first authorized binding backfills assistant output in bounded batches, including a prompt that completes before observer startup. A first visit or ordinary grant edit starts a separate authorized backfill. Exact selection revisits and certified additive creation revisions may restore proven continuity as described below; exactly-once external delivery is not claimed.

The checkpoint contains a CAS revision, next event sequence, versioned formatter state, active stream-part links to outgoing records and the last batch's pending record keys. Formatter state is bounded to 1 MiB, links and replies to 64 each, and the projection entity count to 100000. The outbox's existing FULL transaction validates current scope/account and exact expected checkpoint, creates the entire outgoing batch, then stores cursor/state/links together. A conflicting or oversized batch rolls back everything. Metadata-only event cuts can advance the cursor without emitting a reply. No external channel API can supply a raw checkpoint, formatter state or cursor advance.

A crash after commit preserves both the forward cursor and queued replies; a failed commit preserves neither change. Existing durable send-before-effect receipts own external delivery. This projection does not infer that a native admission receipt means an Agent has finished or that Telegram has received a message.

## Telegram rendering and scheduling

The existing scoped observer drives output on a 500 ms timer using the same maximum 32 subscription workers. Its output timer precedes live-frame pulls so a stream of metadata cannot starve durable catch-up. Approval/question frames still use the once-only native ticket path. Live gaps reconnect while preserving the durable projection checkpoint. Account cancellation drains these workers; it does not cancel native tasks.

The reducer coalesces text deltas by native turn and step, keeps at most 32 incomplete streams and 200000 UTF-8 bytes per text, and emits only changed plain-text parts. Native final text replaces partial text. Every part fits Telegram's 4096 UTF-16-unit limit without dropping Unicode. Only delivered predecessor receipts authorize edits; final messages shorter than a partial stream explicitly replace surplus old segments. Output ordering uses native event sequence. If a 128-event cut would exceed the 64-reply batch limit, the formatter chooses a smaller contiguous prefix rather than skipping events. Oversized text fails explicitly, without truncation or cursor advance.

Reasoning, tool argument deltas, usage/finish/provider chunks, raw tool stdout, local paths and provider error bodies are never rendered. Tool calls show only a bounded native tool name; tool results show a closed finished/failed status. Task end renders a closed completion/cancellation/limit/failure status. Native assistant/tool attachment blocks queue separate event-owned media records; incoming user media is not echoed by live output. A queued marker is not a claimed delivery. Unknown text/content shapes fail instead of silently acknowledging unsupported output.

## Uncertain delivery and recovery

Pending or sending predecessors pause further projection until their receipts settle. Uncertain sends remain paused across restart: the observer neither resends them, guesses message IDs, edits an unknown receipt, advances past them nor reruns the Agent. Existing trusted observed-delivered recovery can supply the real provider receipt and unblock subsequent known edits. Rejected or deliberately abandoned predecessors fail the account worker explicitly rather than silently discarding unread output. Account status and the existing outgoing review surface expose that failure; a complete operator recovery UX remains part of the wider Goal.

Optional native ingress fields are omitted when absent rather than serialized as null. In particular, clientTimeZone and beforeSeq must follow native optional-field semantics; unnamed attachment blocks omit name. The native Host composition regression covers a prompt without a time zone and history without a cursor, not just a mock backend accepting null.

## Verification and remaining scope

Fixtures cover contiguous native journal pages and history equivalence, malformed/foreign pages, stale scope/lease, checkpoint CAS and rollback, process death after projection commit, Unicode splitting and final edits, nontext filtering, actual loopback HTTP streaming, unread catch-up on restart, the observer startup race, and uncertain-send pause/restart. A native DurableLoopAgentRuntime with a deterministic provider is composed through Gateway admission, native journal, scoped observer and actual Telegram-shaped HTTP; reopening the gateway repeats neither model work nor delivery. These fixtures do not certify real Telegram or a paid model.

All three native CI jobs require the forward native seam, projection tests and native output composition, in addition to full durable channel tests. Executed CI/native OS acceptance, real account trials, mobile catalogue/create transport and capability-discovery UX, schedules, persistent activation and the other required channels remain unfinished.


## Output continuity after channel selection

The durable Telegram /select transaction may seed a new-generation projection from a prior visit only through the exact Host/principal revision/sender/conversation/binding/target resume descriptor. It preserves the saved cursor and formatter parts, but never reuses old-generation edits or regenerates pending/ambiguous output. A first visit still starts at zero; independently revised grants cannot borrow old continuity. Old outgoing records keep their own recipient FIFO and uncertainty. See remote-control-selection-commands-v1.md.

## Output continuity after channel creation

A private creation-transition proof may certify a strict one-session additive parent revision. New checkpoints can restore the same exact target through a bounded chain of these parents, preserving current and prior visits without rereading rendered events. Source revision and checkpoint provenance must validate; old edit and pending-send references are cleared. First visits to the created session start at zero, and ordinary manual permission edits cannot inherit this continuity. See remote-control-creation-commands-v1.md.
