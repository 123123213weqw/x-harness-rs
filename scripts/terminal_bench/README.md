# Small real-agent Terminal-Bench pilot

> **Official DeepSeek comparison: preparation only.** The approved replacement
> protocol is in [the plan](../../docs/plans/2026-09-11-official-deepseek-comparison.md).
> `run_pilot.py` below still implements the OLD Terminus-2 protocol: do not use
> it to claim an official DeepSeek comparison. No paid run under the replacement
> protocol is enabled yet. See [preflight status](../../docs/specs/official-deepseek-comparison-results.md).

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
must be applied to both groups and recorded before scoring; the production
Harbor adapters do not yet integrate this bridge.

On the evaluation host, from this directory:

```sh
python preflight_dependencies.py
python preflight_oracle.py --tasks /absolute/pinned/tasks --task cancel-async-tasks --output /absolute/NEW_PREFLIGHT_DIR
python preflight_official.py --runtime /absolute/official-runtime --output /absolute/NEW_MOCK_DIR
```

The oracle preflight deliberately exposes the official solution only in its own
grader-only container, never an agent image. The Cython oracle needs the checkout
specified by the task instruction; this fixture is NOT an allowed head start for
scored agents. Preserve failed directories and keep oracle/verifier logs private.
No output directory may be reused. A reward file without consistent executed
CTRF tests is an infrastructure error, not a score; inspect failed test logs too.

For a locally downloaded Cython source bundle, pass `--source-bundle PATH
--source-sha256 LOWERCASE_SHA256` to `preflight_oracle.py`. The bundle is checked
again after copying into the isolated grader container; its 0.5.3 checkout must
match the pinned commit. This bypasses only that fixture's GitHub download, not
APT/PyPI preparation, and is not yet wired into scored agent trials.

The experimental `official_headless.py` currently expects `node` and
`dsh-official/node_modules/@deepseek-ai/dsh/lib/bin.js` below the runtime root.
It is a mock-only launcher, NOT a validated Harbor adapter. Its normal npm
installation mixed rc.1/rc.2 packages and failed native tool execution.
`official-package.json` records the attempted all-rc.1 override experiment;
installation did not complete and it is **not a verified dependency lockfile**.
Do not run a billed comparison with either unvalidated runtime tree.
