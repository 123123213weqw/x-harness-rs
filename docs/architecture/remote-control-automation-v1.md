# Scoped native saved automation operations

Status: trusted native capabilities and original Schedule control receipts are implemented. The gateway and private Telegram normalized command composition is described in remote-control-automation-commands-v1.md. These capabilities are not externally mounted endpoints or completed mobile scheduling UX. Schedule remains the timer, reservation and execution owner. The full Remote Control and Bot Channels Goal remains active.

## Authority and supported operations

The closed ApiBackend capabilities support list, view, pause, resume and delete for a registered workspace/session pair. Native scope metadata is checked before cold recovery and rechecked under the session admission gate. Backends without authoritative sessions or the narrow runtime capability fail closed. No arbitrary RPC, cwd, credential, model route, scheduler implementation or global schedule enumeration is accepted.

Saved schedule creation and editing remain ordinary authorized chat requests handled by the existing automation tool. The native remote DTOs have no create/update variant. The trusted gateway must supply workspace/session and stable original request identity; future channel text must not be permitted to choose them. The API seam alone is not controller authentication or permission to use another session ID.

Archived sessions can pause or delete saved rules but cannot resume them. Pause and delete affect future triggers and unadmitted reservations, not an already admitted Agent run. Enabled means the rule is unpaused, not that a run started or succeeded.

## Bounded native reads

List returns at most 25 active saved rules ordered by exact ID, with an explicit last-ID continuation when more remain. The Schedule owner folds its authoritative native journal and constructs only the selected page, rather than serializing a global list. List prompts are Unicode-safe previews of at most 160 characters with an explicit preview flag. View returns the complete requested prompt up to 200000 UTF-8 bytes or fails; it never claims a truncated prompt is complete.

Closed entries include native kind, mode, target, state, scheduled time and the relevant interval. View uses the same existing Schedule reducer as the model/card operation, including finished, deleted and inherited state. It includes at most the latest 50 run summaries and distinct total/admitted run counts. Run statuses come from native receipts and actual runtime journals, not model prose. Target-session IDs, creation fingerprints, tool output, provider diagnostics and local paths are omitted; a run summary grants no authority over an independent target chat.

The native list/view reader is read-only apart from a durability barrier. It does not settle pending runs or append schedule facts. Normal Host recovery of saved/admitted native work remains Host-owned; this capability does not directly start a model turn or create a schedule. Existing whole-journal folding remains a native performance concern, not a claim of bounded storage read cost.

## Original control receipts

Pause, resume and delete use a stable remote-automation invocation and fingerprint of the complete trusted request. The Schedule owner serializes them against its existing timer and tool transitions. One native CAS append contains the control fact and SessionMutationCommitted receipt in the same revision, with the receipt last. The receipt response contains only exact rule ID and a closed paused/enabled/deleted state.

A repeated invocation returns its original receipt before consulting current rule state. Retrying an old pause after a later resume therefore does not pause again. Changing the original operation, target or fingerprint conflicts rather than adopting a plausible current state. An inactive or foreign rule fails without a control append. A fresh pause/resume that already has the desired setting still records its own control fact and receipt, so a successful no-op has durable provenance.

The existing pending-run reconciliation remains intact. An inbox-accepted run is recorded before a later control; pause preserves an unadmitted reservation and delete cancels it through the existing Schedule fold. Neither guesses that an admitted task was cancelled.

Logical receipt visibility is not proof of durability. Both mutation completion and receipt reads require flush to cover the captured native revision. Failed or regressed barriers remain unavailable even if an in-memory journal shows the fact. A later original-receipt read can certify that fact without appending or reapplying the control. Native receipt absence is not, by itself, permission for a future gateway to replay an uncertain effect.

## Owned writes and shutdown

Schedule controls share 32 bounded owned slots and an independent lifetime gate. Dropping the waiting API future does not cancel an admitted append or release its slot early. The BasicHost owned task also retains native admission through the control and projection publication.

Schedule shutdown seals new admission, cancels timer owners first, then drains the lifetime gate before joining timers and releasing state. Read/receipt operations also participate in that lifetime gate. A writer stalled after its actual append prevents shutdown from claiming completion until the original native writer settles. No extra scheduler, sleeping Agent or platform worker is introduced.

## Verification boundaries

API fixtures check closed types, default denial, exact workspace/session/result matching, bounded pages and rejection of generic accepted responses. Native Schedule fixtures cover same-key concurrency, original pause after later resume, fresh-manager recovery, foreign/inactive targets, fingerprint conflicts, failed/regressed flush, 32-slot backpressure, caller abort and actual blocked-writer shutdown drain.

BasicHost plus DurableLoopAgentRuntime fixtures verify paginated list/full view, scope rejection, shared Schedule state/projection, archived controls and zero model calls. A genuine JsonlSessionStore trial creates the original native policy/rule/control, closes all original objects, reopens fresh Host/runtime/store/manager objects and recovers the original receipt without another append. A later resume followed by the old pause identity retains the resumed state. These are native object/disk fixtures, not process-kill, real bot/account, native keychain or real-model acceptance.

All three native PR workflow blocks include the scoped API fixtures, full Schedule tests and native Host automation tests. Source-policy checks do not certify executed GitHub CI or Windows/macOS runtime acceptance.

## Production composition and remaining gates

Durable normalized gateway reads/controls, typed inbox results, original-proof-only recovery and private Telegram command formatting now use these native capabilities. See remote-control-automation-commands-v1.md for admission, uncertainty, reply budgets and native abrupt-exit acceptance. Mobile scheduling UX, inbox recovery surfaces, persistent activation, other channels and real platform/model/native OS acceptance remain required. The full Goal remains active.
