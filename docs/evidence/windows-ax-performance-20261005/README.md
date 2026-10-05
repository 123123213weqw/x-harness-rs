# Windows AX performance work — 2026-10-05

## Implemented

- Add per-observation phase timings and navigation-call counts. Aggregated microsecond measurements are emitted in milliseconds, without retaining UIA objects between worker requests.
- Replace the unused cached AutomationId string with the boolean IsInvokePatternAvailable property in the existing eight-property BuildCache request. Selected controls reuse that metadata rather than obtaining a live InvokePattern solely to advertise an action.
- Only an explicit VT_BOOL is authoritative. Missing, unsupported, default or incorrectly typed cache results retain the prior live-query behavior.
- Actual dispatch is unchanged: frame/surface/path/runtime/process identity checks and the live pattern acquisition immediately before Invoke remain in place. Live password classification, input-value protections, traversal/output/time budgets, cancellation, region filtering and no-replay rules remain unchanged.
- Add three Windows unit tests and a fifteenth independent native-fixture assertion requiring the real Confirm button's invoke action and a cache hit. The new fixture case has **not yet run on the VM**.

Microsoft documents bulk caching as a way to reduce cross-process property retrieval: https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-cachingforclients . This change is a bounded snapshot-metadata optimization, not a claim that the approximately eight-second discovery hotspot is solved.

## Verification status

- Profiling baseline `a21fd4bcfe202a8090b7aa0cc5a0c96ef0e8c853`: Windows run 37316308960 passed (26 tests, all-target clippy, Host composition check, release probe). Its exact-source artifact was SHA256 `d04e7f1e42b07c0e45d61f8da40744786e4bceb6ccca2357840d820a3898d922`, independently audited before VM deployment.
- Candidate `23dd8629d409a901022176fc8d4cb4c082aa3ebd`: Windows run 37320405254 passed: 29 tests, all-target clippy including native-acceptance, Host composition check and release probe. Native desktop acceptance and a same-page speedup remain unverified.
- The candidate's V100 source sync was attempted repeatedly without `--delete` and timed out. No local Rust compilation fallback was used. Earlier Linux 19-test profiling results are **not** candidate validation.
- Five profile receipts were recovered, but the foreground was the Windows shell task/window switcher. `rejected-samples.json` explicitly marks every receipt as an invalid product-page baseline. Their low latency must not be compared against the earlier Newegg timings.
- V100 SSH/HTTP/noVNC became intermittent; stale visual state was detected and no further blind input was dispatched. A stop request was attempted; after connection recovery the collector reported phase=finished, operations=5, source=a21fd4b, probe_alive=false. No input job was queued by the benchmark.

## Acceptance still required

1. Recover a stable disposable VM/collector connection; the prior five-operation probe has a confirmed finished/probe_alive=false receipt.
2. Build/test the exact candidate on Windows; repeat all fifteen native fixture cases.
3. On the identical product page, viewport and foreground, obtain at least three valid before/after samples per chosen detail mode. Preserve independent screenshots, product/input-state anchors, explicit truncation and resource samples.
4. Report total native tool latency, discovery, materialization, cache-hit/fallback counts and peak native/Edge memory separately. Edge sums are not PSS or installed-XHarness memory.
5. Do not claim a speedup, completeness, vision acceptance or installed Host/history/compact acceptance until those checks actually run. Consider filtered logical UIA traversal only in a separately verified experiment; no hidden-parent subtree pruning or unbounded FindAll was introduced.

No main merge, release, software replacement, UAC/account modification or original-VM modification occurred in this performance work.

## Operational note

An earlier preliminary synchronization mistakenly used `--delete` against the shared remote source root and produced permission errors while attempting to remove historical trial directories. Subsequent synchronization removed that flag; no permission escalation was performed. The impact on unrelated disposable remote build files has not been audited, so their preservation is not asserted. Avoid deleting shared remote-root contents on subsequent syncs.

Cleanup: the owned SSH forwards on 16086/11887 and 16089/11891 were cancelled; no listeners remained at the local check. The temporary noVNC tab close was rejected by browser URL handling after its network-error page; it was not marked to survive the turn. The user's 3271 tab was not changed.

The candidate artifact was downloaded but **not deployed**. SHA256 `00540ad6b4d32cca94be0d4a6ef8005e762c7e52e0badebe257f8cbd36fd14b0`, 2,747,904 bytes. Exact source/hash and reviewed system-import checks passed (`candidate-loader-audit.json`); native_desktop_accepted remains false.
