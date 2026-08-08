# Windows AX viewport follow-up — 2026-10-05

Implementation scope: foreground ControlView observation, region filtering,
visible-first bounded breadth traversal, lazy non-password input ValuePattern,
explicit unknown/redacted states and limit reasons. Existing frame/surface/node
identity checks, single native worker/input serialization and budgets remain.
No new permission, tool, Host/RPC or business-state mechanism.

## Acceptance gates

- V100 Linux: 19 contract/selection tests passed; clippy passed (`linux-tests.log`).
- Windows runner compilation/Host composition: see final recorded CI source/run.
- Isolated Windows VM: native fixture and real-browser receipts must match the
  exact CI artifact source SHA and executable digest, not an earlier build.
- Shopping acceptance remains independently graded. Install/CI/native operation
  success, model self-report, and pure API controller success are not equivalent
  to full installed desktop/Host, history/compaction or vision acceptance.

Earlier baseline and original real-site failure are retained in
`../windows-shopping-20261005/`; they are not relabeled as this build's result.

## Actual result (source c71f76a7e125e3b1515b6e1470fc1835ff0f51cd)

- Windows CI run 37306874279: **26 tests, clippy, Host composition and fixture
  release build passed**. Provenance digest independently verified on V100;
  executable imports have no dynamic MSVC runtime dependency.
- V100 isolated Windows VM: **14 native cases passed**, exit 0. Includes actual
  ValuePattern input, password redaction, region filtering, Unicode, stale-frame
  rejection, native shortcuts/selection/click/window/wheel/drag cleanup and PNG.
- Same previously failing Newegg results page, same scroll position: full
  observation now includes Kingston NV3 and Samsung 9100 PRO with exact labels
  `$156.99` and `$249.99`, independently visible in `same-page.png`.
  Full region: 146 returned / 890 visited / 9,448 ms; focused region: 73 returned
  / 737 visited / 8,771 ms. Both report `time_limit`, not a complete UIA tree.
  Region filtering halves returned nodes while preserving those products/prices.
  Input URL and genuinely empty price fields are now `value_state=known`.
- **Latency remains high**, not a performance optimization acceptance. This is
  an extraction/region correctness improvement; output/time caps still apply.
- Real text-only DeepSeek Flash controller began a fresh homepage/search flow.
  Five native results confirmed. Navigation once returned `outcome_unknown`
  because follow-up observation detected a changed frame; model correctly asked
  to observe instead of repeating Enter. Receipt retrieval for native ID 7 was
  interrupted when the SSH forwarding process exited. A reconnect was closed;
  the next bounded SSH attempt timed out. **No whole-flow pass is claimed.**
  ID 7 was not replayed. Model steps and usage contain no private reasoning or
  credentials. Controller retry/recovery/full Host/vision acceptance remain open.
- Model process stopped and forwarding process exited. Server became unreachable
  before remote probe-stop confirmation; existing guest script has a 20-minute
  TTL and `finally` cleanup. Do not claim the remote probe was already stopped.
- No original VM, user software, UAC, credentials or production deployment
  changed. No real cart/checkout/purchase, main merge or release.
