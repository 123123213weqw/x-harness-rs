# Official DeepSeek comparison: first paired pilot results

## Completed real batch: `paired-live-1`

**Outcome: XHarness 2/3 tasks; official full-headless 3/3 tasks.** All six trials
have independent verifier evidence; none is missing or an infrastructure NA.
These are three selected development tasks, one sample per cell on Linux, NOT a
leaderboard result or evidence of general superiority. The XHarness candidate
is the frozen PR #54 source identified below, not a claim about current main or
the Windows desktop UI.

| Task | XHarness | Official DeepSeek full-headless |
|---|---|---|
| cancel-async-tasks | FAIL, 0/6 checks | PASS, 6/6 checks |
| build-cython-ext | PASS, 11/11 checks | PASS, 11/11 checks |
| log-summary-date-ranges | PASS, 2/2 checks | PASS, 2/2 checks |

Both Cython trials hit the 40-request limit. Grading the retained workspaces
still passes: termination reason and final correctness are separate facts.
No trial was selectively rerun. `unstarted.json` is empty, every ledger has zero
in-flight requests, and all six owned task containers were removed afterward.

### Tokens, requests and conservative cost

Input counts are cumulative across requests, NOT peak context occupancy.
Output includes reasoning. Costs here charge all input at the peak cache-miss
rate and retain a full reservation for missing usage; they are NOT an invoice.

| Task / agent | Requests | Input tokens | Output tokens | Cache-hit input | Conservative USD bound | End-to-end seconds |
|---|---:|---:|---:|---:|---:|---:|
| Async / XHarness | 5 | >=8,908 | >=28,818 | >=7,296 | 0.059734 | 168.7 |
| Async / official | 14 | 219,306 | 14,699 | 208,512 | 0.083431 | 215.5 |
| Cython / official | 40 | 1,126,873 | 19,097 | 1,074,432 | 0.360978 | 243.8 |
| Cython / XHarness | 40 | 853,185 | 10,941 | 826,240 | 0.269085 | 232.2 |
| Logs / XHarness | 6 | 36,578 | 2,075 | 30,976 | 0.013463 | 53.1 |
| Logs / official | 7 | 66,588 | 2,369 | 61,696 | 0.022819 | 54.4 |

Total: **112 provider requests**, conservative bound **$0.809510**, below the
$3 batch ceiling. One cancelled XHarness async auxiliary request has no usage;
its $0.0224796 reservation is retained. All other 111 requests have usage.
Known total input/output are 2,311,438 / 77,999, with 54,487 reasoning tokens
included in output. All observed provider model IDs are `deepseek-flash`.

Using the known cache hit/miss counts and peak cache-aware prices yields about
$0.137540 for the KNOWN usage alone, excluding that unknown auxiliary call.
This is a price-based estimate, not an account balance or billing reconciliation.
Cache state was not controlled; hit counts and interleaved ordering are retained.

Only compare efficiency on the two tasks BOTH passed:

| Shared passing tasks combined | XHarness | Official |
|---|---:|---:|
| Input tokens | 889,763 | 1,193,461 |
| Output tokens, including reasoning | 13,016 | 21,466 |
| Provider requests | 46 | 47 |
| Conservative USD bound | 0.282548 | 0.383798 |

For these two samples, XHarness used **25.4% less input** and **39.4% less
output**, with complete usage evidence. This does not excuse the async failure,
nor establish a general efficiency advantage from only two shared passing tasks.
End-to-end seconds include environment setup, grading and cleanup; they are not
pure model latency or identical effective agent execution time.

### Concrete async failure and next optimization hypothesis

XHarness stopped at a native `LOOP_FAILED` error: locally estimated input 61,563
exceeded the available 48,128 under the 65,536 context / 16,384 output / 1,024
safety configuration. Overflow compaction then rejected a checkpoint estimated
at 828 versus its 771-token source range. This was not a provider confirmation
that the true input was 61,563 tokens and not an installer/network failure.

Source inspection shows the cold calibration path uses conservative serialized
wire units until eight similar samples are available; distribution changes also
fall back conservatively. The shrinkage guard correctly refuses to replace a
range with a larger checkpoint, but this run has no successful recovery afterward.
The first provider response used its entire 16,384 output allocation on reasoning;
the async attempt's known reasoning total is 27,705. These observations point to
the interaction of cold input estimation, lengthy reasoning and the compaction
recovery path, not proof that tool count or Rust execution speed caused failure.

