# Telegram transport boundary (in progress)

The independent `xharness-channel-telegram` crate uses the [official Bot API](https://core.telegram.org/bots/api), not ZCode Bot services or another Agent runtime. Its only production internal edge is `xharness-remote`. The wire client, durable `Intake` poller and independent persistent text/button outgoing transport are implemented; native credential loading/account management now composes these workers into the opt-in executable, with dedicated desktop setup and scoped output/result producers. This is not completed real-account channel acceptance.

## Implemented wire surface

- Verify bot identity (`getMe`) and explicitly reject an existing webhook (`getWebhookInfo`). Never delete a webhook/drop pending updates automatically.
- Long poll `getUpdates` with bounded batches and explicit allowed update kinds.
- Plain-text send, known-message edit, inline callback buttons and callback acknowledgements. No HTML/Markdown injection or URL-bearing button type is exposed.
- `getFile` and bounded streaming media download. The provider file path cannot escape its fixed namespace or select another origin.
- Private-chat normalization ties sender user id to the chat id. Usernames/message text are not identities. Image-only messages are retained. Unsupported/invalid frames with a known update id can be terminal rejection dispositions.
- Strict credential wrapper with redacted Debug. Neither reqwest URLs/errors nor provider error descriptions are exposed. Official requests internally use Telegram's required token-bearing API path; tokens are never public pairing links or report fields.
- Provider send transport/server/malformed-response failures are `AmbiguousSend`, never automatic retries. An Agent admission must not be rerun because a reply failed. Known provider rate limits, bad credentials and polling conflicts remain distinct errors.
- Production uses the HTTPS official origin and does not follow redirects. Explicit HTTP fixture constructors accept loopback only, not controller input or arbitrary proxies.

## Durable intake boundary

`Intake::connect` verifies the configured numeric bot id against getMe, rejects an existing webhook, and acquires the gateway account generation. Credential rotation to a different bot cannot inherit its receive cursor. Every getUpdates offset is loaded from the gateway's committed checkpoint, not an in-memory batch counter. The entire batch has strictly increasing known update ids before processing starts. Unknown ids fail without acknowledging earlier elements; malformed bodies with known ids receive durable closed rejection dispositions.

Only verified private sender metadata resolves an existing authorized desktop binding. Unknown senders do not trigger media downloads. The gateway revalidates scope and binding at admission after media I/O; a revoke during a download produces durable rejection, not a new task. Account takeover fences late input. Queue/cancel/history/sessions/select/new/steer use only typed gateway commands, never arbitrary RPC text. Photo-only and document input uses bounded inline content and the existing Host ingestion; unsupported media beside text is explicitly rejected rather than discarded.

Transport/timeouts/5xx reads reconnect with bounded exponential backoff; explicit rate limits honor retry_after. Credential, webhook/poller conflict, malformed response and journal failures terminate the account worker. Cancelling the poller leaves accepted work with the Host-owned gateway supervisor. This does **not** claim that the Agent completed or that a reply was sent.

## Durable outgoing boundary

`Replies::connect` independently verifies the expected bot identity and webhook state. A send validates account, channel, verified sender and canonical positive private chat id before HTTP. A message body cannot select another account or recipient. Outbox-owned edits use only the persisted known message receipt. Plain text is split losslessly on Unicode boundaries with at most 4096 UTF-16 units per part, stable semantic part identities and one atomic batch; over-capacity text is explicit backpressure, not truncation. The typed keyboard permits opaque callback data, not URLs or arbitrary Host response identities. Scoped once-only ticket issuance/consumption and native exact-instance decisions are composed; see remote-control-interactions-v1.md.

Known 429 responses are the only automatic outgoing retry; 401/403/400/404 are closed negative classifications, while 5xx/disconnect/deadline/malformed or wrong-target receipts remain uncertain. The gateway owns durable states, FIFO, scope fences, interrupted-send recovery and evidence audit as described in the remote-control contract. Provider failures never call Agent admission. HTTP + SQLite fixtures retain uncertainty across journal reopen and prove no second send/Agent dispatch. No real bot is running.

## Remaining channel work

The native account manager now loads references only from the separate channel keyring namespace and composes existing intake/outbox workers with observable connection states, revision-fenced disable/rotation and drained shutdown. Scoped native once-only interaction tickets, desktop setup/status/recovery UI and durable assistant text/status catch-up are composed. A decoded callback alone never authorizes a decision: the committed ticket, exact scope and native pending instance must validate. Event-owned multipart image/file output is composed; real channel-level acceptance remains required.

The local HTTP fixture suite covers request shapes, private identity, image-only input, callback chat binding, provider conflicts/rate limits/credential errors, uncertain sends, known edits, message/button bounds and download namespace/size limits. Actual 45-second deadline/disconnect fixtures and gateway-connected intake/outbox recovery suites now pass; a genuine opt-in service + HTTP/SQLite/native-key interface fixture now verifies outgoing interruption drains before journal close. Real system-keychain/account recovery remains pending. The deterministic native Host output composition verifies actual native journal messages and HTTP delivery, but none of these fixtures certifies a live Telegram account, paid model or required real-platform restart trials.

## Durable assistant output

The scoped observer now produces general assistant text and closed task/tool statuses through atomic projection/outbox checkpoints. A first binding backfills authorized durable assistant history from sequence zero; subsequent polls and restart continue the saved cursor. Known delivered streaming receipts support final edits, while an uncertain send pauses projection without Agent replay or guessed message IDs. See remote-control-output-v1.md for byte/event/state limits and recovery. Explicit history-command and event-owned attachment responses are composed; HTTP/native deterministic-provider tests are not real-account/model acceptance.

## Explicit command results

The existing scoped observer consumes committed terminal native results and queues closed plain-text replies with an atomic consumed-result marker. `/history [count [before_seq]]` defaults to 50 entries, accepts counts 1–500 and an optional canonical positive native sequence cursor. Replies render genuine user/assistant text, closed tool status and an earlier-page command without exposing reasoning, arguments, stdout or attachment references. Prompt/cancel admission is not task completion. Unknown native or external delivery outcomes never trigger task replay. See remote-control-command-replies-v1.md for exact-scope checks, bounds and reconciliation.

## Scoped attachment output

The independent sender receives only bytes resolved by the gateway's exact native event/attachment capability. Images/files have durable semantic references and normal uncertain-send recovery, not local paths or URL/provider-file-ID requests. Compatible PNG/JPEG images use multipart sendPhoto; other supported images/files use multipart sendDocument with generated names and plain bounded captions. Live output sends assistant/tool media, not input echoes; explicit history may send media from the requested user/tool/assistant page. See remote-control-media-v1.md for ownership, native hash domains, limits and retention requirements.


## Durable session catalogue command

Private /sessions input requests the first authorized session page. The next-page instruction contains a closed JSON cursor: /sessions {"workspace":"registered-id","session":"last-session-id"}. JSON preserves IDs containing spaces; positional IDs, extra fields, malformed identities and accompanying media are rejected before downloads. The cursor never grants scope or selects a different route.

The gateway journals the normalized command before acknowledging its update, applies existing session FIFO and exact grant/binding checks, persists Dispatching, then calls only the native scoped catalogue capability with bounded deadlines. The completed typed page or closed native failure is durable. A read interrupted in Dispatching may retry the scoped cut after reauthorization; a committed result is never reread because a reply failed. The existing observer commits the consumed result marker and complete outgoing batch atomically.

Plain replies include every session ID and workspace ID in the 25-entry page, current/running/restoring markers and an exact JSON continuation. Human-readable titles are explicitly quoted previews of up to 160 characters, not exact identity or command syntax. Unused workspace labels are not dumped; the text explicitly identifies a session page rather than a complete workspace or creation-permission listing. Durable selection and explicit creation transport are composed; capability-discovery UX and real-account acceptance remain pending. See remote-control-catalogue-commands-v1.md.


## Existing session selection

/sessions includes an exact JSON /select instruction for each entry. Private /select accepts only existing target IDs, validates both allowlists and native metadata, and commits the binding change with its original inbox result and transition reply proof. Selecting the same pair is a durable no-op. A completed request never changes the route again on retry or restart. Revisit projection continuity is provenance-bound, without old-generation edits or ambiguous-send replay. See remote-control-selection-commands-v1.md; real-account and real-model acceptance remains pending.

## Explicit native session creation

Private /new {"workspace":"registered-workspace-id"} requires an explicit default-off desktop creation capability. The immutable inbox identity determines native creation; text cannot supply request/session IDs, cwd or model. Native original-receipt recovery never repeats an uncertain effect. Exactly one session grant, revision transition, completed result and private reply proof commit together while the current binding stays unchanged. Replies identify the created target and include a separate /select command. Proven output continuity survives certified additive creation revisions, not arbitrary permission edits. See remote-control-creation-commands-v1.md for deadlines, owned drain, bounded recovery and abrupt-exit fixture limits.

## Saved automation commands

Private /automations lists saved native Schedule entries in the currently bound session. Closed /automation JSON supports view/pause/resume/delete with an exact saved ID; it does not accept create/update, user-supplied scope or request keys. Media-bearing commands reject before downloading. Natural-language creation/editing remains the existing authorized chat/tool path. Read results are durable cached cuts; uncertain controls recover only original native receipts. Plain replies identify previews, run admission versus completion and historical controls without native diagnostics or child-session grants. See remote-control-automation-commands-v1.md for the full contract and deterministic native/HTTP acceptance limits.
