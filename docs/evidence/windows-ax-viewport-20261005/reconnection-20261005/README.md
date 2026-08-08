# Reconnection and real DeepSeek follow-up

Date: 2026-10-05. Native source remains c71f76a7e125e3b1515b6e1470fc1835ff0f51cd;
verified executable digest e9679d4f97d4b92f982c634e06bc44c4fd22b16c53e9b8b2012f6328faa972ad.
No executable changes or local Rust compilation in this follow-up.

## Reconcile before continuing

The old pending click (ID 7) succeeded in 8,658 ms. Its persisted server receipt
was retrieved after connectivity returned; it was **not replayed**. The old
bridge finished 8 operations with `probe_alive=false` at 12:30:25 UTC. A fresh
bridge was started, with fresh frame IDs and sequential native IDs 0–27. The
old incomplete test is retained, not relabeled as a continuous successful run.

## First new run: not full acceptance

16 model responses, 15 native calls, 11 successful / 4 rejected. Three expired
frames were rejected before input; one invalid wait field was rejected. Model
recovered by observing / fixing its own request. Address-bar autocomplete
opened the prior 1TB results URL, **not a new site-search submission**. Although
the model extracted the prior names/prices, a Cookie banner covered the price
area in the independent screenshot. Its broad claim that all controls were
interactive is not independently certified. This run alone is not accepted.

## Second run: strict site search and price reporting passed

Fresh model task: use the site search box for a new `2TB NVMe SSD` query; no
address-bar/history substitute. Cookie dismissal was permitted. Real DeepSeek
Flash, text-only, the exact registered ComputerTool schema and native adapter;
no DOM API, catalog oracle, injected coordinates, argument rewriting, automatic
new frame selection or input replay.

- 14 model responses, 13 native calls: 12 successful, 1 stale-node rejection.
- Model clicked Reject All, selected the page search field, Ctrl+A, typed the
  new query and submitted Enter. Tool steps distinguish the page field from
  address-bar input; independent `search-submitted.png` confirms the new query.
- Model handled the stale UIA path with a fresh region observation, without a
  speculative coordinate fallback or blind action replay.
- Final independent screenshot and report agree: Samsung 9100 PRO **2TB
  $399.99**, WD_BLACK SN850X **2TB $352.00**. No login/cart/purchase/CAPTCHA.
- The model first sent negative wheel deltas (up) without achieving the intended
  downward view, then recovered using PageDown. Tool activity is not itself
  proof of progress. This remains a model-efficiency limitation.
- Final bridge receipt: 28 operations, `probe_alive=false`, 13:00:24 UTC.

## Performance and scope

Successful native median: first run 8,932 ms; second run 8,924.5 ms. This is an
AX extraction correctness acceptance, **not latency optimization**. Time-limit
truncation remains explicit. Stale node paths still occur on a dynamic page.

The original uncompressed WAN lab receipt transfer also consumed frame lifetime.
A temporary **read-only, loopback-only gzip receipt reader** was introduced;
compressed JSON is fully decompressed, with no content/schema trimming. POST
input dispatch still occurs once through the unchanged bridge. Pending receipt
14 was reconciled before restarting the controller; no action was repeated.
This changed the **test transport**, not the product runtime. The compressed
second run has zero expired-frame errors, but this is not a controlled single-
factor product A/B performance comparison. Transport timings and byte sizes are
recorded separately; local reader and test tunnels were retired after use.

Second-run sampled Edge working-set sum peaked at **1,200.62 MiB**; native probe
at **34.01 MiB**. Includes all retained Edge windows and renderer processes,
not unique PSS, full installed XHarness memory, or proof of absence of leaks.

Provider usage is actual, including cache-hit fields; repeated request token
counts are not unique context. Currency cost was not reported, so none is
invented. Raw reasoning and credentials stay local and are excluded here.
Full receipts stay locally retained; their SHA256 values are recorded.

No installed Host/history/compaction/vision model acceptance; no fresh synthetic
cart repeat on this artifact; no original VM/UAC/account/user-software change;
no main merge, release, or software replacement.
