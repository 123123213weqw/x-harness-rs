# Persistent deep diagnostics

User request: keep deep diagnostics enabled across time and application restarts, including full-memory crash capture on this local installation. Heap validation remains separately opt-in.

Keep the existing 15-minute option; add an explicit persistent option until manually disabled. Do not change defaults for other users. Store a closed-schema diagnostic preference in the application config directory, independently of model credentials and session data. Corrupt or unreadable preferences fail closed and surface a storage error. Persist before reporting success; rollback to disabled on write failure.

Desktop and Host must agree on persistent mode: use a distinct control marker, not a far-future expiry which the old Host clamps to 15 minutes. Persistent recording replenishes the 4096-record allowance every 15 minutes; bounded queues, log rotation, sampling interval and dump budgets remain unchanged. Full dumps remain local, separately consented, at most two files and 512 MiB each. Heap checks remain optional.

Verification: preference save/reload/disable/corruption, timed and persistent leases, Host control expiry and reset, frontend consent/status/actions, remote Rust tests, Windows CI build and native installation checks. No local Rust compilation. Keep product work separate from crash evidence and other PR branches. Do not report the installed App enabled until a rebuilt client is installed and its runtime status verified.
