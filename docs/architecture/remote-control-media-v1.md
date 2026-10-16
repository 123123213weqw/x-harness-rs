# Scoped remote attachment output

Telegram output now queues event-owned attachment references alongside plain-text/status replies. The native session journal and attachment store remain the byte owners. The gateway resolves those references under current authorization before the external send; neither a message body nor a platform transport can select a local path, reference owner, URL or provider file ID.

## Native event proof and byte ownership

ApiBackend.session_event_attachment is a narrow trusted capability with a fail-closed default, not a new public RPC method. BasicHost requires an authoritative runtime and a registered workspace/session pair. The requested exact event sequence must contain the requested SHA-256 attachment ID in native user/assistant content blocks or typed tool-result metadata. Presence in the same session's attachment directory is insufficient. There is no history-cache or arbitrary store fallback.

A fork can resolve an ancestor-owned reference only when that reference actually occurs in the authorized child's native event. The reference's complete stored metadata must match the resolved record. Native identity and durable-head checks reject wrong sessions or regressed journals; workspace ownership is checked again after the read. The native bound is 4 MiB decoded bytes, with nonempty payloads. Attachment-store image validation remains the native owner's responsibility.

The API result has a closed image/file kind, MIME type, image dimensions, content hash and bytes. Debug output redacts the bytes. No file path or caller-selected reference owner crosses this seam.

## Durable outbox and sending fences

ReplyBody has an optional attachment containing only event_seq and id. Missing fields default to None and None is omitted during serialization, preserving older text/button body fingerprints. This is private trusted producer state, not remote ingress. Media records permit a plain caption of at most 1024 UTF-16 units, no inline keyboard and no edit target. Text edits cannot target previously delivered media records.

Projection cursor/state/outgoing references and explicit history-result markers/outgoing references retain their existing atomic FULL transaction. Binary bytes are not duplicated into the remote journal: the native durable attachment store must retain them while pending delivery is needed. The native ID pins the payload across a definite rate-limit retry. Native image storage references use SHA-256 of bytes; native file storage references with zero dimensions use SHA-256 of the existing xharness-file-v1 domain prefix, MIME type, separator and bytes. A native file-storage ID is not the plain image-content hash. Displaying an image reference as a file keeps its image-storage ID and sends it as a document. Deleting native media can make a pending send unavailable; it cannot turn unavailable bytes into delivered media or justify rerunning a native command.

The sender holds existing recipient/account/principal fences, validates native scope, then resolves the exact event reference with a two-second deadline before claiming sending. It checks the returned ID, nonempty 4 MiB bound, SHA-256, MIME token grammar and image metadata, and rechecks native ownership. Resolution errors leave the record pending and surface a closed account-worker failure, with no provider effect. A cancelled worker does not claim sending after this read. No Host/Agent API is available to ReplyTransport.

Once sending is committed, normal outbox recovery owns delivered/rejected/uncertain states. Only a definite provider rate-limit response permits bounded retry. Disconnect, deadline, server/malformed/wrong-recipient response or interrupted sending remains uncertain across restart; there is no resend, guessed receipt or Agent replay. Native command completion and a queued attachment do not imply external delivery.

## Native projection and Telegram uploads

Shared native projection preserves both image and file references in tool results and message content instead of discarding file blocks. Live Telegram output queues assistant/tool attachments; it does not echo incoming user media. An explicit history request can queue the user, assistant and tool media in that requested page. Stable identities include the producer's checkpoint/result identity, exact native sequence and block index. These records count toward the existing 64-record batch limit; excessive media fails or reduces a contiguous forward cut, never silently drops an attachment.

Telegram uses the official multipart byte-upload methods [sendPhoto](https://core.telegram.org/bots/api#sendphoto) and [sendDocument](https://core.telegram.org/bots/api#senddocument). PNG/JPEG native image blocks satisfying the photo dimension/ratio constraints use sendPhoto. Other supported image formats or oversized photo dimensions use sendDocument, preserving the native bytes as a file. Native file blocks use sendDocument even when their MIME is an image. No URL download or provider file-ID reuse is accepted.

Captions are plain text without parse mode. Upload names are generated as attachment plus a bounded known extension, not copied from native names or local paths. Document uploads disable provider content-type detection. Responses require the intended positive private chat and a positive message ID; mismatch is uncertain, not success. Production endpoints remain fixed HTTPS with redirects disabled; HTTP is only an explicit loopback fixture capability.

## Verification scope

Native deterministic-provider composition, exact event/store proof, actual multipart HTTP and durable uncertainty fixtures are distinct from real account/model acceptance. Required real Telegram round trips, native Host process restart trials, native OS keyring/application checks and cross-platform CI execution remain release gates. Gateway reopen alone does not prove a complete native Host process restart.
