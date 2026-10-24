# Desktop exit tracing and authenticated Host recovery

## Incident and scope

The installed macOS 0.2.57 desktop disappeared while the user operated its embedded browser. OS logs identify desktop exit at 13:40:19 CST, exit status 0; application clean-exit metadata is absent. No current native exception/OOM report was found. The original trigger is **not established**; this change does not claim to fix an identified WebKit crash.

The secondary failure is confirmed: the original Host survived, retained its OS state-directory lease, and the next desktop's new Host failed ownership admission. No installed app/Host was replaced, restarted or killed during this work. Current tasks were left alone.

## Changes

- Closed diagnostic events for main-window close/destruction, runtime/menu/update exit admission, blocked/unclean exit, Host reconnect/shutdown outcomes, browser navigation/loading/activation/close admission, and macOS renderer termination. Numeric native view IDs only; no URLs, titles, page text, keys, tool arguments or credentials. `close_accepted` means native admission, not observed destruction.
- One graceful exit gate for close/runtime requests and an explicit macOS Quit action. A shutdown timeout keeps the window/Host instead of ignoring the error and exiting. Unexpected native termination preserves recovery information; it does not automatically rerun a task.
- An exclusive desktop control lease and bounded, atomic private recovery receipt, bound to canonical state directory/workspace and app version. Unix runtime directory/file permissions are 0700/0600. Credentials are separate from diagnostic exports. Symlinks, hardlinks, public files, unknown fields, oversized/mismatched data and non-loopback endpoints are rejected. Invalid credentials are never used; corrupt cache cannot panic setup when an otherwise unowned state can start fresh.
- Reconnect only when the real Host OS lease is held and a fresh domain-separated HMAC-SHA256 challenge proves the endpoint knows the saved launch key. Health/PID/cookie echo is not proof. The challenge sends no bearer, uses no proxy/redirect and bounds the response. Normal desktop authentication is unchanged.
- Rebind the private browser bridge, reuse the Host, and monitor actual lease release, not a network timeout. Keep identity/bridge consistent across a pending-start race. Clear handoff after verified normal stop. Never unlink the Host lock or signal a cached PID.
- Browser close-all drains the registry before native teardown rather than holding that registry mutex across native close calls.

## Regression evidence

All Rust commands run on WZU_Server after source synchronization; no local Rust compilation.

- Diagnostic schema/backward decoding/privacy/rotation tests.
- Server transport and challenge tests: nonce/domain binding, malformed/unknown query fields, no cookie grants and unchanged RPC denial.
- Desktop library/all-target tests: private receipt roundtrip, competing desktop ownership, held/free Host lease, never deleting locks, malformed/oversized/mismatched receipts, private-file/symlink denial, loopback validation, wrong/echoed/oversized/redirected proofs and exit gating.
- Real isolated Host: a local fake provider handles discovery/counting/title requests separately and pauses the actual tool-enabled agent stream. Drop the simulated desktop owner/bridge, reopen the handoff, authenticate, rebind, and resume the same Host/stream. Require one user message, one turn start/end, exactly one committed assistant response with exact content and `completed` status; no task resubmission. Wrong key is denied; graceful shutdown must release the lease without deleting its file. Three consecutive Linux trials passed. No external model calls.
- Linux native browser probe passed: positive lifecycle metadata, main-window survival, actual DOM/native input state and independently checked screenshot pixels. Exit code alone is not accepted as pass.
- Existing bootstrap, startup, titlebar/theme, updater, diagnostics, update bridge, CI runtime/tiering and architecture contract/mutation tests retained.
- CI enrolls the real Host probe on Linux/macOS/Windows and retains native browser gates. macOS/Windows runs remain CI evidence, not a claim of local execution.

## Limits

- First spontaneous exit trigger remains unknown. New production tracing requires a future validated build; this PR does not change the running app.
- Pre-feature Hosts have no handoff/identity protocol. They are **not** silently adopted; tasks stay untouched until a controlled transition is possible.
- Incompatible receipts or occupied bridge ports fail closed. No automatic process termination, lock deletion or privilege bypass.
- The Host fixture simulates desktop-owned resources disappearing; it does not reproduce the user's full native app crash. Existing platform/framework process cleanup, including Windows kill-on-close Job, is unchanged; reconnect applies only when a Host actually survives.
- A destroyed browser document/in-flight native action cannot be resurrected. Existing unknown-effect/no-auto-replay semantics remain; restored UI must observe/rebind fresh browser state.
