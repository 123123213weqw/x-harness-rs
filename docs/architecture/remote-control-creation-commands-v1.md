# Durable channel session creation

Private Telegram /new creates a native session only under an explicit desktop creation capability. The original inbox identity determines native creation identity. One FULL gateway transaction adds exactly that session, advances permission revision, preserves the conversation binding and records the completed original result with private transition proof. Creation does not select the new session. This is Stage 1 native and protocol composition, not real-account or paid-model acceptance.

## Closed input and native ownership

Telegram accepts /new {"workspace":"registered-workspace-id"}. The one-field JSON object preserves IDs containing spaces. Positional arguments, unknown fields, empty/control-containing/oversized IDs and accompanying media are durably rejected before downloads. Text cannot choose a request ID, native session ID, cwd, model, principal or permission revision. Verified platform update identity supplies the immutable inbox key; a domain-separated inbox request namespace derives the deterministic native receipt identity.

Admission requires the current authenticated principal, sender, conversation, full original binding and registered bound-session ownership. Creation is default-off. Its explicit revision-bound CreationPolicy must include the requested workspace, which must also belong to the principal. A synthetic grant already containing the expected future native ID is rejected before the effect: a successful transition must add exactly one previously absent session.

Host remains the creator. Native normal policy initialization and the original creation receipt commit in one durable batch under its admission fence. The narrow creation and receipt seams are trusted in-process capabilities, not arbitrary RPC or an Agent prompt. Creating a session makes no new model turn.

## Owned dispatch and recovery

Dispatch takes the original session FIFO and principal exclusive gate without upgrading a read lock. The shared 32 owned creation slots apply to trusted primitives and normalized commands. Dropping the caller does not cancel the owned task or final FULL transaction. Native reads and response waits have two-second deadlines; an accepted native writer retains its slot and admission fence until its actual append and durability barrier settle. Shutdown closes admission and drains these writers before releasing journal ownership.

The initial transaction stores the immutable creation reservation and changes queued delivery to Dispatching together. Dispatching recovery reads the exact original receipt first; authoritative absence may invoke the same deterministic idempotent native create. Once Uncertain, recovery only reads that receipt and never reissues native creation. Missing, malformed, foreign or unavailable proof cannot expand the grant. Successful backend return alone is not proof: the original durable receipt and current native ownership must agree.

The supervisor polls eligible uncertain creations once per second in bounded pages of 32, advancing a sequence cursor and wrapping at the end. Ordinary queued work remains independently scheduled. Uncertainty blocks later work in the same original session but does not starve other sessions. Occupied shared creation slots cause deferred retry, not fatal worker failure. Recovery never changes request identity or selects another workspace to obtain a success.

A native observed-accepted manual shortcut is prohibited for creation because it cannot certify the original session or permission transition. Trusted abandonment preserves audit and prevents automatic retry; it does not grant the session or authorize another effect.

## Atomic grant and reply authority

The final FULL transaction checks original authority and adds exactly the proven native session. It advances principal revision once, carries the same permitted creation policy to that revision and commits the granted creation record, closed ControllerCreated result, complete-delivery fingerprint and private before/after principal proof together. Original inbox scope and permission revision remain immutable. Binding ID, target and generation are unchanged.

The successful result reply is permitted only in the exact committed after-principal and unchanged binding. Its private proof must certify the entire original delivery, native receipt, policy, stored creation record and strict one-session before/after delta. A plausible typed result or a forged lookup row cannot confer authority. Candidate comparisons preserve the full u64 range using JSON number text. The consumed marker and outgoing batch still commit together; outgoing records carry the new revision, not a rewritten inbound scope.

The plain-text reply states the new session ID, workspace, committed permission revision and unchanged current session, with an exact JSON /select command. Generic accepted results are not creation receipts. Subsequent permission edits, revocation, another creation or selection fence an unconsumed historical reply. Cached completed dispatch returns historical result without rereading native state; it is not current reply authority. Ambiguous provider delivery stays uncertain with recipient FIFO, without another creation or guessed resend.

Ordinary permission and creation revisions cannot wrap. At u64 maximum the permanent revoke operation saturates the revision while irreversibly setting revoked under the owned gate; the revoked bit and gate epoch fence scope, and the principal cannot be resurrected. This exception permits revocation, not another grant transition.

## Projection continuity after additive creation

An exact private creation proof certifies a parent principal revision. When the new revision has no target checkpoint, the gateway may follow only these certified one-session additive parents to a previously initialized checkpoint for the same Host, sender, conversation, binding ID and target. Each step removes one session and the walk is bounded by the allowlist. A target absent from the parent has no inherited output.

The source descriptor must authenticate its checkpoint and source revision. Restored cursor, formatter state and rendered parts become a new current-revision checkpoint with old edit links and pending-send references cleared. This preserves both the current target and earlier visited targets through consecutive certified creations. A newly created target still starts at zero. Ordinary manual permission edits cannot borrow continuity; corrupt provenance fails closed. Old outbox records and their uncertainty remain unchanged.

## Verification boundaries

Gateway tests cover default denial before native reads, exact additive grant/result/proof, cached completion and reopen, lost ACK and original-receipt-only recovery, forged/absent/foreign proof, caller abort, actual deadline and native-writer drain, supervisor recovery with independent-session progress, bounded round-robin pages, manual recovery restrictions and multi-revision projection continuity. Internal tests cover private-proof forgery and complete u64 transitions with permanent revocation at exhaustion.

A BasicHost, DurableLoopAgentRuntime and JsonlSessionStore child fixture admits Telegram-shaped loopback /new, persists the original native policy/receipt and exits with std::process::exit(87) before the gateway grant. Fresh native objects and the real supervisor recover the original proof with zero additional native creations. They restore the actual prior projection cursor, persist one uncertain HTTP reply, reopen again without duplicate receipt reads/create/send, and select the created session separately. The provider counter stays zero. This is abrupt process exit and native disk recovery, not SIGKILL, a production Telegram account or real-model acceptance.

Mobile creation transport, capability discovery UX, inbox recovery UI, schedules, persistent activation, other channels, executed native OS/CI and real account/model acceptance remain in the active full Goal.
