# Active-session UI working set and control responsiveness

## Scope

This patch is UI-only. It does not compact/delete the Host journal, change the
model context, provider request, executor, prompt, tool schema, or a running task.
No installed application was replaced/restarted during acceptance.

## Policy

- Estimate each accepted raw event/view payload once, rather than repeatedly
  serializing all retained history. Above 4,096 events or 8 MiB of estimated
  payload, stage a smaller contiguous tail, targeting 2,048 events / 4 MiB.
- Only evict completed prefixes. Keep the pre-turn user/inbox preamble after
  the preceding recorded turn end, the unfinished turn, and any spanning
  Context or backward business-state dependency. Replacement is atomic.
- These are **soft UI residency limits, not a hard process-RAM ceiling**. A
  huge unfinished turn, cross-window dependency chain, or explicit reader
  anchor/pagination stays pinned. Do not claim that every arbitrary session
  is bounded by 8 MiB. Retry policy scans only after meaningful growth when
  a protected prefix cannot be released.
- Scrolling/paging into old history pins that range. Returning explicitly to
  latest releases the reader pin. `hasMore` and normal Host history pagination
  remain available; every original raw fixture event is recovered in order.
- An opt-in `locationReuse: 'events'` contract avoids replaying audited event-only
  reducers when only immutable Location boundaries change. Top-level Match
  references are rebound. Materializers still run on the new timeline, and
  dependency readers see revision changes. Numeric-coordinate changes and
  unmodified/third-party Definitions retain conservative replay semantics.
- Production SessionManager delivers durable events in FIFO slices with a
  4 ms scheduling budget, yielding to task/input processing. Budget resets
  require a real task boundary, not the passage of time in a microtask storm.
  Approval/question/queue/status controls and mutation RPCs bypass that FIFO.
- The delivery FIFO is capped at 512 entries / 8 MiB; history stitching has
  its own 4,096-entry / 8 MiB cap. Sustained overload retains the last committed
  view and uses the existing visible, retryable **read-only history recovery**.
  It never retries a prompt/tool mutation. Overload is not advertised as
  seamless lossless streaming; the durable journal supplies reconciliation.
- Stop has single-flight admission and visible busy feedback. RPC acceptance
  is not completion: only authoritative running status clears a successful
  stop request. Failure allows retry; stale-generation errors cannot change
  the next turn. Send exposes the existing submission-machine busy phase;
  a rejected receipt keeps the draft.

## Reproduction

Run from the repository root, after `npm ci --prefix ui` and
`npm run build --prefix ui`:

```sh
node scripts/test-active-session-working-set.mjs
UI_TEST_DEPS=/path/to/playwright-deps UI_TEST_BROWSER=chromium \
  PROBE_STAGES=192,1088,4160,8256,16576 \
  node scripts/test-active-session-working-set-browser.mjs --soak
UI_TEST_DEPS=/path/to/playwright-deps UI_TEST_BROWSER=webkit \
  PROBE_STAGES=192,1088,4160,8256,16576 \
  node scripts/test-active-session-working-set-browser.mjs --soak
```

The browser script runs the actual pinned React/Cordis platform, real
Session/assembler/business Definitions and InputBar/input machine. It uses
controlled synthetic bash/assistant events, 128 steps per turn, and controlled
RPC receipts. It does **not** run a real model, backend driver or installed app,
nor render the full transcript/tool DOM. Separate existing ChatView scrolling,
composer layout, history residency, native-produced file-card and terminal
regressions cover their respective behavior. Do not interpret browser timings
as actual network/Host cancellation latency or an overnight wall-clock soak.

Chromium retained heap is measured through CDP after collection, not coarse
`performance.memory` readings. WebKit has no equivalent heap measurement in
this fixture. Timing includes controlled synchronous 20-step producer bursts;
with cooperative delivery, burst enqueue time is not total reduction time.
The fixture waits for FIFO drainage when checking state and step counters.

## Acceptance evidence

See the adjacent JSON evidence files and PR checklist for measured outcomes.
The contract test checks full original journal recovery, retained pre-turn
messages, pinned unfinished turns and dependency chains, reducer replay
parity/default plugin behavior, control races, disconnect cleanup, microtask
starvation, overload caps and history-only recovery. The existing frozen
parity checks explicitly validate the new idle stop flag / empty relocation
scratch set before comparing every previous field unchanged.

The new contract and Chromium/WebKit browser gates are enrolled in the normal
UI CI plan; no existing gate or frozen baseline is removed.

### V100 results (2026-10-26)

Matched phase: 8,256 completed synthetic steps, 128 steps per turn, step 64
within the current turn. Baseline was measured on `0b118093` before this patch.
Each is a single controlled run, not a statistical population benchmark.

| Chromium metric | Before | After |
|---|---:|---:|
| Retained raw events | 41,410 | 2,889 |
| Retained reducer Contexts | 16,643 | 1,162 |
| Page heap after collection | 49.30 MiB | 11.51 MiB |
| Reducer replays for one added step | 264 | 4 |
| Pressured Stop click → stub RPC | 455 ms | 29 ms |
| Pressured Send click → stub RPC | 462 ms | 44 ms |

The after-run then reaches 16,576 steps: 3,531 retained events, 1,420 Contexts,
12.17 MiB collected page heap. The additional paced phase lasts at least 30
seconds and retains the same policy bounds. WebKit reaches the same 16,576
step checkpoint: 3,531 retained events; pressured Stop/Send about 62/61 ms.
No browser page errors were recorded. See the full JSON rather than using
these rounded timings as latency guarantees.

Local acceptance additionally passes 149 focused foundation/assistant/native
file-card/scroll/terminal tests, the new long-window/control contract, atomic
history and lifecycle/reconnect tests, strict source compilation/type policy,
CI-plan coverage/calibration, architecture checks and formatting. No Rust
source changed and no Rust compilation was performed locally.

The first PR CI run caught the unchanged conversation source-parity gate's
missing enrollment of the new busy labels and append-only spinner CSS. The
gate now checks their exact reviewed values, keeps the previous stylesheet
hash and frozen dictionary intact, and rejects missing/modified labels,
changed reduced-motion rules, or unrelated style/copy changes. All 24
conversation source tests pass; no production code changed for this correction.

Final paced totals: Chromium 22707 steps; WebKit 20657 steps. Both engines additionally pass the existing history-cache, ChatView scroll-intent and composer-layout browser scripts. The delayed-ACK/single-flight/rejected-draft DOM checks pass on both engines.
