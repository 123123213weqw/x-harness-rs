# Compaction capacity and counting acceptance (2026-10-30)

## Scope and protocol

The patch separates unverified estimated overflow from confirmed capacity failure,
then stages disjoint raw-span notes or regenerates a smaller note from raw evidence.
The complete candidate is admitted before one strict-CAS batch publishes any
checkpoint. The specification records bounded attempts/calls/deadline, protected
inputs and failure behavior. This does not promise that arbitrary fixed/protected
context can fit any context window.

Synthetic counters price actual request contents, not chronological response
queues. Tests assert no partial durable summary, no recursive summary input,
full wire admission, preserved user constraints, cancellation, measurement outage,
metadata/CAS races, bounded no-progress recovery, shared-call/output limits and
append-success/flush-failure reconciliation. The actor integration still parks
settlements after a failure and only an explicit user retry resumes work.

The prior CI at `96c5336c` failed the catalogue smoke on all three Rust platforms:
an instantaneous fake child could finish before `subagent.interrupt`. The test now
waits for an explicitly cancellable provider stream. It does not swallow errors,
add arbitrary sleeps, or loosen production execution/control acknowledgements.
The manual-counting fixture also now supplies the required input-free command
lifecycle and asserts native counter calls, instead of failing earlier validation.

## Configured-upstream observations

`upstream-count-audit.json` records all 8 configured routes and 10 models using the
existing authenticated Host, without extracting provider keys. No tools executed;
all synthetic probe sessions were cancelled/archived. Native Qwen text and image
counts equalled actual total input usage (6697 and 6758 with the 18 production
schemas). Separate direct text/tool/image native counts equalled usage too
(78 / 651 / 88). DeepSeek and successful GLM probes used conservative fallback
counts, not native counts; their estimated counts were materially above usage.

Other trials observed 400, 404, 429, 502 or a bounded 150-second generation timeout.
These are not evidence that a native endpoint is permanently unsupported. The
installed Host does not retain the negative counter reason in these successful
request headers. No provider configuration, model server, key ACL or installed
binary was changed. This evidence supports keeping safe estimate compatibility,
not deleting estimates or treating every upstream as native-capable.

## Private old-session protocol

The opt-in host-app example consumes only an isolated journal/attachment copy with
`ACCEPTANCE_COPY_ONLY`; the copied prefix ends at the historical failed turn.
It uses production LoopEngine and the OpenAI adapter against the same Qwen
upstream, thinking off, no production tools or UI, and a harmless text-only
continuation. Native preflight independently guards every actual generation.
Numeric receipts record before/after counts, output limits, usage, progress,
completion and copy-prefix preservation; prompts, answers, journal identifiers,
endpoints and credentials are not published.

Initial fixture trials incorrectly supplied a System message as new input after
restored history. Server logs confirmed a Jinja System-position error (HTTP 500),
not a timeout. Those trials are failed setup attempts, not passing recovery tests;
increasing the count deadline did not fix them. The corrected example uses the
same PromptAssembly prefix path as a real Host. Neither fixture failure nor
headless success proves the original desktop crash or byte-identical incident.

## Compiler and source evidence

`compiler-gates.json` records 28 actual remote compiler mutations across all 32
protected source files plus restored-source positive strict Clippy. No lint,
unsafe fence or mutation target was exempted. `source-sha256.json` binds all 8
changed Rust sources/tests/examples to the byte-identical WZU_Server validation
input. Local Rust execution was limited to formatting. Final workspace/CI and
live-copy completion receipts are reported in PR #409, rather than counting
in-progress jobs or the initial fixture failures as passes.

`validation.json` records the completed WZU_Server workspace/all-target test run
and affected strict Clippy. `old-normal.json` records a successful 262K-harness
old-copy continuation: native input 251639 -> 132596, one applied note, preserved
original copied prefix and nonempty final response. All three actual generation
requests were independently preflighted and their completed input usage equalled
native counts. The forced-window case is separate; this normal case alone does
not prove multi-note recovery on the private session or a desktop/UI fix.
