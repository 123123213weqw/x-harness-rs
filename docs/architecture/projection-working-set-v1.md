# Projection working sets and immutable event ownership

## Scope

Reduce live display projection churn and process-local snapshot duplication without changing durable JSONL, RPC names, event coordinates, model prompts, compaction, output reserves or tool scheduling. No allocator replacement or forced trimming is part of this change.

## Incremental display tail

The full deterministic projector remains the oracle and fallback. A synchronized route may reuse resident JSON for append-local stream, step, tool, reception and terminal events. New assistant messages also prepare replacements for prior chunks of their exact `(turn, step)`, using the same hidden-marker representation as the full fold. Live delivery still publishes all new durable events exactly once; replacing cached chunks is not a new journal mutation.

Unknown events, request headers, inbox changes, user messages, compaction and other non-local lifecycle changes rebuild the bounded suffix. Changed routes and cold hydration do not reuse old JSON. An oversized delta replaces the cache with its canonical contiguous suffix; it never leaves holes. Sequence and route admission are revalidated under the existing publication lock before applying prepared work.

Each new or replaced event carries its encoded and estimated resident byte weights from preparation. Publication moves JSON values and trims prefixes; it does not serialize the old cache under the global Host write lock. This bounds retained display data, not temporary input/output or all process RSS.

## Shared budget

Retain the existing 2,048-event / 16 MiB per-session ceilings and add a 64 MiB shared estimated-resident-byte budget for authoritative display tails. Embeddings may override it; zero disables these tails. Evict inactive, least-recently-used prefixes first, preferring the session currently being synchronized. History reads refresh recency. If every conversation is running, old display prefixes may still be evicted: running agents, inboxes, permissions, token metrics, Goal state and the journal are never evicted by this policy.

Evicting an empty tail releases its backing arrays; partial eviction bounds spare vector capacity to avoid a hidden per-chat allocation outside the logical budget. The authoritative cursor remains unchanged when a prefix is evicted. The cache base advances to keep a contiguous suffix, including the empty suffix. Older history is reconstructed through the existing history/store path; an absent cache is never interpreted as an absent conversation. Startup, forks and incremental publication apply the same budget.

The existing JSONL snapshot LRU remains 128 MiB / 16 entries. It is a separate cache with logical-byte accounting; neither budget promises a matching allocator RSS ceiling. The display estimate charges owned string and array capacity, conservative map-node overhead and spare outer-vector slots, never less than encoded bytes. This is a portable accounting estimate, not an exact private allocator/layout measurement. The workspace Rust tail/replacement structs add resident-weight fields; external struct-literal callers would need source adaptation, but no wire field is added.

## Snapshot payload sharing

`Session` already shares its event vector through `Arc`, but retaining an old cut forces copy-on-write on append. The vector detachment must copy event coordinates/ownership, not every string and nested JSON payload in the prefix. `SessionEvent` therefore owns an immutable `Arc<EventData>`. Receipts and detached vectors share payloads. `data_mut` detaches only that payload; unique extraction avoids copying. Audit elision checks the immutable variant before requesting mutation.

Vector detachment still copies event coordinates and ownership references; this is not an O(1) persistent-vector claim. The snapshot LRU continues charging the payload allocation and ownership overhead as well as vector entries, so moving payloads out of the vector cannot silently undercount the budget.

Serialization/deserialization explicitly delegates to `EventData`, preserving the old envelope byte-for-byte. No Arc tag, journal migration, source truncation, dependency or unsafe code is introduced. This is a **workspace Rust source API adjustment**: the tuple field is private, callers use `new`/`data`/`data_mut`/`into_data`, and allocation-backed constructors/accessors are no longer const. It is not a claim of Rust source compatibility for external users accessing the old tuple field. Workspace consumers are compiled together and persistence/wire parity is regression-tested.

## Acceptance

- Differential full-versus-incremental projection after every event, including finalization, tools, Unicode, tiny budgets, oversized entries and prefix eviction.
- Cold restore, changed routes, compact, fork, concurrent publication and live/history/restart parity retain existing tests.
- Global budget: zero/tiny budgets, all-running sessions, recency, exact byte accounting, stable cursors/metrics and complete history after eviction.
- Event sharing: pointer/ownership assertions, retained snapshot isolation, mutating inspections, unique extraction and exact legacy JSON round-trips.
- Remote Rust tests and Clippy, unchanged 14-case resource matrix, full/off trace integrity, real DeepSeek continuation and a bounded working-set soak. Original alarms and failed model replies are preserved; growing durable history is not mislabeled a leak.
- No installed app replacement, release or merge before evidence review and cross-platform CI.

## Admission receipts and transport payloads

Durable admissions retain only fingerprint receipts in a 256-entry / 64 KiB-accounted hot cache. A miss is unknown, not permission to replay: load the authoritative journal and inspect matching inbox identity/session/fingerprint metadata before admitting. Evicted or oversized identities still deduplicate, including after restart; forked parent identities do not belong to the child. Ephemeral embeddings without a durable journal keep all small receipts to preserve exact deduplication. Queued prompt bodies remain owned by the actual queue until consumed, never by this receipt cache.

Idle checkpoint schema v4 serializes only bounded receipts, not prompt bodies. Old v3 values can be decoded into receipts; exact-schema stores replay old journals once and publish v4. The durable journal and execution history are unchanged. Older Hosts can reject v4 acceleration and replay the same journal on downgrade. This supersedes the earlier content-bound working-set architecture record; Git retains that record's history.

Every server diagnostic payload uses the existing lazy recorder. Off-mode activity metadata still flows; full-mode JSON payloads and errors remain intact. Inbox splice Web events carry only inserted identities. UI identity folds also copy only the ID when reading legacy rich envelopes, so pending replay state cannot retain old body/source objects. Queue snapshots, durable inbox bodies, user messages, source information and attachments remain complete. The Web cancellation label is normalized to `canceled`, as required by the existing UI contract; reordered/reinserted identities remain pending rather than falsely claimed as steering.

## Current-master integration

The validated implementation was ported onto master snapshot `e6b2bb78789611100928bb6ffae2c88889e12c17` without merging the superseded Git history. Startup recovery retains master's `when_ready()` reconciliation before reading the inbox; activation remains single and occurs before registering per-session ownership. UI outputs are regenerated from the combined current sources rather than copied from the earlier branch.

The earlier evaluation files are historical experiments, not current-master certification. Fresh source/binary identities and regression evidence must accompany this port. Continuously growing histories still exceed the original RSS-drift alarm; lower observed memory and successful bounded-working-set tests do not establish flat RSS or universal native-platform leak freedom.


## Merge integration acceptance (2026-10-17)

The implementation is integrated with master `1b853347b22ba4c6df4e1a70241a1518c4058880`, preserving the compact composer, shared source vendors, durable working plans, Swarm metadata and native-browser visibility fixes. Both sides of the publication-test conflict are retained. A new zero-display-budget regression verifies that a working plan survives history reads and restart even when no display tail remains resident.

The user explicitly approved merging these optimizations with the known growing-history resource alarm still unresolved. Fresh isolated loopback soaks preserve the original 64 MiB alarm: 192 growing-history turns still report `resource_alarm`; 320 create/delete turns pass. Neither the threshold nor either result is weakened or relabeled. This is acceptance of a partial optimization, not certification of flat RSS, universal leak freedom or a measured speedup. No paid model requests, installed-application changes or release are part of this integration.

Fresh functional, architecture, source/binary and resource evidence is summarized in `docs/evaluations/retention-master-integration-20261017.json`. Historical evaluation files above remain historical; exact-head cross-platform CI must pass before merge.
