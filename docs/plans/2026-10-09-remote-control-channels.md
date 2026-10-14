# Remote Control and Bot Channels completion goal

Implement XHarness-owned remote control for mobile Web, Weixin iLink, Feishu/Lark and Telegram. Controllers operate existing Host sessions and automations; they do not create another Agent runtime or copy project files into the relay. Completion requires actual channel acceptance, not only a dialog or simulated transport.

## Scope

- Mobile Web: QR/link pairing, workspace/session selection, history and live output, new sessions, additional instructions, cancellation, approval responses, attachments and automation inspection/control.
- Weixin iLink: account pairing, message polling, text and supported attachment reception, task replies and reconnection.
- Feishu/Lark: platform app credentials, user binding, persistent event transport, streaming reply cards and interactive approval/question responses.
- Telegram: bot credentials, user binding, long polling, replies, buttons and supported attachments.
- Desktop settings: channel setup, connection status, allowed workspaces, controller list and explicit revoke/disable/delete actions. Keep the established monochrome design and Chinese/English copy.
- Automation linkage: submit scheduling requests through existing chat/Agent behavior; inspect and control saved schedules through the existing Schedule boundary. Remote control does not become a new model tool.

## Verified starting point

Baseline: upstream master `3bb07163227ef3d93cfdbef96b9b893970a60b24`.

`xharness-server` provides unary JSON HTTP RPC plus two downlink WebSocket streams over `xharness_api::ApiBackend`. Host already owns session admission, persistence and projection. Its automation UI adapter deliberately rejects create/update; chat currently creates and edits automations through the existing tool. These interfaces are reuse points, not evidence that remote channel authentication or crash-safe inbound delivery already exists.

The starting source inventory found no dedicated Weixin, Feishu/Lark or Telegram channel implementation. The current desktop launch token is not a remote pairing credential and must not be exposed as one.

## Architecture and ownership

```text
Mobile Web                  Weixin / Feishu / Lark / Telegram
    | HTTPS/WSS                         | platform protocol
Pairing and relay transport              Channel adapters
    |                                   |
    +---------- scoped control gateway -+
                         |
              existing Host API boundary
                         |
         Session / Runtime / Projection / Schedule
```

- Channel adapters own platform authentication, transport, serialization, attachments and reply formatting. They do not mutate Host state directly.
- The control gateway owns principals, workspace/session scope, normalized commands, inbound delivery records, outgoing delivery records and channel-to-session bindings.
- Host remains the session/runtime owner. A thin composition adapter calls existing public entry points. No platform-specific polling loop or card renderer belongs in Host/Core.
- The relay owns pairing and bounded forwarding, not model API keys, project storage or Agent execution. A Host initiates the outbound connection; opening a router port is not required by the design.
- UI owns presentation. Hiding a view or losing a phone connection does not cancel accepted work.

New crate boundaries and dependencies must be added to the executable architecture policy. Choose final names only after the contract review; do not create one giant Bot service.

## Security and delivery requirements

1. Pairing is short-lived and single-use. Exchanging a pairing secret creates a separately revocable controller credential. Credentials and model keys never appear in public URLs, logs or screenshots. Define relay visibility explicitly; do not claim end-to-end encryption without implementing it.
2. Authorize every operation and event subscription against a principal, Host and registered workspace/session. Possessing a session ID is not authorization. Directory browsing, arbitrary RPC forwarding, settings mutation and credential mutation are not implicitly exposed.
3. Bind platform sender identity to the controller. Group chat behavior is explicitly opt-in; message text alone cannot select another user's task or grant access.
4. Persist stable platform/request identities and admission results. Advance platform receive cursors only after durable admission or a recorded terminal rejection. Business failure must not silently acknowledge lost input.
5. Reconcile crashes between gateway admission and Host acceptance using stable command identity and existing Host receipts where supported. Add a narrow receipt seam where needed. Never promise exactly-once external tool effects or blindly replay an ambiguous accepted command.
6. Serialize conflicting input per conversation while allowing independent sessions to proceed. One active consumer owns each platform account connection, with lease/fencing and observable takeover.
7. Reconnect with backoff and cancellation. Resume from event cursors; if the cursor is no longer retained, restore authoritative history through the existing projection. Late connection generations cannot write into a new binding.
8. Separate Agent completion from reply delivery. Provider send failure does not rerun the Agent. Outgoing updates are bounded and persisted; an ambiguous platform send is reconciled or surfaced, not hidden as certain success.
9. Bound message, attachment, queue and subscription sizes. Validate media type/content, use existing attachment ingestion and never accept arbitrary local file paths from a controller.
10. Keep model/tool approval policy unchanged. Channel buttons answer a specific pending interaction with a scoped, expiring identity; stale or duplicate clicks cannot authorize another operation.

