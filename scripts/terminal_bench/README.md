# Small real-agent Terminal-Bench pilot

> **Official DeepSeek comparison: use `run_paired.py`.** The approved replacement
> protocol is in [the plan](../../docs/plans/2026-09-11-official-deepseek-comparison.md).
> `run_pilot.py` below still implements the OLD Terminus-2 protocol: do not use
> it to claim an official DeepSeek comparison. No paid run under the replacement
> protocol is separate from the legacy entry point. See [preflight status](../../docs/specs/official-deepseek-comparison-results.md).

## Official paired execution

`run_paired.py` uses the actual XHarness Host and official dsh full headless,
with Harbor 0.16.1 lifecycle/grading. It validates the frozen task archive bytes,
runtime and cache checksums, and neutral image IDs BEFORE reading a credential.

```sh
python run_paired.py --binary /absolute/xharness-host --runtime /absolute/official-clean-1 \
  --tasks /absolute/tasks-pinned/tasks --wheelhouse /absolute/wheelhouse-compatible \
  --output /absolute/NEW_DIRECTORY --check
```

Replace `--check` with `--mock normal`, `--mock timeout`, or `--mock budget` to
exercise BOTH native harnesses and the independent synthetic verifier with zero
real model requests. Use a new output directory each time. Synthetic passes are
integration evidence, not Terminal-Bench scores.

Only after those gates, omit `--check`/`--mock` and supply a SINGLE JSON line
containing `api_key` on protected stdin. Never place the real key in argv, files,
shell history, container mounts or logs. The controller alone retains it.
The runner never retries an entire paid trial or changes task order after grades.

Shared limits: 600 seconds from native task submission, 65536 context, maximum
16384 output tokens/request, thinking enabled/high, temperature 1.0, top_p 0.95,
40 requests and $0.50 conservative peak/no-cache ceiling per trial; six trials
at most $3 reserved. Smaller native auxiliary output limits (e.g. title=64) stay
smaller. All main/child/auxiliary/retry requests share the same capability and
ledger. The official submission boundary is CLI launch, so its process startup
is included; XHarness submits through its running Host RPC. Startup and full
launcher elapsed times are separately retained, not presented as equal overhead.

The controller watchdog stops the whole owned container at the deadline or first
budget refusal. It also restarts the container after ordinary completion to stop
detached descendants before hidden grading. Files survive; old agent processes
do not. In-flight requests settle before the report/next trial, with unknown
usage retaining the full reservation. All-provider failures stop the batch and
are NA/INFRA_ERROR, not a zero-score model result.

All phases use Docker `network_mode: none` with the same read-only public
dependency cache and restricted Unix-socket transport. The Harbor subclass
rejects any broader phase policy and checks the actual Docker network mode and
non-privileged state before credentials. It does not build/install a privileged
network sidecar or change host networking. Hidden task/test bytes are unchanged;
only controller-side environment image/network metadata is replaced and recorded.

`protocol.json`, `paired-report.json`, `unstarted.json` and per-trial artifacts
are retained. Usage rows include response model and hashes of tool/system
payloads. Cgroup telemetry covers the WHOLE container (setup and descendants),
not just the Rust process; watchdog termination may miss peak growth after the
last sample. Missing telemetry is not reported as zero. Conservative dollar
accounting is not the provider's billing invoice.

This is evaluation tooling, not a replacement agent or a production updater. It runs the actual `xharness-host` executable and native tools inside Harbor task containers, and compares them to Harbor's actual Terminus-2 implementation. No evaluation scores are hard-coded.

## Frozen pilot

- XHarness source: `5fbf964`; Harbor: `0.16.1`.
- Terminal-Bench 2.1: `7131e4375048a0e408a8fb404b5f499d726b695b`.
- Tasks selected from metadata before results: `cancel-async-tasks`, `build-cython-ext`, `log-summary-date-ranges`.
- Same `deepseek-flash`, thinking enabled / high effort, 65536 context, maximum 4096 output tokens/request. Broker enforces the model and generation settings on BOTH agents.
- Three tasks × two agents × one trial. Alternate agent order. Task-declared CPU and memory are hard-limited. No multi-trial best-of selection.
- Per trial: 300 seconds outer agent deadline (XHarness stops at 290 seconds to allow process cleanup), 40 provider requests including auxiliary/child calls, conservative peak/no-cache $0.30 reservation ceiling. Agent setup 240 seconds; verifier 300 seconds, separate from model time. This cleanup reserve is a disclosed timing asymmetry, not perfectly equal useful execution time.
- These shortened deadlines and selected tasks are a **pilot protocol**, not an official leaderboard submission. One sample per cell cannot establish statistical significance.

## Security boundary

