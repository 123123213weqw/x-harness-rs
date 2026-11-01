# Short default persona: scoped A/B evaluation (2026-10-25)

## Change and controls

Replace only the bundled default identity (1,945 → 227 UTF-8 bytes, including
the trailing newline). Keep the historical `coding` preset ID, user presets,
framework policies, project instructions, memory handling, permission checks,
tool definitions, executor, model selection and reasoning settings unchanged.
This is the `short-persona` arm, **not** the experimental `lean-framework` arm.

Live experiments used source `9c9dabe392d29dcaa1d0ddca71b398cd6972fd24` on V100.
The patch was subsequently ported to master `bdb9357f12d9c7cff63aa38e303ca7991d1d2f79`;
the live results below are from the pinned experimental base, not a rerun of that master.

- Provider/model: official `deepseek-flash`, Responses, unchanged default High.
- Context: 1,048,576; max output: 65,536; two repeats per arm.
- Same 15 top-level tools and fresh isolated sessions; title generation disabled equally.
- Provider-wire preflight found identical non-persona policies (after normalizing
  disposable paths), tool definitions and model controls, with empty/nonempty project memory.
- Independent task verifiers checked results, not model self-assessments.
- Cache cannot be reset and the public model alias is stochastic.
- Costs below use frozen arena rates: fresh ¥2/M, cached ¥0.4/M,
  visible output plus reasoning ¥8/M. These are estimates, **not invoices**.

## Coding regression: 40 attempts

| Metric | Full identity (A) | Short identity (B) |
| --- | ---: | ---: |
| Independent verifier pass | 20/20 | 20/20 |
| Mean task seconds | 106.42 | 46.20 |
| Median task seconds | 85.10 | 33.35 |
| Mean provider responses | 17.60 | 10.55 |
| Mean tool calls | 19.45 | 11.55 |
| Fresh input tokens / attempt | 18,229.35 | 11,400.45 |
| Weighted cache-hit share | 95.50% | 91.81% |
| Estimated CNY / attempt | 0.30414 | 0.12650 |

B was faster and cheaper in 19/20 matched task/repeat pairs. Mean time fell
56.6%, fresh input 37.5%, estimated cost 58.4%. This is not a cache-hit-share
improvement: B used fewer provider/tool steps and a shorter accumulated history.

Per-task means (two repeats per arm):

| Task | A pass | B pass | A seconds | B seconds |
| --- | ---: | ---: | ---: | ---: |
| `py-feature-02` | 2/2 | 2/2 | 335.28 | 45.73 |
| `repo-mi-01` | 2/2 | 2/2 | 88.13 | 72.71 |
| `py-bugfix-01` | 2/2 | 2/2 | 16.97 | 13.07 |
| `py-bugfix-03` | 2/2 | 2/2 | 16.93 | 11.88 |
| `py-debug-01` | 2/2 | 2/2 | 101.00 | 57.88 |
| `py-feature-03` | 2/2 | 2/2 | 43.19 | 25.23 |
| `repo-mi-02` | 2/2 | 2/2 | 116.59 | 108.04 |
| `repo-dt-01` | 2/2 | 2/2 | 224.20 | 70.46 |
| `repo-sv-01` | 2/2 | 2/2 | 36.76 | 26.73 |
| `repo-pf-01` | 2/2 | 2/2 | 85.10 | 30.29 |

`py-feature-02` (expression parser) and `repo-mi-01` (iterator behavior) were
reused from screening. The eight heldout tasks cover median/signature
preservation, mutable defaults/closures, CSV, O(1) LRU, non-consuming batch
validation, return contracts, scheduler state/aliasing and linear sessionization.
Heldout-only: both 16/16 passed; mean time 80.09 → 42.95 seconds, estimated
cost ¥0.22476 → ¥0.11509 per attempt. Frozen verifier files and preserved
behavior were audited; full-access same-user isolation is not an adversarial
answer-secrecy boundary. All 40 owned Hosts shut down normally.

The earlier exploratory three-arm screen is **not** hidden: A passed 11/12,
B 12/12 and lean-framework 12/12. B fresh input was worse there (22.63K vs
13.69K per attempt), despite lower average latency/cost. Do not use one screen
or a single favorable outlier to promise savings.

## Browser regression: 36 attempts, with limitations

| Scope | Full identity (A) | Short identity (B) |
| --- | ---: | ---: |
| Real DOM page goal completed | 7/8 | 8/8 |
| DOM task compliance, allowing legitimate history recovery | 7/8 | 7/8 |
| Real screenshot + trusted-input canvas task | 2/2 | 2/2 |
| Corrected native-routing fixture, strict pass | 4/4 | 4/4 |
| Original inconsistent routing fixture, strict pass | 4/4 | 3/4 |
| Computer Use calls across all attempts | 0 | 0 |

DOM cases covered duplicate controls, delayed stock, draft correction and
multi-page reports through the production Host → `plugin_mcp` → browser-use
stdio MCP → isolated real Chromium. An external page-state oracle checked
completion. The visual task additionally required a real screenshot reaching
the model, correct digits and trusted browser input.

