# Durable remote saved automation commands

Remote Control uses the existing Schedule owner to inspect and control saved automations in the selected native session. Telegram accepts closed private-chat command forms. Creation and editing remain ordinary authorized chat requests through the existing automation tool, not a second scheduler or a generic remote RPC.

## Command forms and scope

- `/automations` lists up to 25 saved entries with 160-character Unicode prompt previews.
- `/automations {"after":"exact saved ID"}` continues the exact-ID ordered list.
- `/automation {"action":"view","id":"exact saved ID"}` returns a full saved prompt and the latest 50 run statuses with total and admitted counts.
- `/automation {"action":"pause","id":"exact saved ID"}`, `resume` and `delete` control future triggers through native Schedule.

IDs are exact nonempty strings of at most 512 UTF-8 bytes without control characters. Commands reject positional aliases, extra fields, null IDs, create/update/list actions and attached media before downloading it. Sender identity, workspace, session, principal revision, binding generation and native request key come from authenticated durable intake, never controller-supplied JSON. A command cannot grant child-session access or move the current binding.

## Reads and cached results

The gateway verifies the current exact principal and full binding before entering the selected-session FIFO. Native reads have a two-second deadline and require a closed result matching the original query and native scope. Successful reads persist a versioned typed result. Unavailable or malformed native results produce a closed failure without raw diagnostics.

Reads have no Schedule effect and a dispatching read may retry after a process cut. Once its result commits, neither a failed reply nor a gateway restart performs another native read. List previews and full views retain the native bounds; Telegram renders plain text with JSON-quoted prompts and explicit continuation. The rendered view is bounded to 200000 UTF-8 bytes and a reply batch to 64 parts of at most 4096 UTF-16 units each. Escaping or formatting can exceed this budget even when the native prompt fits. That case returns a closed budget message, not a partial view.

## Control admission and original proof

The immutable durable delivery determines a domain-separated native request key. Before the first effect, the gateway saves a private attempt with the exact request. It asks for an original native receipt before reading the current target. Only when that receipt is absent and the original attempt remains dispatchable does a native view confirm that the target is scheduled, overdue or paused. A failed preflight completes a sanitized failure without issuing a control.

Immediately before invoking a native control, a FULL transaction seals the attempt against replay. A cut before the call begins can therefore leave an unresolved outcome rather than risk duplicating a control. The actual writer is owned independently of the waiting caller. Creation and automation control share 32 gateway slots. The writer retains the original principal read fence, selected-session FIFO and slot through its actual completion, even after the two-second response deadline. Gateway close drains those writers before releasing SQLite ownership; revocation waits for admitted writers, then fences subsequent access.

Success requires a matching closed native result and an equal original native receipt. The gateway atomically commits the completed result, sealed attempt and private full-delivery proof. A structural DTO alone is not delivery authorization. Reply consumption requires the private proof and the exact current principal revision and full binding, then atomically commits the consumed marker and recipient-FIFO outbox batch. No authority revision or binding transition is introduced.

## Uncertainty and recovery

Timeout, lost acknowledgement, missing or mismatched original proof produce an uncertain delivery with no success result. Recovery reads only the original native receipt; it never repeats the control or adopts the current rule state. Creation and automation controls share a bounded 32-entry recovery scan with cursor wrap and per-session FIFO. Uncertain effects block their own session, not unrelated sessions.

An original pause receipt remains a historical pause receipt after a later resume or delete. Its reply explicitly distinguishes original operation outcome from current state. Pause and delete do not cancel runs already admitted by native Schedule. Admission counts are not completion counts.

Desktop manual `ObservedAccepted` is not native control proof and is rejected for these mutations. Audited abandonment without replay remains available. Revoked or changed authority prevents even native receipt/scope recovery queries. Missing private reply proof fails closed without rerunning a completed command.

## Acceptance scope

Remote fixtures cover cached reads, full authority preservation, atomic consumed replies, receipt-only recovery, absent proof, closed preflight, revocation, private proof corruption, caller abort, deadline drain and a sealed dispatching cut. A genuine native fixture exits its child process with code 88 after the Schedule append and original receipt flush but before gateway completion. Fresh Host, runtime, JsonlSessionStore, ScheduleManager and gateway objects recover the original receipt without another control, view, journal append or model call. Loopback Telegram HTTP intake retains its offset, and an HTTP 500 reply remains uncertain without another send after a second reopen.

This is deterministic native and loopback acceptance, not SIGKILL, live Telegram, real-model or native OS acceptance. Mobile automation UX, persistent activation, uncertainty administration, Weixin iLink, Feishu and separate Lark, real account/model and required cross-platform CI gates remain part of the active Goal.