The real provider key is supplied to the controller as JSON on stdin. Do not put it in argv, source, `.env`, or a report. `broker.py` holds it only in memory and connects to a fixed DeepSeek HTTPS endpoint. The broker accepts only bounded chat completions for the frozen model, and denies unknown routes/models, invalid/expired trial capabilities and exhausted budgets. Failed requests retain their reservation. Provider usage corrects reservations conservatively; this is not a billing invoice.

The controller listens on host loopback for Terminus-2 and exposes a single Unix socket to task containers through a dedicated read-only directory mount. XHarness uses a container-loopback relay to that socket. No Docker socket, production workspace, SSH keys or unrelated host directory is mounted into the evaluated agent. The short-lived capability available to an agent is NOT the upstream API key; it expires at trial end/deadline and shares the trial's budget. Harbor logs may include that expired capability; do not treat them as containing a reusable provider credential.

This transport avoids requiring container access through the host firewall. It does not weaken the server firewall or bind a public HTTP service. Docker is the execution boundary, not a claim of isolation against kernel vulnerabilities. Tasks retain their declared internet policy for dependency installation.

Hidden grading is run by Harbor after the agent finishes. Do not provide oracle solutions/tests to the agent or optimize prompts against them. Grader infrastructure errors, interrupted setup and missing grades must be reported separately from wrong answers.

## Run (Linux/WZU)

1. Build the frozen source remotely with `cargo build --locked -p xharness-host-app --bin xharness-host`; retain its binary SHA-256. This repository prohibits local Windows Rust compilation.
2. Install `requirements.txt` in a dedicated Python 3.12 environment (pins key dependencies, not a complete transitive lockfile). Download the pinned task repository outside the product worktree. Pre-pull the three images specified in task metadata. Record image digests and dependency versions. Prepare the SAME neutral dependency layer for both agents: XHarness requires `rg`; Terminus-2 requires `tmux`; shell diagnostics may need `ps`. Do not change task code or expose hidden grading. The original images used in the first attempt were missing these tools; do not repeat that setup as a scored comparison.
3. Run `python -m unittest discover -s scripts/terminal_bench -v`. Run `preflight.py` inside the task image with the host mounted at `/opt/xharness/xharness-host`, and `headless.py`/`relay.py` next to it, to verify actual startup/settings/session creation without a model request.
4. Run `python scripts/terminal_bench/preflight_ipc.py` on the controller host. It launches a disposable **network-disabled** container, tests the actual mounted-socket relay and verifies unauthorized requests cannot reach the provider. This makes zero real API calls.
5. Supply protected stdin JSON `{api_key: ...}` to `python scripts/terminal_bench/run_pilot.py --binary /absolute/xharness-host --tasks /absolute/pinned/tasks --output /absolute/NEW_DIRECTORY`. Use an actual JSON object; placeholder above is explanatory only. Output directory must not already exist.
6. Read `protocol.json`, `pilot-report.json` and every trial's `result.json`, `agent/` and `verifier/` evidence. Broker usage is the accounting authority across auxiliary calls; the agent's claim of completion is not the correctness authority. Never silently omit a failed trial.

The initial bridge-TCP attempt (`runs-1`) reached zero provider calls because host firewall rules blocked container-to-host TCP. It was interrupted and retained as an infrastructure failure, not a scored trial. Subsequent runs use the verified Unix-socket transport.

The first paid attempt (`runs-2`) is **incomplete and unscored**, not a 0% result. See [pilot results](../../docs/specs/terminal-bench-pilot-results.md). After that attempt, the adapter was fixed to report its deadline as Harbor's `AgentTimeoutError`, allowing normal grading after a timeout. A bounded dependency endpoint probe now runs before either agent activates model credentials, and the controller stops the batch after a pre-model infrastructure failure. These fixes passed contract tests but have NOT yet produced a successful live graded batch. A reachable endpoint alone is not proof that installation or verification will succeed.

## Files

- `broker.py`: auth, deadlines, reservations, fixed upstream, usage records.
- `relay.py`: container-local HTTP TCP to a single broker Unix socket.
- `headless.py`: actual Host startup, permission configuration inside sandbox, task RPC and cleanup.
- `agents.py`: pinned Harbor adapters; no new reasoning loop.
- `run_pilot.py`: frozen selection/order, isolated trials, grading and report persistence.
- `health.py`: bounded dependency reachability check before paid calls.
- `test_*.py`, `preflight*.py`: offline and zero-bill integration checks; not model-quality evidence.

## Official comparison preflights (zero model requests)

`dependency_proxy.py` exposes only a private Unix socket, mounted into a disposable
network-disabled container. It permits exact public dependency hosts, validates
resolved addresses before connecting, and bounds time, bytes and concurrent
handlers. It does not expose the model API or a host TCP listener. CONNECT retains
end-to-end TLS; it cannot restrict methods/paths within allowed encrypted hosts.
The policy is restricted artifact access, not arbitrary internet access.

