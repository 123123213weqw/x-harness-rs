# Scoped native session creation

Status: Stage 1 trusted library and desktop capability composition. Native disk-journal and gateway fixtures cover creation, original-receipt recovery and grants. Desktop complete-grant controls configure explicit creation capabilities atomically. Normalized Telegram creation and exact revision-transition replies are composed; mobile transport remains pending. See remote-control-creation-commands-v1.md. This is not real-platform or paid-model acceptance.

## Authority and identity

Creation is separate from permission to operate an existing session. CreationPolicy is a trusted desktop-composition record with a principal permission revision, monotonic policy generation and an explicit subset of that principal's workspace allowlist. No policy means no creation. An empty set disables creation. A normal principal edit invalidates the old policy revision; only a successful creation carries its existing policy into the newly committed permission revision. Policy edits require an exact next generation.

The authenticated Subscription supplies Host-bound principal, channel/account/user, conversation, binding ID and current binding generation. The controller supplies only a stable request ID and registered workspace ID. A domain-separated SHA-256 over Host, principal, verified sender, conversation and request ID determines the native session ID and original receipt identity. Workspace is excluded from the dedup key so changing the workspace under the same identity conflicts instead of creating another session. Binding ID and generation are excluded so an already granted result can be recovered after an authenticated selection change; a pending attempt still requires its exact original binding and principal revision.

No cwd, model, preset, local path or controller-selected native session ID is accepted. Creation requires current bound-session ownership and an explicitly permitted registered target workspace. The normal native default model, preset and permission initialization remains the owner; creation admits no user prompt, tool call or new model turn. Ordinary recovery of previously admitted native work remains Host-owned.

## Native proof

ApiBackend exposes create_scoped_session and scoped_session_creation_receipt as trusted in-process seams, outside the public RPC directory. Unsupported backends fail closed. The native per-session admission fence serializes creation, receipt reads and ordinary named-session creation for the deterministic ID.

The native initialization batch contains its normal policy events and a SessionMutationCommitted receipt with the exact original creation fingerprint and path-free response. An existing ID or matching cwd is never enough to adopt a session. Ordinary desktop-created collisions, bare headers, mismatched fingerprints, malformed keys, archived/deleted sessions and unregistered workspaces fail closed. The receipt reader does not hydrate or wake the target session. It validates authoritative header ownership, original receipt identity and current registration, then crosses an explicit native durability barrier that must cover the captured journal revision. Logical visibility after a failed flush is not durability proof.

An empty header left before the initialization append is ambiguous. It is not reset, completed with new defaults or granted automatically. Recovery requires native repair or verified original state; a fresh identity creates a different session rather than reusing the ambiguous one.

## Gateway commit and recovery

The gateway commits an immutable authenticated creation record before the native effect. A bounded owned task retains the principal write fence independently of the controller waiter. Thirty-two global owned attempts provide explicit backpressure; every native scope/receipt read and creation response wait has a two-second deadline. A creation wait timeout does not cancel the owned native writer or drop its admission fence: the writer retains the same drain slot until its actual append/flush settles, while the gateway records uncertainty without a grant. Shutdown waits for that accepted writer rather than releasing storage under it. The final SQLite job carries its owned permission fence through FULL commit or rollback even if its caller disappears. Gateway shutdown closes new creation admission and drains all owned creation slots before releasing its WAL consumer; concurrent shutdown waiters cannot miss the drain notification.

| Stored state | Recovery behavior |
| --- | --- |
| Dispatching | Read the exact native original receipt. Verified absence allows the same deterministic native creation; an unavailable or conflicting receipt does not. |
| Uncertain | An exact original receipt can reconcile the effect. Verified absence alone never replays an already uncertain creation. |
| Granted | Return the original stored result only while the current authenticated principal still grants the target and native original proof/ownership remains valid. Never create again. |

A backend success is not sufficient: the gateway rereads the original durable receipt and validates target ownership through the native registered workspace/session seam. Missing, wrong, unregistered or unavailable proof produces a durable uncertain result with no grant expansion. No native error text, path or model metadata is returned to the controller.

On success, one FULL transaction adds exactly the created session to the existing allowlist, advances the principal permission revision, carries forward the explicitly permitted creation policy and commits the granted result. The original request scope and revision remain immutable. Binding and generation are unchanged; switching to the created session is separate authenticated selection. Telegram /select has its own durable inbox transition proof; /new uses a separate exact additive permission-transition proof for its result reply. A lost completion reply is resolved by the same request identity, not by generating another one. granted_revision records the grant's commit revision, not the latest revision after subsequent edits.

Permission revision changes fence old queued commands, output snapshots and subscriptions under the existing gateway contract. Already accepted native Agent work is not cancelled. Telegram composition refreshes authoritative scope, handles the creation result through its private additive proof and carries proven projection continuity before optional selection. It never presents old fenced snapshots as current state. Mobile composition remains required.

## Verification and remaining composition

Gateway fixtures cover default denial, policy subset/CAS/removal, stale principal policies, exact transport identity, request conflicts, binding preservation, revision updates, reopen, selection, revocation, caller disconnect, lost native acknowledgements, forged/unregistered proofs and uncertain no-replay.

Native composition uses a real JsonlSessionStore and fresh Host/runtime/store objects across disk reopen. It verifies original policy-plus-receipt persistence, no journal append on retries, one original native creation after a lost acknowledgement, twenty concurrent idempotent native creations, ordinary-ID collision rejection, bare-header rejection and failing/regressed durability barriers. A fixture provider panics if invoked; successful trials make zero model requests. These are native object restart and disk fixtures, not process-kill, real-channel or paid-model trials.

Desktop complete-grant controls and multi-session editing now configure default-off creation capabilities; see remote-control-grants-v1.md. Telegram normalized creation and durable replies now compose the primitives. Mobile catalogue/selection/creation, uncertainty administration and actual channel/model/native OS/CI acceptance remain unfinished. See the creation acceptance checkpoint for the frozen-source regression.
