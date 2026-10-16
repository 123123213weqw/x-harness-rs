# Complete desktop remote grants

Stage 1 desktop Settings configures complete existing-session allowlists and an explicit default-off session creation capability. The native management transport and source React view are composed. Telegram /sessions now composes durable catalogue transport; mobile catalogue and channel selection/creation remain separate unfinished transport work; this capability configuration is not real-channel or model acceptance.

## Atomic authority changes

The native-only grant_scopes action requires a configured Telegram account, numeric verified-user target, complete workspace/session lists, an authorized bound pair and an explicit create_workspaces list. It accepts neither cwd nor a model/preset. Empty create_workspaces disables creation. Creation workspaces must be a subset of the complete principal workspace allowlist.

For existing grants, the submitted principal revision and binding generation must match the current records. The creation policy has a separate expected generation, including when its stored principal revision is stale. The server constructs the next versions and writes principal, binding and policy in the same SQLite FULL transaction. A stale principal, binding or policy version, duplicate active sender, wrong bound pair or invalid scope rolls back all three records. A fresh grant starts every version at one. Duplicate list entries fail rather than silently deduplicating controller input.

The trusted Gateway method permits at most 256 workspace IDs and 4096 session IDs. Paginated native metadata must account for every selected workspace and session; the actual bound workspace/session pair must appear. Each native page has a two-second deadline and must satisfy the scope, order, metadata and cursor contract. Validation walks at most 164 pages and must reach the final page. Missing, foreign, archived or deleted sessions do not become authorized. No broad RPC, per-candidate hydration or Agent/model call validates a grant. The existing 64 KiB management request limit remains; oversized submissions fail explicitly, without partial saves.

The legacy single-session grant action remains compatible. It preserves any old creation policy as revision-stale metadata rather than carrying its authority into the new principal revision. Grant reads expose the stored policy generation, even when inactive, so the desktop can explicitly disable or replace it using an exact CAS. A successful native creation still carries its permitted policy into the newly committed grant revision under the separate creation contract.

## Desktop controls

Settings edits full existing allowlists instead of replacing them with only the bound session. The bound pair cannot be unchecked. Selecting additional sessions keeps their workspace authorized; a workspace cannot be unchecked while its selected sessions or creation capability depend on it. Creation checkboxes are independent of existing-session access and start off. A stale policy is shown as inactive and is not silently re-enabled when editing.

Previously selected scopes absent from the desktop catalogue remain visible and checked. The operator must explicitly remove them; unavailable active creation scopes also have an explicit removal control. Save does not truncate hidden scopes. Leaving an edit clears its scope and policy-generation state. An unavailable bound target must be replaced by a valid registered pair before saving.

The client validates mutation receipts against the exact sender/account, complete allowlists, bound route, principal revision, binding generation, creation policy revision, policy generation and complete creation list. Generic success or incomplete authority metadata is rejected. Ambiguous network outcomes are not retried; refresh reads authoritative state. The native local-only transport, strong desktop authentication, same-origin protections, private credentials and non-hosted composition remain unchanged.

## Verification boundaries

Gateway fixtures exercise a 32-session grant over multiple native pages, default-off policy, scope and bound-pair rejection, all-record rollback on policy CAS failure, enabling/disabling, stale legacy policy and reopen. Native HTTP management fixtures use private SQLite state and authenticated loopback requests, verify exact receipts and failed-write rollback, then reopen the service. Fixture backends panic on generic RPC/Agent/global-event calls. A separate real BasicHost and JsonlSessionStore composition validates a 32-session native catalogue grant, default denial, explicit enablement, original creation proof after a lost acknowledgement, one added session with carried policy, archived-session edit rejection and disk reopen. Its fixture model provider remains at zero requests.

Actual emitted React and typed-fetch fixtures exercise complete multi-workspace editing, explicit creation enable/disable, policy-generation receipts, unavailable-scope removal, authority conflict retention, no retry, pagination and bilingual responsive monochrome views in Chromium and WebKit. These are browser protocol fixtures, not production accounts, native keychain trials, desktop application acceptance or executed Windows/macOS/Linux CI. Full product gates remain active.
