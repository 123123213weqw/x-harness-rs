# Weixin iLink transport

Independent protocol implementation. Runtime dependencies point only to
`xharness-remote`, plus HTTP/serialization/cryptography libraries. This does not
embed OpenClaw or another Host, Agent, scheduler, or credential file format.

## Authoritative reference

Protocol snapshot inspected on 2026-10-13:
[`Tencent/openclaw-weixin`, `8a765518a7fea697194943130e063f0b2cb88e29`](https://github.com/Tencent/openclaw-weixin/tree/8a765518a7fea697194943130e063f0b2cb88e29).

- [Backend protocol](https://github.com/Tencent/openclaw-weixin/blob/8a765518a7fea697194943130e063f0b2cb88e29/docs/protocol_zh_CN.md)
- [QR implementation](https://github.com/Tencent/openclaw-weixin/blob/8a765518a7fea697194943130e063f0b2cb88e29/src/auth/login-qr.ts)
- [HTTP request construction](https://github.com/Tencent/openclaw-weixin/blob/8a765518a7fea697194943130e063f0b2cb88e29/src/api/api.ts)
- [Media upload](https://github.com/Tencent/openclaw-weixin/blob/8a765518a7fea697194943130e063f0b2cb88e29/src/cdn/upload.ts)
- [CDN URL construction](https://github.com/Tencent/openclaw-weixin/blob/8a765518a7fea697194943130e063f0b2cb88e29/src/cdn/cdn-url.ts)

This first-party document describes client behavior, not an exhaustive stable
server contract. Old community/ZCode snapshots using GET for QR creation are
not the current POST request used here. `bot_agent` identifies XHarness; no
OpenClaw runtime, installer, account, or false application identity is required
by this implementation. Whether the server admits an independent XHarness
version is a real-account acceptance gate, not a fixture assumption.

## Implemented protocol surfaces

- Explicit QR creation, poll-once, all documented status outcomes, one-use login
  session, verification-code flow, bounded first-party redirect handling.
- Confirmed token/API base/Bot/scanning-owner identity for trusted native storage.
  QR state alone does not create a workspace or session grant.
- Authenticated `getupdates` returning raw messages and an opaque batch cursor.
- Text sends with mandatory incoming context token and caller-owned client ID.
- Bounded image/file/video CDN upload/download and separate chat-send intent.
  Protocol AES-128-ECB/PKCS#7 and MD5 are confined to the media wire format.
- Private peer normalization, pure images, platform voice transcription (no
  extra ASR service), no groups or arbitrary local paths.
- Bounded JSON/media, HTTPS first-party origin checks, no HTTP redirect following,
  closed/redacted errors, request cancellation, no implicit send retry.

`loopback_fixture` endpoints are explicit trusted test construction only and
cannot access another origin. Production credentials, QR nonces, context tokens,
signed URLs and encryption keys must not be published or sent to a relay.

## Deliberately not composed yet

This crate is a transport, not a running channel. It does **not** persist account
configuration, start a worker, advance durable cursors, grant authorization,
dispatch commands, subscribe to Host output, emit approval tickets, or complete
an outbox receipt. It does not certify real account availability, stable token
lifetime, arbitrary friend/group access, or real model tasks.

Composition must:

1. Store the confirmed Bot token in the original native secret-store seam and
   only persist a reference in account settings. Bind the confirmed scanning
   owner explicitly to permitted workspace/session scopes.
2. Acquire the existing account lease/revision fence before polling. An inbound
   authenticated `(channel, Bot account, peer)` resolves a trusted route; message
   text or provider `session_id` never selects a native session or principal.
3. Durably admit/reject **every message in a batch before advancing its opaque
   cursor**, including empty batches. Telegram's per-message numerical offset is
   not interchangeable with iLink's batch checkpoint. Partial admission, crash
   and replay need one gateway transaction/proof, not an early in-memory update.
4. Download media only after sender authorization; pass bounded normalized
   content through existing Host ingestion and revalidate admission afterward.
5. Persist original context plus immutable send intent before any chat mutation.
   `AmbiguousSend` requires trusted reconciliation, not automatic re-sending even
   with the same `client_id` (server idempotency is not certified).
6. Drain/fence old workers on disable, revocation, credential rotation or account
   takeover. Session expiry requires explicit user re-pairing, not a background
   loop that invents a new identity or reuses a grant for another Bot.

## Manual acceptance

The user must scan in their own Weixin app, confirm authorization, and enter a
displayed verification code only in the initiating trusted setup view. No token,
existing password or private message needs to be pasted into a chat.

Use one disposable account binding and one consumer. Confirm Bot identity and
the owner, select a test workspace/session, then test text, pure image and file
round trips. Repeat three trials with Host restarts. Verify duplicate delivery,
cancel, scope changes, disconnect, session expiry and account takeover; reject
unauthorized peers without downloading their media. Original approval/question
and outbox recovery must also be accepted after production composition exists.
Real model trials remain a separate explicitly authorized gate.

The current unit/HTTP tests prove wire behavior and crypto vectors only. Compile
and test remotely under the repository's Rust policy; never compile this crate
on the local desktop. No success is claimed until those tests actually run.