**Failures and scorer distinctions remain visible:**

- A draft correction timed out at 300 seconds / 57 responses without saving the
  correct draft. Usage for its final canceled request is unavailable.
- B completed that page goal but ran one forbidden, unnecessary `bash ls -la`.
  Therefore B did not pass all instruction-compliance tests.
- A used `history` once for its own page evidence. The raw all-MCP scorer marks
  this as a failure (raw A 6/8, B 7/8); the user task did not forbid history,
  so spec-based compliance is reported separately, without rewriting raw results.
- The first routing fixture served HTTP 404 while its synthetic native bridge
  claimed ready; B used seven shell calls before a correct native flow. Preserve
  that failure. A separate HTTP-200-consistent fixture reran **both** arms.
  Neither rerun nor the original fixture is native-window acceptance.

On the seven DOM pairs where both completed and usage was complete, mean time
was 49.93 → 47.35 seconds (~5.2%), **not** the coding suite’s 56.6% reduction.
Overall DOM means including the timeout were 81.23 → 45.23 seconds.
The 60 lower-level browser checks passed (engine 24, legacy contracts 30,
stdio/schema/input/image 6). Full Host-to-provider screenshot preflight passed
with a scripted provider; it is not another live-model quality result.

Real page/image tasks used background Chromium. Native routing used a synthetic
framed TCP bridge. **No physical macOS WKWebView or Windows/Linux desktop GUI
acceptance was performed.** These small samples support a narrow coding/browser
assessment, not proof of universal generalization, non-inferiority, or a guarantee
for other models. Do not attribute an isolated shell call conclusively to persona.

## Deterministic compatibility regression

The provider-boundary test pins the concise identity while retaining assertions
for permissions, Plan mode, project instructions, pagination and jobs policies.
The existing preset compatibility/stable-prompt test remains in place.
A separate scripted-provider warm-restart probe reused A’s profile/session in B:
prior history was preserved without duplicate users, the new default appeared
once, and project/global memory plus permissions remained intact. User-authored
presets are not rewritten. No installed application/profile was touched.

Commands (Rust only on V100 after source synchronization):

```sh
cargo fmt --all -- --check
python3 -B scripts/regression/check-architecture.py
cargo test --locked -j 6 -p xharness-host --lib --test basic_host
cargo clippy --locked -j 6 -p xharness-host --all-targets -- -D warnings
```

The experimental-base source passed 488 tests with eight existing ignored tests,
plus formatting, architecture boundaries and Clippy. The final port must run
these checks again; PR validation reports the results for that port. Differential
architecture freeze is checked locally with Git metadata (no Rust compilation);
the synchronized remote intentionally excludes `.git` and runs source boundaries.

## Artifact fingerprints

Raw campaign logs, manifests and usage remain in the retained isolated benchmark
evidence directory, outside the production tree. Digests identify those original
artifacts; this note is a sanitized report, not a standalone benchmark runner.
No credentials, conversation bodies or private profile files are committed.

| Artifact | SHA-256 |
| --- | --- |
| `short-persona-regression-1/manifest.json` | `917c91e400bed13b9e0895d55d9cd911f7caa8abcf7406aa413dd3b071d27a07` |
| `short-persona-regression-1/results.jsonl` | `df0ba019b72cbce9d49c922beab64f0d073cc642e32a089e14ce71f03f685c85` |
| `short-persona-regression-1/acceptance-audit.json` | `ae4e2f9b9597958edb7419e3b6c3d114176879a4189b53f35c37871bd77c9070` |
| `short-persona-regression-1/matched-report.json` | `a60885c0201674a3824ddc92618dbdeb37989b252538c4357040adecc3ce1d2d` |
| `browser-prompt-regression-1/manifest.json` | `87c62144da5087e70d797ce45e417637e52d2ce7cbbaec6faf39e9abeaa052d0` |
| `browser-prompt-regression-1/results.jsonl` | `040f34b8a58155891b3925ff5ae8c11aabee79065fe557b1f53ba05656eb8be0` |
| `browser-prompt-regression-1/vision-extra-1/results.jsonl` | `d0d74f4642813a2d25d09d71a5958170e03aee531b31821d1a5907780e602c8d` |
| `browser-prompt-regression-1/route-http-corrected-1/results.jsonl` | `d62ec4dac778994d832277e7061fa3c2077566cf5fd84b619e0f1ee686e2f15b` |
| `browser-prompt-regression-1/browser-acceptance-report.json` | `62cfc7cf03bedf7ec03f37588bd84ea6c90c5053d019d5a398891571ebd84e4c` |

Binary SHA-256:

- A: `b92fff5d19d6eea3e074a78d1ce75b4f100553b85edcd2120fe621295c54dcf0`
- B: `c55d16a2b7d32b84a100d40a0a366cfb11ee1277e3faca9a9d882e426101c9b2`
- Identical top-level tool-definition SHA-256 across the matched runs:
  `cb9c3085b6bb4b9f8ba14aefeae26297cb13b8e26c1d1d8d525b53cd4d89c691`.