A separate authenticated, bounded capability probe after the failure confirmed
the provider itself returns **404** for `/chat/completions/input_tokens`; it made
no generation request. The broker's unsupported-route fallback therefore did not
hide an available counter endpoint in this test.

The frozen wrapper labeled a settled Host session `COMPLETED` even though its
native turn reason contained this error. The original raw report is preserved;
the FAIL grade above is unaffected. A POST-BATCH wrapper-only regression fix now
labels such inner failures `AGENT_ERROR` while still running independent grading.
It was not applied during the scored batch and is not presented as an improvement
to the evaluated agent. No product Rust, prompt, history or compaction code was
changed in this batch.

Next controlled optimization should target this cold estimation/recovery path,
with an explicit reproduction and safety regression tests before another paired
batch. Do not simply remove the shrinkage guard, silently lose historical output,
or compare only the successful trials. No extra paid retry or product change has
been performed based on these scores.

### Resource scope and retained evidence

On the shared passing log task, whole-container peak memory was approximately
35.6 MiB (XHarness) versus 137.3 MiB (official). These are headless Linux task
containers including setup and descendants, not desktop App RAM measurements.
Cython peaks were approximately 655 / 731 MiB respectively and include compilers;
their last pre-termination samples may miss up to 3 seconds of peak growth.

Private evidence under the remote root listed below:
`paired-live-1/protocol.json`, `paired-report.json`, `unstarted.json`, and
`trials/<task>--<harness>/{agent,verifier,result.json}`. Oracle/hidden-test contents,
raw prompts, API keys and expired trial capabilities are not published here.
The real key was supplied via non-echoing SSH stdin, not argv/files or containers.

---

## Paired runner acceptance and live batch (2026-09-11)

The paired integration gates are now implemented in `run_paired.py`, separate
from the historical Terminus-2 entry point. Runtime code was frozen at `038ad60`
before `paired-live-1` started with the user's approval. Do not interpret the
older NOT_READY checkpoints below as the current runner state.

| End-to-end mock | Both actual native harnesses | Independent synthetic verifier |
|---|---|---|
| `paired-mock-normal-final` | COMPLETED | PASS for both |
| `paired-mock-timeout-final` | TIMEOUT, whole-container cleanup | PASS for both retained marker files |
| `paired-mock-budget-final` | BUDGET_LIMIT at three permitted mock calls | PASS for both retained marker files |

All six integration checks used zero real model requests, and WZU passed 47
tooling tests before launch. Earlier failed mock attempts remain recorded:
`normal-1/2` used an invalid synthetic task package name; `normal-3/5` attempted
Harbor's unnecessary egress-sidecar build; `normal-4` used an invalid network
enum; `normal-6` lacked the matching static-network capability declaration.
These were setup errors with zero provider calls, not agent-quality scores.

The final environment subclass enforces Docker's actual `network_mode: none`,
rejects broader/dynamic phase policies and checks non-privileged state. Both
groups use the same restricted public artifact socket and read-only cache;
no host firewall changes or privileged network sidecar are used. Official
hidden test bytes and task instructions are verified against the pinned source
archive and unchanged. Only controller-side image/network metadata differs.

Frozen live protocol: 600 seconds from native task submission, 65536 context,
16384 output ceiling, thinking enabled/high, temperature 1.0, top_p 0.95,
40 total requests and $0.50 peak/no-cache reservation ceiling per trial, six
trials maximum ($3). Smaller native auxiliary limits remain smaller. Official
CLI process startup is included in its submission window; XHarness submits
through its already-running Host RPC. This residual startup difference is
disclosed, not presented as identical startup work.