`proxy_exec.py` selects the Tsinghua PyPI mirror and the official Astral CDN for
the task's pinned uv 0.9.5 installer. It does not upgrade task Python/Cython/NumPy
versions or weaken TLS/APT signature verification. These transport differences
are applied to both groups by the paired Harbor environment and recorded before
scoring; the legacy Terminus adapter does not integrate this bridge.

On the evaluation host, from this directory:

```sh
python preflight_dependencies.py
python preflight_oracle.py --tasks /absolute/pinned/tasks --task cancel-async-tasks --output /absolute/NEW_PREFLIGHT_DIR
python preflight_official.py --runtime /absolute/official-runtime --output /absolute/NEW_MOCK_DIR
```

The oracle preflight deliberately exposes the official solution only in its own
grader-only container, never an agent image. Preserve failed directories and
keep oracle/verifier logs private. Do not commit or reuse an oracle container.
No output directory may be reused. A reward file without consistent executed
CTRF tests is an infrastructure error, not a score; inspect failed test logs too.

For a locally downloaded Cython source bundle, pass `--source-bundle PATH
--source-sha256 LOWERCASE_SHA256` to `preflight_oracle.py`. The bundle is checked
again after copying into the isolated grader container; its 0.5.3 checkout must
match the pinned commit. This bypasses only that fixture's GitHub download, not
APT/PyPI preparation, and is not yet wired into scored agent trials.

The validated mock launcher `official_headless.py` expects `node` and
`dsh-official/node_modules/@deepseek-ai/dsh/lib/bin.js` below the runtime root.
It is integrated through `deepseek_agent.NativeAgent`. A clean Linux install from the
checked-in `official-package.json` and `official-package-lock.json` passes
`npm ls --all`, all five native-module probes, and actual native `bash` execution
against a mock provider. Do not reuse the earlier failed runtime trees.

### Reusable environment preparation

1. In a new staging directory, copy `official-package.json` as `package.json`
   and `official-package-lock.json` as `package-lock.json`. Run
   `node collect_npm_cache.cjs STAGING NPM_NODE_MODULES [EXISTING_CACACHE]` on a
   machine with registry access. The collector selects Linux x64 glibc artifacts,
   verifies npm integrity, and copies no user npm configuration or credentials.
2. Archive that staging directory, record SHA-256, forward with SSH, and verify
   the same hash on Linux before extraction. With Node 22.19.0 / npm 10.8.2 run
   `npm ci --prefix RUNTIME/dsh-official --offline --cache STAGING/cache
   --legacy-peer-deps --ignore-scripts --no-audit --no-fund`. The manifest declares
   required peers explicitly; verify `npm ls --all`, not just installer exit 0.
   Preserve the Node binary and lockfile hashes. No Windows node_modules tree is
   used. The Linux runtime root also contains the pinned `node` executable.
3. Run `prepare_environment.py --task TASK --output NEW_DIRECTORY` once per task.
   This adds only neutral OS tools and refuses to commit if Python packages
   change. For Cython, also pass the verified public `--source-bundle` and
   `--source-sha256`. The result holds a bare original repository cache and an
   exact Git URL mapping; `/app/pyknotid` is not prepopulated. Both agents must
   still clone and repair the original project themselves.
4. Prepare public original PyPI wheels/source distributions for CPython 3.13
   Linux x64, including build and verifier requirements. Never forward a wheel
   built from an oracle's repaired checkout. Mount the cache read-only through
   `preflight_oracle.py --wheelhouse PATH --offline-wheels`; this prevents pip
   preferring an unreliable online index over an equally versioned local file.
   The cache does not install or upgrade anything in the initial agent image.
   Use the checked-in `python-artifacts.sha256` inventory: planarity must be 0.6,
   not 1.0.0 (which drops the node attribute expected by the old task project).
   Verify `sha256sum -c /absolute/python-artifacts.sha256` inside the cache.
   Preserve the original image's NumPy 2.3.0; the cache is not a requirements
   list to install wholesale. Apply the same selection to BOTH groups.
5. Test both launchers on the SAME `--image sha256:...` with
   `preflight_official.py --harness official --runtime RUNTIME --output NEW_DIR`
   and `preflight_official.py --harness xharness --binary HOST --output NEW_DIR`.
   Both must return a real native tool result and exit cleanly. These are
   functional mock tests, not a comparison of normalized model budgets.
6. Run each `preflight_oracle.py --prepared-image sha256:...` with a new output
   directory. `--oracle-seconds 600` is a reference setup allowance, not a change
   to the paid agent protocol. `--verifier-showlocals` optionally expands private
   diagnostic tracebacks without changing tests or scoring.

Current artifact identities, evidence and remaining gates are recorded in the
[environment report](../../docs/specs/official-deepseek-comparison-results.md).
The paired runner above integrates both adapters and the shared protocol.
Preparation commands themselves never enable paid calls.
