# Windows AX logical visible view experiment — 2026-10-06

Acceptance-only, default disabled. The worker view is frozen at driver construction; observation and action resolution use the same walker. No model/RPC switch, no production environment variable, no dependency or permission change.

The experiment uses ControlView AND NOT IsOffscreen=true as a logical UIA view. It does not prune client-side subtrees. Native descendant-promotion acceptance checks that a named nested child is promoted through an excluded intermediate wrapper. This does not certify every provider's offscreen property or prove a speedup.

The normal discovery/time/node limits, live runtime ID/PID checks, password redaction, foreground/frame checks, worker Job ownership and cancellation remain unchanged.

## Evidence status

- Linux: 20 contracts and Clippy passed remotely on V100; log attached.
- First Windows CI rejected a fixture-only owned-string comparison under Clippy; retained failure log. Fixed in 70231439b85a8d45c191ec69097ea4d677bb53c1, with acceptance-feature contracts now included in Windows CI.
- Windows CI 37394193584: 30 feature-enabled unit contracts, Clippy, Host composition, release probe build all green in 4m16s; exact artifact digest 71d3b42330945002231be1faba7ba9e916a0b5d6f286cc721e700bde87099fc7.
- Windows native fixture: 16 independent checks passed in each mode. Same-page comparison complete; experimental view NOT enabled by default. No production rollout or installed Host acceptance claimed.

Success requires exact artifact SHA, both auto/semantic modes, at least three observations per mode, unchanged capture scope and independently visible page content; required search input coverage is reported separately from latency. Partial trees cannot be called complete or used to claim causal speedup.

## Actual disposable-Windows result

Both modes used the **same** CI-built executable, exact source 70231439b85a8d45c191ec69097ea4d677bb53c1 and the same digest. Only the immutable lab view changed. Both completed 16 independent native checks (plus a separate summary record), including semantic click, Unicode/keypress delivery, password redaction, region filtering, stale-frame rejection, cancellation release, and screenshot dimensions. The native promotion fixture independently verified the raw intermediate parent rather than trusting our projection. This is a named-filter promotion check, not proof that all providers implement IsOffscreen correctly.

Read-only Edge page: https://www.newegg.com/p/pl?d=2TB+NVMe+SSD. The actual page remained foreground, same capture geometry/scope, two visible product titles and price anchors verified in all 12 receipts; independent screenshots included. No purchase, cart, login, CAPTCHA handling, DeepSeek request, installed Host or vision model acceptance took place.

| Metric | Control view | Experimental visible view |
| --- | ---: | ---: |
| auto native elapsed median (3 samples) | 8906 ms | 9081 ms |
| semantic native elapsed median (3 samples) | 8818 ms | 9098 ms |
| required search input label and value | 1/6 | 6/6 |
| time-limit partial trees | 6/6 | 4/6 |
| returned nodes | 88–155 | 157–177 |
| visited nodes | 667–814 | 299–346 |

**Decision: do not enable by default.** Required input coverage improved in these samples, but there is no demonstrated latency speedup; the experiment still produced four incomplete trees. Traversal visits fell but navigation still dominated ~7.7–7.8 seconds: fewer returned provider elements is not the same as lower COM/provider work. More nodes also require more value/password/pattern materialization. We do not claim statistical causality, universal compatibility, memory-leak resolution, or an installed XHarness memory reduction.

Native probe sampled peak working set was ~30.3 MiB control and ~29.1 MiB experimental; Edge summed working sets ~948 MiB. These are process working-set samples, not PSS and not a full application or long-duration memory test. Differences are not used as a causal savings claim.

Both probes explicitly exited with operations=6 and probe_alive=false before switching modes. The lab recipe is restored to the default control view, which clears the experimental flag; the production default remains unchanged. The original Windows VM, permissions/UAC/accounts, Mac application and Web 3271 were not modified.

Next optimization candidate: reduce the **cost per navigation operation** or add a bounded fair traversal, with unchanged completeness/truncation reporting and identity checks. Provider-side batching must first have an explicit allocation/lifetime bound; an unbounded FindAll is not an acceptable shortcut.

## Reproduce / regression

- V100 remote Python: 9 performance oracle + 1 collector + 6 shopping grader tests passed, and compressed evidence regraded; full log attached.
- `python3 -B scripts/computer-shopping-lab/test-grade-ax-performance.py`: 9 offline tests; logical-view mismatch now rejects same-SHA control/experiment mixing.
- `python3 scripts/computer-shopping-lab/grade-ax-performance.py docs/evidence/windows-ax-visible-view-20261006/control docs/evidence/windows-ax-visible-view-20261006/experiment`: verifies exact source, view, scope, URL, required content, ancestor closure, counts and descriptive comparison from losslessly compressed receipts.
- Rust commands were executed only remotely; see Linux log and Windows CI log. UI interaction was on the authorized disposable clone through authenticated noVNC, never the original VM.