## Work sequence and gates

### Stage 1 Contracts and durable control gateway

- [x] Isolate the work from unrelated local changes and inventory the current Host/server/Schedule seams.
- [ ] Finish the full normalized command contract and its production composition.
  - [x] Freeze v1 prompt/cancel/history ingress, principal/scope, binding and delivery state transitions in `docs/architecture/remote-control-contract-v1.md`.
  - [x] Implement scoped subscriptions and native once-only interaction tickets, with Telegram notification/callback production composition.
  - [x] Add native filtered catalogue and existing-grant selection primitives with scoped metadata, explicit pagination and binding generation CAS; Telegram catalogue and durable selection transport are composed; mobile transport/UX remains pending.
  - [x] Add explicit revision-bound workspace creation policies, deterministic native original-creator receipts and atomic session grants with disk-reopen recovery; normalized Telegram /new composition now added.
  - [x] Compose desktop capability/multi-session grant UI with complete scope validation and explicit default-off creation policies.
  - [x] Compose normalized Telegram session creation commands and durable revision-transition replies, certified additive projection continuity and original-receipt-only recovery.
  - [x] Add trusted native saved-automation list/view/pause/resume/delete capabilities, original control receipts, owned writer drain and native disk-reopen fixtures; no new scheduler or remote endpoint.
  - [x] Implement normalized saved automation read/control commands and Telegram formatting with original receipt recovery.
  - [ ] Implement mobile creation and automation transport.
- [ ] Finish durable intake and recovery control surfaces.
  - [x] Implement persistent normalized intake, authorization, cancellation, Host durable receipt reconciliation and revocation in `xharness-remote`.
  - [x] Add atomic platform rejection/cursor dispositions, account generation fencing, trusted uncertainty resolution/audit, and opt-in private executable supervisor with actual disposable process lifecycle tests.
  - [x] Add trusted desktop setup/private scope/revoke/outbox-recovery UI.
  - [ ] Complete transport composition for the full normalized command set; mobile transport remains required.
    - [x] Compose metadata-only inbox review UI and exact-identity client validation; nine contract cases and Chromium/WebKit protocol fixtures pass.
    - [x] Verify native inbox/ticket audit/seal fixtures; current-source results are maintained in the acceptance summary. Mobile production composition remains unfinished.
- [x] Pass crash, duplicate-delivery, concurrent-input, stale-binding and revoked-principal library tests on WZU_Server before connecting providers. See the consolidated acceptance summary for current verification; fixtures do not certify real providers/models.

### Stage 2 Telegram adapter

- [ ] Implement credential references, private sender binding, polling/offset recovery, replies/buttons and attachments.
  - [x] Independent official Bot API wire client and normalization: getMe/webhook conflict check, getUpdates, send/edit, callback receipts and bounded media download; HTTP fixtures only.
  - [x] Implement durable Intake polling, committed offset recovery, trusted sender-to-binding resolution, bounded photo/document normalization, backoff/cancellation and account fencing with actual HTTP + SQLite fixtures.
  - [x] Add narrow Host session stream and gateway permission-revalidated, bounded, sanitized-gap subscriptions; actual Host + fixture tests, no model or platform account.
  - [x] Implement independent atomic persistent text/button outbox, scoped sender worker, uncertain-send recovery/audit and Telegram lossless long-text transport; HTTP/crash fixtures only.
  - [x] Compose native credential/account workers into the opt-in executable, with separate keyring namespace, durable settings/revision fencing, observable states and drain-before-close HTTP/SQLite fixtures. No real bot/keychain acceptance yet.
  - [x] Complete desktop setup/status/outbox-recovery UI and scoped native approval/question tickets with durable Telegram notifications/callbacks; protocol fixtures only.
  - [x] Compose durable assistant text streaming, closed task/tool statuses and authorized forward-history catch-up with atomic projection/outbox checkpoints; deterministic native Host plus HTTP fixtures only.
  - [x] Compose explicit paginated history and closed command-result replies with atomic consumed-result/outbox markers; genuine native deterministic-provider and HTTP fixtures only.
  - [x] Compose event-owned bounded image/file output with native journal/store proof, multipart Telegram sending and durable uncertainty; deterministic native/HTTP fixtures only.
  - [x] Compose durable /sessions pages and /select existing-grant transitions with exact result reply proofs and proven projection continuity; native/protocol fixtures only.
  - [x] Compose explicit /new with default-off native capabilities, exact revision-transition replies and abrupt native process-exit recovery; native/protocol fixtures only.
  - [ ] Complete actual account acceptance; no real bot account is running yet.
