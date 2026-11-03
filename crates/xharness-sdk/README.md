# XHarness embedded Rust SDK (0.1)

`xharness-sdk` is maintained in the main **x-harness-rs** repository alongside
its native runtime. A headless Runtime distribution can synchronize this crate;
products consume a reviewed, pinned revision rather than maintaining another SDK
or loop implementation.

```text
Embedding product
       ↓
xharness-sdk (this crate)
       ↓
Existing host / agent / core / tools / session components
```

This is an in-process facade over `DurableLoopAgentRuntime`, not another agent
engine or HTTP service. It still depends on `xharness-host`; it does not claim that
the Host dependency graph has already been extracted into a transport-free crate.
The SDK has no product, channel, ticket, or business-database dependency.

## API and ownership

| Capability | Public entry point | Semantics |
| --- | --- | --- |
| Composition | `RuntimeBuilder::new(...).build()` | Inject models, tool factory, authoritative Store and leases; no model calls, source listeners or recovery scan |
| Empty session | `create_session` | Create only a native journal; duplicate creation preserves the native conflict error |
| Inspection | `session` | Read the same authoritative Store, not an SDK conversation mirror |
| Queue | `queue` | Admit durably without waking; admission is not task completion |
| Execute | `start_turn` | Native admission, preinstalled observer and wake; user input needs a stable message ID |
| Events/control | `Turn::next_event/send/cancel/result` | Native events, controls and results; cancellation acknowledgement is not proof of cleanup |
| Recovery | `resume_session/take_resumed_turn` | Explicitly recover one known session from its existing journal, without resending input |
| Shutdown | `shutdown` | Consume the SDK owner, run native bounded shutdown and return its cleanup report |

The builder requires a registered, routable default model. There is no successful
unconfigured fallback. The default bounded event capacity is 256; the caller can
set a `NonZeroUsize` capacity. A slow event reader can still lag: the SDK does not
promise an extra lossless event cache. The native journal remains authoritative.

Model/provider, permission, context, prompt and tool types retain their original
Rust identities. This is an evolving 0.1 integration API, **not a stable 1.0 API or
ABI**. Pin one source/revision for every XHarness crate used by a product.

## Example

The compilable [`offline_echo`](examples/offline_echo.rs) example uses an explicit
in-memory model fixture and a real durable runtime with JSONL persistence. It
opens no model connection and makes no paid inference calls. The caller supplies
an absolute, isolated state directory.

```rust,ignore
let runtime = RuntimeBuilder::new(
    route, models, tool_factory, store, leases,
).build()?;

let mut turn = runtime.start_turn(request_with_stable_message_id).await?;
while let Some(event) = turn.next_event().await {
    // Forward events to the product's UI/log projection.
}
let result = turn.result().await;
drop(turn);
let shutdown_report = runtime.shutdown(grace).await;
```

Following this repository's remote-compilation policy, synchronize the current
source and execute Rust commands on the authorized Linux build server, not on
the development Mac:

```sh
cargo test --locked -p xharness-sdk --all-targets
cargo clippy --locked -p xharness-sdk --all-targets -- -D warnings
cargo run --locked -p xharness-sdk --example offline_echo -- /absolute/isolated/sdk-demo
```

This source contribution does not publish a crates.io package. After review,
consumers can select `xharness-sdk` from this repository using a full Git commit
in Cargo's `rev` field. Do not mix it with locally patched native crates from a
different revision: reconcile those patches upstream before switching consumers.

## Changing tools

The embedding product supplies `SessionToolFactory`; the SDK does not hardcode a
tool catalogue. Model-facing schemas and their handlers must come from the same
controlled registry. The factory receives the actual session, cwd and permission
preset. Filesystem/process factories must retain the existing native guards,
approval and sandbox pipeline: a permission enum does not automatically sandbox
an arbitrary custom handler.

Version 0.1 does not implement tool hot replacement. Drain work, close the old
Runtime, then construct a new Runtime with matching schemas and handlers. Before
recovering unresolved old tool calls, the embedding product must check tool
compatibility and stop for migration when incompatible. This SDK neither rewrites
saved arguments nor provides a generic tool-version migration validator.

## Explicit boundaries

- No second Inbox, chat history, execution loop, business scheduler, HTTP listener
  or channel consumer is created.
- Persistence depends on the injected Store. `MemorySessionStore` is not a
  cross-process durable backend. Use an appropriate shared-scope file lease
  manager for cross-process exclusion.
- The embedding product owns saved model/cwd/permission/Prompt configuration and
  must provide verified session configuration during recovery.
- A `Turn` is an observer/control handle. Dropping it does **not** cancel work.
  Explicitly shut down the Runtime, inspect its report and settle/drop old turn
  handles before replacing the owner. Factories must clean up their own resources.
- Native RPC/Session formats and default permissions are unchanged. This change
  neither migrates a product to the SDK nor deploys anything.
- A future Runtime distribution should synchronize this upstream crate instead
  of maintaining a separately edited SDK copy. This PR does not enable dependency
  update bots, automatic upgrades, merging or production deployment.

The public-SDK integration tests cover inert construction, model validation,
real native model/tool/result execution, durable queue/reopen, invalid inputs,
execution fencing, explicit cancellation, schema/handler replacement after
shutdown and observable preparation/cleanup failures. Their model responses are
fixtures, not live-provider acceptance.

Operator validation for this upstream candidate is recorded in
[`verification-20261103.json`](../../docs/sdk/verification-20261103.json), including
its exact base/source fingerprint and explicitly limited Linux/offline scope.
