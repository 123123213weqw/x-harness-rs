# Durable channel session catalogue

Private Telegram /sessions now lists existing authorized sessions through the normalized Catalogue command, native scoped metadata and the existing durable result/outbox pipeline. It does not expose the desktop directory RPC, select a route, expand grants, create sessions or admit an Agent turn. Private Telegram /select now composes an atomic route transition with a durable reply proof; mobile discovery and channel creation remain unfinished.

## Input and scope

The closed Catalogue command accepts only an optional CatalogueCursor. Telegram /sessions requests the first page; a later request uses /sessions {"workspace":"workspace-id","session":"session-id"}. The JSON cursor preserves opaque IDs containing spaces. Unknown fields, invalid identities, extra arguments and media are rejected before attachment downloads. Verified private sender/account/conversation metadata still supplies identity; message text cannot substitute it.

Both cursor dimensions must lie within the current allowlists. A cursor is only an ordering frontier, not proof of ownership or an action credential. Every returned session requires actual registered workspace ownership and both current allowlists. A page is a fresh native cut, not a pinned cross-page snapshot; deletion or archival may change later pages.

## Durable dispatch

The bound-session preflight may hydrate that already authorized native session; recovery of previously accepted work remains Host-owned. Candidate metadata never bulk-hydrates or starts model/title work.

The existing receive transaction commits deduplication, normalized input and account cursor before acknowledgement. Catalogue shares the existing per-session FIFO and exact principal revision/binding snapshot checks. It does not bypass an earlier queued or uncertain operation.

Dispatch owns one principal read fence throughout the operation. The scoped continuation never recursively acquires the fair policy lock, which could deadlock behind a queued writer. It reconstructs the current principal under the original fence, checks cursor scope, verifies the bound native pair with a two-second deadline, commits Dispatching, then calls only ApiBackend::scoped_catalogue with another two-second deadline. Metadata is validated against the actual principal query before serialization. No generic RPC, global events, filesystem browsing or model call is a fallback.

A successful page includes the original principal revision and binding generation. Unavailable, timed-out or malformed native catalogue cuts become durable closed failure results without raw native diagnostics. Unavailable bound-session authority does not certify an effect or a reply; the command remains queued on a failed preflight. Foreign cursors are rejected before native lookup. Revocation/rebinding follows the existing queued rejection or dispatch uncertainty fence; accepted native work is never cancelled by this read.

## Recovery and replies

A crashed or cancelled read left in Dispatching may retry only the same scoped metadata operation after fresh authorization. It never admits an Agent prompt. Completed results, including failures, are returned from the inbox without another native catalogue call.

The existing observer selects one terminal result in its exact current scope. Its FULL transaction checks the immutable delivery snapshot, writes the complete 1–64 outgoing batch and consumes the result together. A failed send or lost acknowledgement cannot cause a second result batch or native reread. Uncertain provider sends remain uncertain across reopen and block later replies until separately reviewed; no automatic resend or guessed receipt is used.

Replies validate the closed page, exact revision/generation, ordering, metadata bounds and continuation. They show every session/workspace ID in the 25-entry page, current/running/restoring markers, exact JSON selection instructions and an exact JSON next-page instruction. IDs are never shortened. Human-readable titles are quoted previews of up to 160 characters with explicit ellipses and a preview notice; they are not command syntax. Unused workspace labels are omitted explicitly because /sessions is a session page, not a complete workspace or creation-policy listing. Empty pages state that no accessible unarchived sessions follow the cursor.

Every plain-text part fits 4096 UTF-16 units. Malformed/over-capacity pages produce a closed failure rather than a partial successful listing. Cached metadata does not authorize another operation; selection and creation retain their separate current-scope and mutation contracts.

## Verification boundaries

Gateway fixtures cover exact cursor scope, closed schema, FIFO, queued revoke, cached completion, atomic result/outbox consumption, caller interruption and disk reopen, native forged/error/deadline results and a queued writer before the native bound-scope preflight releases. Telegram fixtures exercise JSON IDs with spaces, rejection before media downloads, exact cursor/IDs, title previews, metadata order/version validation and durable offsets.

A real BasicHost/JsonlSessionStore plus loopback Telegram protocol fixture composes a 30-session complete grant, private /sessions intake, a 25-entry native cut, durable replies, an uncertain HTTP send, fresh Host/runtime/store/gateway reopen, no duplicate read/send, the final five entries and explicit outgoing review. The original journals remain unchanged and the fixture provider stays at zero calls. This is native object/disk reopen and protocol acceptance, not process-kill, production Telegram or paid-model acceptance. Required native OS/CI, all other channels and real platform/model gates remain active.
