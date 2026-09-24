# Observable startup and safe recovery (accepted design)

The desktop and Host use two readiness levels. `live` means the Host owns its
state directory, initialized its runtime, bound a loopback listener, and can
serve the authenticated startup surface. `ready` means durable history and
model settings have finished restoring. The desktop navigates as soon as the
Host is live; an authenticated startup page waits for ready before loading the
main SPA, so normal RPCs never observe partially restored state.

The Host writes a closed, bounded startup-progress receipt to a unique
desktop-owned file after each stage and at a low-frequency heartbeat while a
stage is running. It contains only a protocol version, monotonically increasing
sequence, and predefined stage identifier. The desktop keeps waiting when that
sequence advances, but enforces both an idle timeout and an absolute 120-second
limit. Malformed, oversized, stale, or regressing receipts do not extend the
deadline. This makes slow recovery visible without permitting an indefinitely
hung Host.

History replay and model-route reconciliation run after the live endpoint is
published. The server gates product RPC/WebSocket endpoints until the Host
marks restoration ready. The desktop bootstrap route sets its private cookie
and redirects to a small built-in recovery page; that page polls the ready
endpoint and reloads the bundled UI only after restoration finishes. A restore
failure remains a startup failure and is surfaced through the existing closed
failure receipt and diagnostics.

Crash recovery is deliberately non-executing. Sessions with unfinished durable
runtime work, including an unmatched `tool/call`, are reconstructed with their
dispatch gate paused and are not attached to a running worker during startup.
The existing explicit user prompt path reopens that gate, preserving history
without silently repeating a filesystem, process, or network side effect.
Completed sessions and genuinely queued user prompts remain usable after
restoration, but no previously started tool operation is automatically replayed.

Reasoning support remains configuration-owned. Add a maintained DeepSeek
provider example with explicit effort identifiers and request patches, and
document how existing provider files should adopt it. This prevents saved
DeepSeek sessions from being repeatedly downgraded by compatibility repair
without reintroducing a vendor-specific table in the runtime.

Acceptance requires bounded receipt parsing, progress-aware timeout tests,
live/ready server gating tests, a restore regression proving dangling tool work
does not execute until an explicit user action, and configuration parsing tests
for every advertised DeepSeek reasoning effort. Rust verification runs on the
repository's approved remote builder/CI; local verification is formatting and
non-Rust asset tests only.
