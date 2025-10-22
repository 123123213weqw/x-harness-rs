# XHarness Rust architecture

XHarness is being rebuilt as a set of typed Rust capability seams rather than
as one privileged agent loop. The upstream DeepSeek Harness package graph is a
reference for lifecycle and durability semantics; Cordis and its JavaScript
plugin loader are not part of the Rust runtime.

## Invariants

1. **The session event log is the source of truth.** Every model-visible value
   is derivable from append-only events. Snapshots are caches, never authority.
2. **A tool call is durable before it can have side effects.** A recorded call
   without a recorded result recovers as `outcome_unknown`; it is never replayed
   automatically.
3. **Control and history are separate.** Pause, approval requests and live
   status are control-plane events. Accepted user/context input becomes a
   durable session event before the following request.
4. **Policy fails closed.** Missing approval or sandbox providers cannot turn
   into implicit permission.
5. **Core and platform are separated.** Model/storage providers use typed
   interfaces. Native filesystem, process and sandbox implementations are
   selected at compile time behind one `xharness-platform` facade; the loop
   never branches on the operating system.
6. **Cancellation reaches quiescence.** A completed cancellation means the
   provider stream and all owned process/tool work have stopped, not merely
   that their futures were dropped.

## Crate layers

```text
xharness-cli (planned) / xharness-server + xharness-host
            |
xharness-agent        long-lived Agent, inbox, turn/step driver
            |
xharness-core         provider-neutral loop and live control
      |          |
xharness-session  xharness-tools
      |          |              \
jsonl/sqlite   provider adapters  xharness-platform
                                      |
                           process + fs + native sandbox
                              /                 \
                    macOS Seatbelt         Linux Bubblewrap
```

### `xharness-session`

Owns provider-neutral messages, append-only `SessionEvent` records, monotonic
sequence numbers, compare-and-swap revisions, transcript projection and crash
recovery. Storage implementations live in sibling crates. JSONL is the first
durable backend; SQLite can implement the same `Store` trait later.

### `xharness-core`

Owns streaming normalization, bounded model/tool scheduling and `LoopRun`
control. It must not contain filesystem, shell, Web or UI implementations.
The current v0 snapshot store remains only as a migration bridge while the
loop is moved onto `xharness-session`.

### `xharness-tools`

Owns the unique-name registry and execution pipeline:

```text
parse + validate
  -> pre-execute policy (monotonic allow/ask/deny)
  -> around-execute middleware (timeout/metrics/retry)
  -> tool body
  -> post-execute policy
  -> bounded model rendering + result observers
```

Concurrency metadata is declarative. The agent scheduler preserves model call
order in durable results even when safe calls finish out of order.

The original `xharness-core::ToolSpec` path remains a compatibility adapter
during v0. The registry executor becomes the canonical runtime once the core
adapter lands; policy must not be reimplemented inside individual tools.

### Native execution capabilities

The local coding bundle will be layered as:

```text
bash/read/write/edit/glob/grep tools
  -> shell + filesystem services
  -> xharness-platform (read-only/workspace-write/full-access)
  -> native sandbox (macOS Seatbelt / Linux Bubblewrap)
  -> subprocess runtime (process group, bounded output)
```

Persistent PTY sessions are a separate owner-scoped service. They are not a
long-running variant of the one-shot Bash tool.

The process group is a lifecycle mechanism, not a security boundary. Hard
descendant containment belongs to the native sandbox. `NativePlatform` is the
application composition point; neither `xharness-core` nor model providers
depend on it.

The standard coding bundle contains fourteen stable model-facing contracts:

```text
bash read write edit glob grep
terminal_open terminal_send terminal_read
terminal_signal terminal_close terminal_list
web_search web_fetch
```

The bundle registers into `xharness-tools` and exposes a compatibility bridge
for the current core loop. The bridge delegates approval to the core control
plane, while argument/schema validation and execution still pass through the
canonical tool executor.

## Delivery order

1. Event-sourced session + Memory/JSONL stores.
2. Core contract hardening and migration to durable turn/step/tool events.
3. Tool registry, approval seam and policy pipeline.
4. Prompt/provider registries and context compaction.
5. Native subprocess, filesystem, sandbox, standard coding tools, persistent
   PTY, and bounded Web runtime for macOS/Linux. **Implemented.**
6. Thin headless CLI and durable long-lived Agent/inbox, then API/Web
   projections. **Web compatibility baseline implemented; durability and CLI
   are next.**
7. Prompt/provider registries, compaction, attachments, skills, MCP, LSP,
   subagents and workflows. **Planned.**

This order is deliberate: Web, daemon and subagent layers consume session
events. Implementing them before the event contract stabilizes would couple
every client to the temporary v0 snapshot model.
