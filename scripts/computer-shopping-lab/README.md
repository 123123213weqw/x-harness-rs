# Disposable Windows shopping acceptance fixture

This is development test infrastructure, not a runtime dependency or an installed plugin. The Windows product still has no Python/PowerShell execution dependency. The browser bridge is compiled only with `native-acceptance`, checks the named disposable VM UUID, and invokes the **registered ComputerTool through ToolExecutor**. Never run it on an everyday/user desktop.

1. Compile remotely using `.github/workflows/windows-computer.yml`; verify source SHA, executable SHA256 and PE runtime audit before use. Do not compile Rust on the local Mac.
2. Run `python3 create-shop.py --output <test-data-directory>` (without `--output`, the generator writes beside itself). It generates 808 products and the local-only HTML fixture. Prepare `computer-probe.exe`, `computer-provenance.json`, `guest-shopping.ps1` and `shop.html` in the collector root.
3. On the V100 VM host, start `python3 collector.py --root <test-data-directory> --port 18086`. This server binds loopback only and publishes an explicit whitelist, not a directory. Guest QEMU user networking accesses it through `10.0.2.2:18086`. Do not publish it on the Internet.
4. In the authorized `xharness-install-lab-20261005` VM only, run `guest-shopping.ps1` in its interactive desktop. Select the new shop Edge window before model execution. The script verifies SMBIOS identity and artifact digest, samples process resources during tool execution and cleans up its own probe. It does not change UAC, accounts, the installed app or the original VM.
5. A controller waits for `/browser-latest` phase `ready`, uses `definition` **without schema rewriting**, then posts `{id, request}` once to `/browser-job` and waits for the same result ID. IDs begin at zero, are sequential and bounded to 80. After an uncertain response, read the result again; **never replay an input action**. `{"stop":true}` retires the probe. Tool and native budgets remain enforced.
6. For real model testing, use an explicitly authorized existing provider credential on the controller only. Preserve the original tool requests/frame IDs; do not inject catalog answers, DOM operations or automatic coordinate corrections. Keep provider tokens and raw model transcript private. A direct API controller does **not** certify installed desktop/Host history, compaction or media projection.
7. Independently grade the actual page event log: `python3 grade-shop.py <shop-events.jsonl> <catalog.json>`. The grader derives eligible products from catalog constraints, checks the latest initialized run, exact two-product comparison and a single correct cart item. It does **not** score success from model claims or tool activity.
8. Also inspect the visible cart and manually check the final report. Core interaction can pass while reporting accuracy fails. `python3 test-grade-shop.py` includes wrong product, duplicate cart, missing comparison, stale prior success and missing initialization negative cases.

The synthetic cart has no login, checkout, real order or payment. Public shop testing is read-only: no real cart, login, order, payment, CAPTCHA handling or security-warning bypass. A synthetic page cannot prove third-party image/video, anti-bot, authentication or cross-site behavior.

Resource samples are summed process working sets/private memory during operations, not unique PSS or a continuously measured absolute peak. Include all retained Edge tabs in the stated scope; never report this as full XHarness desktop memory or evidence of no long-duration leak.

## Collector concurrency regression

Published files are read under the same lock used for append/atomic replacement;
the lock is released before HTTP responses are written. An open Windows read
handle can otherwise deny replacement and disconnect the POST client. The
collector retains body limits, loopback binding and its route whitelist.
`test-collector.py` covers a deterministic simulated sharing violation, all
published/missing GET routes, unlocked socket responses and concurrent 80 KiB
JSON publication. Removing the read lock makes the controlled regression fail;
this is not an automatic HTTP retry or a GUI action replay.

The extended fixture subclasses the base handler through `collector.main`,
instead of replacing/`exec`-ing source text. `test-expanded-collector.py` still
checks the exact scenario allowlist and rejects unrelated files/query parameters.
These tests validate the disposable lab bridge, not Windows desktop task quality.

## AX performance comparison

`grade-ax-performance.py <baseline-directory> <candidate-directory>` is an offline oracle. Each directory contains `manifest.json` and at least three receipts per detail mode (plain JSON or deterministic gzip). The manifest records the exact artifact source, observed URL, foreground title, visible-label anchors, expected editable inputs and per-sample modes. Retain independent before/after screenshots alongside the receipts. The grader rejects wrong foreground/source/query, missing content, invalid timings, broken ancestry, duplicate samples and changed geometry. It reports missing inputs and partial/time-limited trees separately rather than treating fast truncation as successful task coverage. Native latency and process working sets are descriptive; varying visited/returned counts do not prove a causal improvement. Run `python3 -B test-grade-ax-performance.py` for negative-case regression.

## Expanded default-behavior tasks

`create-expanded-shop.py --output <test-data-directory>` derives four scenarios from the same synthetic catalog: `filter`, `scroll-detail`, `modal`, `slow-layout`. Serve them using `expanded-collector.py --root <test-data-directory> --port <isolated-port>`, then visit `/expanded.html?case=<scenario>` in the disposable guest. The collector retains the existing body/image limits and only permits those scenario names. Do not reuse a currently running collector root.

The extension adds a comparison exercise, a scroll target followed by a same-document detail view and return, an announcement overlay, and a 2.2-second simulated search delay with a layout shift. Same-document navigation is not proof of full navigation/cross-origin support; simulated delay is not a real network-switch test. All page events include scenario, per-document sequence, visible result IDs and scroll position. The independent `grade-expanded.py` oracle requires these external effects plus exact reported facts, forbids cart activity and rejects stale successes from a previous initialization. Run `python3 -B test-grade-expanded.py` for positive/negative regression. A JSON-format failure is recorded separately from functional correctness.

