# Live history recovery evaluation

**Goal:** Measure actual DeepSeek tokens and independently checked coding success before and after durable archives.

**Architecture:** Compile the same opt-in evaluator against baseline `54e7d4b` and candidate `a3ba8f3`. Use the real durable runtime, provider adapter, JSONL store and (on candidate) runtime-registered history tool. Only expose bounded in-memory read/write and one-shot diagnostic capabilities, not a shell or arbitrary paths. Credentials arrive through stdin and stay out of artifacts.

**Tech stack:** Rust runtime example, Python independent restricted-AST acceptance, remote WZU compilation.

1. Add evaluator and acceptance self-tests. Check known-good and known-bad implementations before any paid runs.
2. Remote compile identical evaluator on both revisions. Run ordinary retry-function repair and synthetic 400 KB diagnostic recovery. Cancel after the first event beyond step 16, or after 5 minutes. Use identical runtime/provider defaults: 131072 cumulative output tokens, provider-default per-request ceiling. The constructor's 2048 is event capacity, not an output-token cap. The reusable runner alternates version order; the initial manually launched pilot did candidate ordinary/recovery, then baseline ordinary/recovery and is not counterbalanced.
3. Aggregate normalized provider input/cache/output/reasoning usage from durable assistant events, tool calls, elapsed time and independent acceptance. Retain task artifacts and report all failures, including infrastructure failures.

The stress case intentionally places unique required constants in the omitted middle of a one-shot diagnostic; it measures recovery, not typical coding performance. No compaction, OS shell, UI, long-running autonomy or production installation is under test. Do not generalize four runs to long-term quality. No release or App replacement.
