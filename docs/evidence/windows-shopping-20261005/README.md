# Windows real-model shopping test — 2026-10-05

## Scope / identity

- Tested source **520586324f4592d446919be11ede1217e858f66a**, Windows CI [37298591940](https://github.com/123123213weqw/x-harness-rs/actions/runs/37298591940) passed (17 shared/native non-GUI tests, native clippy, Host composition, release fixture).
- Artifact SHA256 **cd389385b4cd0d4837ce73666ad6c7c69b8b7188e7fc311624eef3abc1173cf3**, independently checked against source/provenance and PE runtime audit.
- Authorized isolated V100 Windows 11 clone, UUID `66b64058-bdcc-43e9-85ee-55a79fe2e875`; actual Edge and native UIA/Win32 worker, actual registered `ComputerTool` / `ToolExecutor`.
- Real existing configured `deepseek-flash`, text-only, thinking enabled / low effort. Credentials stayed on the Mac controller, never copied to server/guest or committed. No hard-coded answers, DOM automation, frame rewriting or automatic action replay.
- **Direct API controller, NOT installed desktop → Host runtime acceptance.** Normal Host budgeting/compaction, session/history and attachment projection were not exercised. Raw observations were kept in this controller's model history. This distinction matters for token figures.
- No real login/cart/order/payment, production application replacement, UAC/account change, original VM modification, merge or release.

## Synthetic high-DOM-load shop

808 products / **6493 actual DOM nodes**, with misleading cheaper products failing capacity/interface/NAND/warranty/TBW constraints. This fixture does not contain heavy images/video.

Independent page-event oracle passed:
1. Submit SSD search (8 matching products).
2. TLC filter (7 matching products), ascending price.
3. Compare the two cheapest eligible products, derived independently from catalog: Orion Pro SSD CNY549 (1TB, PCIe4, TLC, 5years,650TBW), Lyra Plus SSD CNY599 (same,600TBW).
4. Exact single test cart item `orion`. Actual cart also verified visually in `synthetic-final.png`.

**Not an unqualified full pass:** model final report incorrectly said 808 products after SSD search instead of 8. Names, prices, specifications and cart statement matched. The report accuracy defect is explicitly recorded in `synthetic-verdict.json`; an event oracle pass is not model reporting acceptance.

- 17 model responses / 16 native tool calls; 13 succeeded, 3 were rejected (missing frame, expired frame after lab transport interruption, inappropriate frame on observe). Model recovered without controller rewriting requests.
- Successful native operation min **1998ms**, median **3728ms**, max **6543ms**. Native total52.073s, API request latency sum42.220s. This is one run; wall time also contains controller/SSH/collector interruptions and is not a shipping-app benchmark.
- 418 operation-time resource samples. Summed Edge working-set sampled peak **1009.66MiB**, private bytes486.41MiB; native probe+workers working-set32.42MiB, private7.01MiB.
- Token usage sum: prompt2,962,892 (2,624,768 cache hit /338,124 miss), completion5,543; last individual prompt342,639. This is repeated-history request accounting, **not 2.96million unique new input tokens**. Actual RMB cost was not reported by the provider; none is invented.

## Actual public shop — incomplete

Actual Edge navigation to `https://www.newegg.com/`, then **1TB NVMe SSD** search, independently verified browser URL/title and visible search result page. `public-final.png` shows actual product names/prices on screen. No real cart action occurred.

**Two-product name/price extraction did not pass.** Controller stopped after32 calls; no final report. Intermediate limits12 and24 were extended only after independently verified forward progress, using persisted results rather than replaying input. Native48 total operations across both scenarios, normal shutdown confirmed `probe_alive=false` in `bridge-finished.json`.

Failures and diagnostic findings:
- `auto` last observation had220 nodes but only81 visible; `semantic` cropped-region request had300 nodes but only108 visible. Both truncated in side menu/brand/vendor controls **before the visible product cards**. Screenshot region crops the capture, not the current AX traversal. Expanding max depth alone does not solve this; blindly raising node caps further increases payload/context.
- Missing `frame_id` rejected before input; a delayed frame rejected correctly. One UIA input preflight returned unhelpful `native_api_failed: Windows API failed: 0x00000000`; exact API site was not instrumented, so cause is not established. Preserve this as an open diagnostics defect, not a memory-crash conclusion.
- Initial transient DNS/loading errors and missing/delayed assets occurred, but the site eventually loaded. Do not describe this as a permanent DNS block or certify all third-party resources/network paths.
- Last individual model prompt **712,663** tokens, cumulative prompt9,743,225 /completion10,394. Raw previous trees dominated this custom controller's history. This does not reproduce or certify full Host compaction behavior.
- Sampled aggregate Edge working-set peak1029.22MiB /private618.36MiB; native32.93MiB /private7.59MiB. No browser/native crash observed in this limited run; **not a long-duration memory-leak test**.

## Scope of memory numbers

Sum of process working sets includes shared pages, retained first-run/test tabs and multiple Edge windows; not unique PSS. Sampling happens during native operations only, not continuous whole-task maximum. These figures are NOT full XHarness desktop/Tauri/WebKit resource measurements.

## Fixes actually tested and test-infrastructure incidents

- Shared tool argument validation now permits `frame_id` for `keypress`; registered-tool regression added. Native Edge Enter/Ctrl+A calls were exercised.
- Windows bounded depths are low12 /auto20 /semantic24 /high32, retaining node caps and10s traversal budget. Initial depth12 run on a29af0b could not expose deep product content; it also exhausted max2048 completion. Retry used max8192. **Not single-factor A/B**, no exclusive causal claim.
- File-based acceptance bridge tolerates PowerShell UTF8 BOM.
- Lab collector initially stalled behind idle browser preconnections and exposed partial latest JSON on concurrent read/write. Test-only collector now uses ThreadingHTTPServer and atomic replace; read-only polling can retry, input POST is never blindly replayed. Owned probe cleanup added. These are laboratory infrastructure fixes, not evidence of a production Harness HTTP parser defect.
- Existing 12 native fixture assertions were previously verified at9df5a01; do not relabel that run as5205863.

## Regression fixtures / next work

`scripts/computer-shopping-lab` contains the generator, loopback collector, UUID-guarded guest harness, independent oracle and7 Python regression cases (six oracle negatives/positives and one concurrent collector test). No provider credentials or raw model reasoning transcript are published.

Next priority: viewport/region-aware bounded AX observation with minimal necessary ancestors, avoiding offscreen sidebar dominance; better per-API stale-node diagnostics; then repeat public-site extraction through the complete installed Host with its real context pipeline. Do not gate release on native call count, model claims or installation alone.