Price/model metadata was verified from the live
[official pricing page](https://api-docs.deepseek.com/quick_start/pricing)
on 2026-09-11: `deepseek-flash` is V4.1 Flash, peak input miss $0.30/M,
peak output $1.20/M. The search index contained older V4 pricing, so the live
HTTPS page was checked directly. These rates are conservative reservation
inputs, not a billing invoice. Actual response model identifiers are retained.

`paired-live-1` is the first real official paired batch and completed all six trials.
No test-time prompt/dependency/protocol changes or selective retries are allowed.
Unknown provider usage retains its reservation; known token totals are lower
bounds when a cancelled auxiliary request supplies no usage. Independent grader
results, native turn errors and wrapper exit status must be reported separately.

---

## Clean installation and environment acceptance (2026-09-11)

This section supersedes the older checkpoints below. All work in this follow-up
used **zero real model requests**. No production App, host firewall, global proxy,
DNS or model credentials were changed. Installation artifacts are retained for
reuse on WZU; earlier failed runtime trees are not reused.

| Gate | Evidence | Result |
|---|---|---|
| Complete official runtime | `official-clean-1`, offline clean Linux `npm ci`, `npm ls --all` | PASS; required peers explicitly declared, all official components rc.1 |
| Native modules | builtin addon, koffi, sharp, system addon, node-pty | All five load and exit 0; no SIGBUS |
| Official native tool | `official-mock-final`, clean async image | PASS; real `bash` / `pwd`, 3 mock requests, exit 0 |
| XHarness native tool | `xharness-mock-final-2`, same async image | PASS; real `bash` / `pwd`, 3 mock requests, exit 0 |
| Async oracle + verifier | `oracle-async-final` | PASS; 6 tests, 0 failed |
| Log oracle + verifier | `oracle-log-final` | PASS; 2 tests, 0 failed |
| Cython oracle + verifier | `oracle-cython-10` | PASS; 11 tests, 0 failed; separate public repository diagnostic 18/18 |
| Tooling regression suite | Windows / WZU | 38 tests: Windows 35 pass + 3 environment skips; WZU 38 pass |
| Paid comparison integration | Existing `run_pilot.py` | NOT_READY; still legacy Terminus-2 adapter and old 290/300 s, 4096-token, $0.30 settings |

The functional mocks preserve 26 official tools and 17 XHarness tools. They do
not establish equal generation settings: the old XHarness launcher still uses
4096 output tokens, while the official main mock uses 16384 (auxiliary title
requests use 64). No token-efficiency or agent-quality conclusion follows.

### Retained environment identities

Remote root: `/home/wzu/codex-build/x-harness-rs/tbench-pilot-20260911`.
Use its `venv/bin/python` (Python 3.12.14, Harbor 0.16.1), `adapter/`,
`official-clean-1/`, `xharness-host`, and `tasks-pinned/tasks`.
XHarness binary/source, task revision and Node identities remain as recorded in
the runtime-identity section below. Official npm artifact identity is pinned;
its correspondence to an upstream Git SHA is still **not verified**.

- Verified lockfile SHA-256:
  `3330bea6e9351a27c3531ffdbf6f47d6a4ac7da63ed405633aabfdda09173388`.
  `official-package.json` declares 236 fixed dependencies and overrides;
  `official-package-lock.json` fixes the complete artifact graph.
- Forwarded npm cache: 503 Linux-compatible public original artifacts,
  `transfer-3185838e/clean-cache.tar`, 80,548,864 bytes, SHA-256
  `d4447bb8abfdf76fa277ae2c9833d0a575a3c0f6b1fafb694372ba93e645efa9`.
  npm 10.8.2 installs offline on Linux; it does not reuse Windows node_modules.
- Public source bundle: SHA-256
  `5c77c9b81dec173e146bb582ff0f8377c8d595273345a54dba11b6f9f96ad83f`,
  tag 0.5.3 at `441c807dbec2ee32e1da572e24e58d52a4eb7afa`.
- Public original Python distribution archives:
  `wheelhouse.tar`: `f26c6d36ee6e68f6158d49448c408e45227c69624785cec208d13cc0c399031f`;
  `wheelhouse-pinned.tar`: `ef47e71018ea9708d9f625ac2fab14ab64519b817606ae3bb8a6f40d337838c3`;
  `wheelhouse-grader.tar`: `08cae2c946f9c57f2b48a158142dd7d1141f68e624a17ca5d8e7adb837bfee00`.
  Final compatible selection is `transfer-3185838e/wheelhouse-compatible`,
  mounted read-only with offline pip. It replaces the original planarity 1.0.0
  distribution with the public planarity 0.6 source archive, SHA-256
  `9852691d9c0d05e26a2fcbf2fce5a2632e8847ec462e816fa02e72d35013da68`.
  Includes setuptools 80.9.0, Cython 3.1.3, pytest 8.4.1 and
  pytest-json-ctrf 0.3.5. Exact cached files are listed in
  [the checksum manifest](../../scripts/terminal_bench/python-artifacts.sha256).
  No oracle-repaired project wheel is forwarded. A cached NumPy 2.5.3 wheel is
  available but NOT installed; the original image and passing verifier retain
  the required NumPy 2.3.0. Cache inventory is not an installed-package list.

Clean image IDs (committed BEFORE any oracle, tests or agent task):

| Task | Manifest directory | Image ID |
|---|---|---|
| Async | `neutral-async-1` | `sha256:051de08970a9b9fe32918a897b29100fc27a5c6825daac525eba96bd65a179c7` |
| Log | `neutral-log-1` | `sha256:617c818d28f27f6dc87cdbb96025a839529a01e8a8306ecd7728660313c2c7de` |
| Cython | `neutral-cython-2` | `sha256:f3165ea87eb47f2ecfca1f1234867f46e24289968317a5cd23b489202f62db53` |

Preparation adds curl/ripgrep/procps without changing the original Python package
list. Cython retains NumPy 2.3.0 and pip 25.2. Only the original bare public Git
repository is cached under `/opt/benchmark-sources`, with an exact URL mapping
inside the image; `/app/pyknotid` is NOT created. Agents must still clone and
repair the task. Caches/transport must be identical for both scored groups.

### Additional preserved attempts

- `oracle-cython-4`: 300-second reference setup timeout while installing deps.
- `oracle-cython-5`: online pip preferred the index over cached files; received
  truncated index JSON and failed installation. Not an agent score.
- `oracle-cython-6`: reference compiled/installed successfully, but the offline
  cache lacked verifier pytest distributions; no CTRF, therefore INFRA_ERROR.
- `oracle-cython-7` / `8`: completed verifier and retained actual failures;
  verbose tracebacks alone still abbreviate the inner subprocess output.
- `oracle-cython-9`: separate public repository diagnostic located the failure:
  planarity 1.0.0's graph output lacks the `pos` node attribute used by the old
  project. This is an unbounded dependency compatibility failure, not an agent
  quality result. Official grade remains FAIL (10/11); it was not overwritten.
- `oracle-cython-10`: a NEW clean container with planarity 0.6 as the sole
  planarity artifact passes the unmodified oracle/verifier, 11/11. The separate
  public repository diagnostic passes 18/18. No task/source/test edits were
  made. This dependency policy is now frozen before any paired model trial and
  must be identical for both groups; it is not an unmodified online-latest run.
- `xharness-mock-final`: mock returned HTTP 400 for an unsupported token-count
  route, preventing fallback. Returning the correct unsupported-route 404
  enabled XHarness's existing fallback; no product code was changed.

Oracle/private verifier logs are never exposed to scored agents. Diagnostic
retests are recorded separately and cannot replace the original official grade.
All owned `xhbench-*` containers were absent after the completed checks; unrelated
workloads were left untouched. Environment acceptance is complete, but the paid
Harbor integration and shared protocol gates are not. No paid trial was started.

---

## Historical checkpoints (superseded where noted above)

## Local forwarding follow-up (2026-09-11)

The user's local-download/SSH-forward approach works. No host network settings
were changed and no real model requests were made. This follow-up supersedes
the earlier claim that no consistent-version npm tree could be downloaded,
but **does not mark the environment or official adapter ready**.

- Forwarded `pyknotid 0.5.3` Git bundle (2,087,284 bytes), SHA-256
  `5c77c9b81dec173e146bb582ff0f8377c8d595273345a54dba11b6f9f96ad83f`.
  Local and remote hashes match; remote Git fsck passes; tag resolves to
  `441c807dbec2ee32e1da572e24e58d52a4eb7afa`.
- Added `preflight_oracle.py --source-bundle PATH --source-sha256 HASH`, restricted
  to the Cython grader-only fixture. It checks the transferred and copied bytes
  and the expected checkout commit. It does not preload a solution for an agent.
- `oracle-cython-3` timed out after 240 seconds during Debian index download,
  before the new fixture stage or any hidden tests. The original failure is
  retained; no Cython grader PASS is claimed.
- Local npm normal peer resolution emitted conflicting override diagnostics.
  An experimental `--legacy-peer-deps --ignore-scripts --os=linux --cpu=x64
  --libc=glibc` install then encountered ECONNRESET; one cache-assisted retry
  completed. All 267 installed DeepSeek package instances checked as rc.1.
  However, this success did NOT guarantee a complete or uncorrupted runtime.
- Forwarded runtime archive: 76,242,908 bytes, SHA-256
  `5f77935717055879ab58f88dfde3fe89868099e4470805230c5ada0547ad01d4`.
  Both hosts agree. Its original package-lock SHA-256 is
  `e29bb016120aeb344e8079873f284a2c35b3cae9e1cace9a4aa7baf1f5cf551f`.
  These hashes identify a FAILED experimental tree, not an approved build.

| Attempt | Actual result |
|---|---|
| `official-mock-2` / `official-forwarded-1` | Missing `cordis-plugin-group`; zero mock and real requests |
| `official-mock-3` / `official-forwarded-2` | Added declared Cordis peers via a separately forwarded overlay; process SIGBUS before requests |
| Native module probe | `node-addon-require-builtin` and sharp caused SIGBUS; koffi, system addon and node-pty loaded successfully |
| `official-mock-4` / `official-forwarded-3` | Re-extracted same-version original addon/sharp npm tarballs on Linux; startup moved past its initial crash but loader failed on missing peer packages, including `dsh-scope`; zero requests |
| Repeated native probe on forwarded-3 | Builtin addon now loads; sharp still SIGBUS (its shared-library chain is not yet verified); other three probes pass |

The installed builtin addon's hash differed from the file extracted from its
same-version original npm tarball. This is evidence of an incomplete/corrupted
installed tree, consistent with the interrupted installation, not proof of a
Windows/Linux incompatibility in official source. Replacing that exact artifact
removed its isolated SIGBUS. Peer resolution was bypassed only as a diagnostic
experiment and left many dependencies absent/unreachable. Do not fix this by
ignoring loader failures or by altering official code.

The transferred overlays and raw tarballs are preserved under
`transfer-3185838e`. Runtime snapshots and all mock outputs are separate; no old
runtime or production App was overwritten. The 30-test suite passes on WZU;
Windows passes 27 with 3 environment-specific skips. The prior `ff664f0` PR CI
completed green; this does not certify the later runtime experiments.

Next installation should be a clean, complete dependency resolution from
verified original artifacts (including peers), with integrity and native-module
checks before the headless mock. Reusing the partially unpacked Windows
node_modules tree is not a reliable scored-run setup. Both the Cython grader gate
and official native-tool gate remain incomplete; paid comparison remains paused.

---

Date: 2026-09-11. **Preparation only; no scored comparison and no real model
requests in this checkpoint.** The old, incomplete Terminus-2 paid attempt is
reported separately in [the prior results](terminal-bench-pilot-results.md).

## Gates and current status

| Gate | Observed result | Remaining requirement |
|---|---|---|
| Isolated dependency transport | PASS: real HTTPS PyPI-mirror fetch, complete signed Debian index, private-address rejection in a network-disabled container | Apply the same transport to both actual Harbor adapters and record neutral image manifests |
| Async oracle + independent verifier | PASS: 6 executed, 0 failed | This validates the grader, NOT either agent |
| Log oracle + independent verifier | PASS: 2 executed, 0 failed | This validates the grader, NOT either agent |
| Cython oracle fixture | INFRA_ERROR: checkout failed before oracle/tests | Reliable access to the instruction's GitHub repository |
| Official full-headless CLI startup | `--help` succeeds with Node 22 in the isolated container | Startup alone is insufficient |
| Official native tool mock | FAIL: 2 mock requests, zero real requests, exit 1, no tool result | Validated consistent official runtime and a passing tool/settlement mock |
| Shared 600 s / 16384 output / $0.50 protocol | Not implemented | Replace old hard-coded settings and test both adapters before live calls |
| Paid paired trials | NOT_STARTED, all 6 | All previous gates plus budget checkpoint |

Do not run the existing `run_pilot.py` for this comparison: it still selects
Terminus-2 and the old protocol. No win rate, token-efficiency improvement or
agent-quality conclusion can be drawn from these preflights.

## Preserved attempts

Evidence stays in the evaluation host's private `tbench-pilot-20260911` directory.
Oracle and hidden-test contents are not included in this report or agent inputs.

| Directory | Outcome / reason |
|---|---|
| `oracle-preflight-1` | APT rejected incomplete HTTP framing (`NOSPLIT`); proxy Content-Length forwarding fixed |
| `oracle-preflight-2` | uv installer redirect to official Astral release host denied; exact host allowlist extended |
| `oracle-preflight-3` | GitHub uv artifact download interrupted; installer could not produce uv |
| `oracle-preflight-4` | Async official oracle/verifier PASS after selecting the supported official Astral CDN for the same uv 0.9.5 artifact |
| `oracle-cython-1` | Official solve script assumes the instruction's checkout exists; no tests executed |
| `oracle-cython-2` | Grader-only instruction checkout added; Git CONNECT returned 403 before oracle ran. Direct host HTTPS probe also timed out during GitHub TLS negotiation |
| `oracle-log-1` | Transient ripgrep package download timeout during neutral preparation |
| `oracle-log-2` | Log official oracle/verifier PASS after one bounded APT retry was enabled |
| `official-mock-1` | Official runtime reported `Cannot read properties of undefined (reading 'prepare')`; native tool did not complete |
| `official-runtime/dsh-pinned` | Fresh all-rc.1 install timed out at npm reify; no complete lockfile or usable CLI produced |

Proxy 403 intentionally combines policy rejection and upstream connection failure;
the GitHub probe supports a transport problem, not a definitive diagnosis of the
network's root cause. No firewall, global proxy, DNS or host networking was changed.
All owned preflight containers and install processes were stopped; unrelated
server processes were left untouched. Failed directories are retained.

## Runtime identity and reproducibility limits

- XHarness source under evaluation: `5fbf964067149ff448ba25b2343a3dae733fe028`
  (PR #54 candidate, not a claim that upstream merged it).
- XHarness binary SHA-256:
  `c108aa8ebfd38222c01f9e2b31d33b24d0cad3884a67a348add48039c46f61f5`.
- Task revision: `7131e4375048a0e408a8fb404b5f499d726b695b`.
- Harbor 0.16.1, Python 3.12.14, Node 22.19.0.
- Node extracted from official image
  `node@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90`;
  executable SHA-256 `596b5144ff242737f1c1be6a5f0ccb3907dbba2482344143cb1a6898633402a9`.
- Official root npm package: `@deepseek-ai/dsh@0.1.5-rc.1`, tarball SHA-1
  `6bcdb554bf2eef837666e37f5bd5fa494eb053e4`, registry integrity
  `sha512-rmNmzQCg3oIc1z8xH7izRSOuy1TNzq+/NILyfM+7e8DKOyV+yBtg47WEsqR2SiIe1ATec3L/rUa1YhIcfQ2XEg==`.
  Its registry metadata has no `gitHead`; no artifact-to-source SHA mapping was
  verified. The observed upstream master SHA
  `c291e7961a515f6d7af9304e7fd1d257929aef26` is NOT assigned to this npm artifact.

The first completed npm tree mixed rc.1 CLI and rc.2 DeepSeek components because
of dependency ranges. This is a plausible cause of the mock failure, not a proven
root cause. The attempted replacement manifest pins 231 observed DeepSeek package
names to rc.1, but its install did not finish; it must not be called a validated
lockfile. A scoped `UV_USE_IO_URING=0` install completed once, but subsequent
fully pinned installation still stalled; that flag is not a proven general fix.

Before scoring, either build the official source at an exact commit with its
supported toolchain, or explicitly revise the version protocol to a verified npm
artifact plus complete dependency lock. Do not patch the official agent loop to
make the benchmark pass.

Observed original task image digests:

| Task | SHA-256 |
|---|---|
| cancel-async-tasks | `84c7fae6b256dcc56a350790e2a9715eefc7dad662a9d8e8a472363aa71ef18d` |
| build-cython-ext | `3612a38fadb89a96f74a1a951fb0b0af734198fd160571eeaba6401593234594` |
| log-summary-date-ranges | `cbeb6ba905c2fec294f16cd5e16e3ea7f2e04d38ac2484d51a11de262aa7dc51` |

Preflight commands still resolve the task's image tag; these observed digests
must become enforced immutable inputs in the scored runner. No oracle container
was committed as a reusable agent image.

## Verification and unfinished work

- Windows Python suite: 29 tests, 26 passed, 3 environment-specific skips.
- WZU Python suite with pinned Harbor: 29/29 passed, no skips.
- These checks are zero-model unit/contract checks, not performance scores.
- No Rust source changed or local Windows Rust compilation ran.
- Official wrapper is experimental and mock-only; no Harbor official adapter yet.
- Wrapper cleanup signals its process group even after the leader exits. Detached
  descendants still require container-level quiescence before hidden grading;
  that scored-adapter gate is not implemented yet.
- Official title generation uses a small output cap and thinking disabled. Shared
  budget enforcement must count auxiliary requests without blindly expanding
  their caps or enabling thinking; settle the precise rule before the paid batch.
- Do not carry over old 290/300-second or 4096-token settings. Build one immutable
  protocol driving both wrappers and broker, including in-flight accounting.

The first execution batch remains incomplete. Repeated environment/runtime
failures triggered a checkpoint rather than a billed retry loop. Next proposed
step: use the official source lockfile/toolchain for the runtime, and prepare
hash-verified source/dependency artifacts for the blocked GitHub download, equally
available to both groups without changing the initial coding task or verifier.
