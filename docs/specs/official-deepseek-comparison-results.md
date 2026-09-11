# Official DeepSeek comparison: preflight checkpoint

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