Keep model action order and schema defaults unchanged. Setup-only page resets, model requests, receipts, image hashes, final reports and page events must be retained separately. Stop the entire run on missing receipts/unknown external effects; do not add an automatic input replay. Any diagnostic extraction of JSON is not a production parser fix. New tests do not justify changes to production TTL, authorization or automatic-observation behavior without a reproducible failure and independent evidence.

## Tool-free terminal report schema

`structured_report.py` is **lab reporting infrastructure**, not a new tool, Host
runtime dependency, or a reason to force ordinary conversations into JSON.
Tool argument schemas do not constrain the final assistant answer. For tests
that explicitly require structured answers, leave the action loop and the
registered `computer` definition unchanged, then use a separate terminal stage:

1. Retain the original draft, events, operation error, source identity and score.
   An unknown effect, missing receipt or failed operation gate cannot be repaired
   by formatting and must not admit the reporting stage.
2. Probe the explicitly configured local provider once per run with
   `response_format.json_schema`. Ignored/unsupported formats fail explicitly;
   do not silently fall back to an unstructured prompt or infer support from a
   model name. The capability probe is evidence, not a universal guarantee that
   every schema keyword is implemented by every server version.
3. Send only the recorded draft to an **independent, tool-free** schema-constrained
   request. No original screenshots, complete conversation, catalog answers,
   external action functions, collector URL or provider credentials are sent.
   Prices must be finite nonnegative numbers, required fields must exist and
   unknown fields are rejected. An `insufficient_data`/null-report variant gives
   the model an abstention path instead of forcing invented facts.
4. Check the provider envelope, completion reason, JSON and schema locally.
   Duplicate keys, code fences/prose, nonfinite numbers, booleans as prices,
   partial output, refusal and unexpected tool/function calls are not accepted.
   At most two formatting generations are allowed; network/provider failures
   are not automatically retried. There is no tool dispatcher to replay input.
5. `grade_separate` reports **operation**, **facts**, **format** and their joint
   result separately. Preserve the legacy `grade` oracle and historical scores.
   A valid schema cannot certify factual accuracy or turn missing page evidence
   into successful interaction. In ordinary UI chat, preserve the original text;
   formatting failure is not a request to cancel or rerun completed work.
   If the draft cannot be decoded, facts are `not_evaluated`/null rather than
   declared incorrect merely because their format is unavailable.

Run offline contracts with `python3 -B test-structured-report.py` (also in the
Windows adapter CI). For real reporting-only verification, prepare a private
manifest with `base_url` (credential-free loopback `/v1` endpoint), `model`, and
one to four distinct `cases`. Each case has `case`, `draft`, `events`, `summary`
paths relative to the manifest; summary must contain its case and original
`error`. Execute:

```sh
python3 -B finalize-recorded-reports.py /absolute/private/manifest.json \
  --out /absolute/private/new-terminal-report-evidence
```

The output directory must not exist. Input hashes, original text, capability
probe, complete formatting requests/responses and before/after separate scores
are retained. This path never connects to the VM or collector. Formatting
recorded drafts is a **new reporting-stage experiment**, not a rerun of GUI
tasks, a replacement of old raw scores, or installed desktop/Host acceptance.
The limited schema validator is intentionally scoped to these fixed lab schemas;
it is not a general-purpose JSON Schema implementation.

### Target freshness / occlusion acceptance

The Windows private worker now binds the complete UIA name digest, control
role and physical bounds to each node target. A changed name/role/rectangle is
not the same actionable observation merely because its HWND/runtime ID still
exists. There is no elapsed-time lease: the real 65-second delayed-decision
regression remains required.

Before node-directed input (and again after obtaining InvokePattern), recheck
semantics, visibility/password/enabled status and foreground identity. Use the
native desktop hit-test plus bounded UIA raw ancestry to require the target
center to hit that node or its descendant. A covering sibling/other window or
unknown provider result does not grant permission to invoke. No input replay
or coordinate fallback follows an uncertain Invoke.

These are conservative **pre-dispatch checks**, not an atomic application
transaction, a full-page content generation counter, or proof of arbitrary
provider correctness. Coordinate-only input still has the existing desktop /
foreground / geometry checks; it does not acquire a semantic node identity.
Partially covered controls whose center cannot be verified require a new
observation or an explicitly selected visible coordinate. The public model tool
schema and the macOS adapter are unchanged.

Native checks in the identity-verified disposable clone:

```powershell
$env:XHARNESS_DISPOSABLE_COMPUTER_VM='66b64058-bdcc-43e9-85ee-55a79fe2e875'
.\computer-probe.exe --native-acceptance
.\computer-probe.exe --freshness-acceptance
.\computer-probe.exe --target-guard-acceptance
```

The additional suite independently counts actual button `WM_COMMAND` events:
unchanged target accepted, same-node label changed denied, same-window target
moved denied, opaque sibling covering a still-recorded target denied, and fresh
uncovered observation accepted. The covering sibling is already visible before
observation; only its geometry changes, so a replaced tree path cannot falsely
stand in for an occlusion test. Fixture readiness is an actual pumped message
plus verified foreground, not an ignored activation result and fixed 300 ms.
All failures are preserved; an unrun suite is not reported as passed.

Host sink unit regressions separately cover valid PNG persistence/reopening,
session isolation, bounded reference-only metadata, cancellation, malformed
PNG, unsupported image route and lost Host. They are **not** installed Windows
Host / GUI / history end-to-end acceptance. That remains a distinct gate using
an artifact built from the exact accepted source.

API semantics: [ElementFromPoint](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation-elementfrompoint),
[CompareElements](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation-compareelements),
[WindowFromPoint](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-windowfrompoint).