- [x] Verify provider error, actual 45-second request deadline, disconnect, redirect refusal, malformed payload and ambiguous send handling against local HTTP protocol fixtures (no real account).
- [ ] Complete a real account round trip with the actual XHarness Host; repeat three times and restart between trials.

### Stage 3 Feishu and Lark adapters

- [ ] Implement the documented platform event transport and credential lifecycle independently; configure platform apps without depending on ZCode-specific provisioning.
- [ ] Implement streaming cards, status/tool summaries and approval/question callbacks.
- [ ] Test both domains, reconnect, duplicate event delivery, stale buttons, long cards and platform rate limits.
- [ ] Complete a real account round trip and restart/reconnect acceptance. Feishu results alone do not certify Lark.

### Stage 4 Weixin adapter

- [ ] Implement supported iLink pairing, polling cursor recovery, text/media input and output.
- [ ] Test credential expiration, pure-image messages, failed admission, long-poll interruption and single-consumer takeover.
- [ ] Verify actual account/API eligibility and complete three real round trips. An inaccessible platform endpoint is an explicit acceptance blocker, not a mocked pass.

### Stage 5 Mobile Web and relay

- [ ] Implement pairing/revocation, an outbound Host connection and a limited relay protocol.
- [ ] Implement responsive monochrome session/automation UI with genuine connection and authorization states.
- [ ] Test history/live equivalence, network changes, event gaps, idle timeouts, cancellation, scope changes and Host shutdown/restart.
- [ ] Test actual mobile browser control through a disposable TLS relay before any production domain deployment.

### Stage 6 Integration and release readiness

- [x] Add bilingual desktop settings, credential setup/status, workspace scope and revoke controls.
- [ ] Persist global activation across application restarts; current service still requires explicit startup opt-in.
- [x] Compose scoped native automation reads/controls and Telegram replies without another scheduler.
- [ ] Accept actual chat-linked scheduling and execution through real accounts/models.
- [ ] Pass remote Rust regression and required cross-platform CI; perform actual desktop runtime acceptance on macOS, Windows and Linux, recording missing platforms explicitly.
  - [x] Wire explicit locked durable-channel, scoped Host and disposable executable test steps into all three existing native PR CI jobs; source-policy tests only, native CI runs still pending.
- [ ] Produce setup/operations/recovery documentation, protocol compatibility policy and evidence for every acceptance gate.

Stages are incremental delivery gates, not a reduced MVP scope. This goal remains unfinished until all required gates pass.

## Acceptance scenarios

For each real channel: pair/bind; list only authorized workspaces; start a disposable task; read genuine streamed/finished output; send a follow-up; answer a scoped approval; cancel; exchange a supported attachment; request an automation and inspect its saved state; interrupt the network; restart Host; inject duplicate delivery; revoke the controller and verify both calls and subscriptions stop.

Repeat normal end-to-end scenarios three times. Record trial identifiers, source revision, platform, actual request/task identity, elapsed time, duplicate task count and failure classification. Store no credentials or unnecessary private message bodies in published evidence. Report protocol fixtures, actual platform integration and model end-to-end results separately.

## Execution limits and current status

- Rust compilation and tests run only on WZU_Server after current-source synchronization with Git, build, environment, key and credential exclusions. No local compilation or automatic fallback.
- No paid model trials are authorized; prior budgets remain closed. Real account credentials must use a local configuration flow, not chat.
- Do not merge, release, restart the production application, deploy a production domain or message another chat without a further request. A stage Draft PR is authorized by the 2026-10-11 request; partial acceptance and Draft submission are not full-goal completion.
- Shared gateway, Telegram protocol composition and bilingual desktop grants/recovery are implemented. Persistent activation, other channels/mobile transport, live account/model and native OS/CI gates remain unfinished.
- Current verification and its limits are maintained in [Remote control acceptance](../acceptance/remote-control.md). Historical stage reports and source snapshots are preserved outside the repository, rather than repeatedly expanding this plan.

## Reference behavior

The design is implemented independently, using documented platform protocols. ZCode is a behavior/architecture reference, not the source of another runtime:

- [Remote Control product behavior](https://zcode.z.ai/cn/docs/remote-control)
- [Bot Channel product behavior](https://zcode.z.ai/cn/docs/bot-channel)
- [ZCode channel sources](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/bots)

The inspected public snapshot contains Bot implementations; the complete mobile QR relay implementation was not found there. Do not treat a Bot fixture as evidence for the mobile Web path.
