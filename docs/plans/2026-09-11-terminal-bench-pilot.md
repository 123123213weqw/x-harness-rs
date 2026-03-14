# Terminal-Bench small pilot implementation plan

**Goal:** Run three fixed public Terminal-Bench 2.1 tasks with real XHarness and Terminus-2 using the same DeepSeek Flash endpoint; report external verification, usage, cost bounds and failure traces.

**Architecture:** Pin Harbor and task Git revisions. Harbor owns disposable Docker task environments and the verifier; XHarness uses its actual compiled host and native tools inside the task container through a thin headless RPC adapter. Reference uses Harbor's Terminus-2. An evaluator-side credential broker holds the real API key outside agent containers, limits requests/output/cost, and records usage only. No production installation, sessions, releases, host Docker socket or unrelated host paths are exposed to either evaluated agent.

**Tech stack:** Python 3.12 / Harbor 0.16.1, Docker, Rust host built on WZU only, DeepSeek OpenAI-compatible API.

## Steps

1. Validate remote Docker access and available disk; install isolated evaluation dependencies; pin source and task commits. Select three non-GPU tasks from metadata before inspecting solutions or results. Do not send oracle solutions/hidden verifier tests to models. Record deviations such as shorter pilot deadlines explicitly.
2. Add adapter, bounded credential broker and offline security/adapter tests under `scripts/terminal_bench/`. Verify auth denial, wrong endpoint/model denial, budget exhaustion, no credential persistence, terminal status/error handling and cleanup. Benchmark failures must not trigger unbounded retries.
3. Run no-agent/oracle environment checks only with isolated verifier access, then six real trials, sequential or at most two concurrent. Alternate harness order. Freeze task set and parameters; do not tune to hidden tests or selectively rerun failures. Preserve infrared/transport failures separately from task failures.
4. Report all six outcomes and evidence, comparing pass/fail, input/output/cache/reasoning, elapsed time, cost, tool and provider failures. No significance or leaderboard claim from three tasks. Keep benchmark tooling separate from product runtime changes; submit reusable code upstream without changing the running App.

## Initial budget

Per trial: 300 seconds agent time, at most 40 provider calls, maximum 4096 generated tokens per call, and a conservative $0.30 peak-rate no-cache charge reservation cap. Six trials therefore reserve at most $1.80. Failed/ambiguous API requests keep their reservation. Reserve input using UTF-8 serialized request bytes plus a conservative protocol overhead, rather than claiming an exact tokenizer count. Deny requests that exceed this estimate's budget. Record actual reported token usage separately; do not call reservation an invoice. Task image builds and verifier time are separate and bounded. If setup cannot safely support this protocol, report the blocker rather than running agents directly on the shared server.
