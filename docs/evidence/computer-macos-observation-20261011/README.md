# macOS observation regression and native screenshot acceptance

- `regression.json`: original AX timing evidence, fixed JXA traversal, portable Rust policy/type checks.
- `native-media.json`: actual macOS Host built by GitHub macOS runner from PR #267's runtime commit. Artifact source is GitHub's test merge commit; both parents and the downloaded executable digest are recorded.

## Opt-in native reproduction

Build the macOS Host **remotely**, download the exact artifact and verify its
`source-sha.txt` / `SHA256SUMS`. Do not compile Rust on the local machine.
Then run:

```sh
python3 scripts/probe-macos-computer-media.py \
  --host-binary /absolute/path/to/downloaded/xharness-host \
  --output /tmp/native-computer-media.json
```

The standard-library-only probe starts its own loopback SSE fixture and Host
with a disposable workspace/state directory. It calls the registered `computer`
tool, captures an actual 64×64 logical-point screen crop, verifies PNG bytes
through the session attachment RPC and outgoing provider request, rejects
cross-session reads, and restarts only its own Host to check durable history,
image retrieval and absence of tool replay. It never changes system permissions.
The `--screenshot-only` option excludes AX traversal.

Long AX summaries can be reduced into a valid outer JSON envelope containing a
head/tail excerpt in ordinary history text. Such an excerpt is not an inner JSON
document. The probe instead validates the full observation in the outgoing media
blocks and checks the actual image reference in history. No production behavior
was changed to accommodate the probe.

`turn/end` ends the agent turn, but does not claim asynchronous title generation
has finished. The probe takes a stable final journal snapshot before shutdown,
then compares the reopened journal exactly.

## Accepted and not accepted

Accepted natively: screenshot-only, AX auto + screenshot, AX semantic + explicit
screenshot; actual PNG transport, session-scoped durable attachment, restart
retrieval without capture replay. AX auto/semantic reached the soft time budget
and honestly returned `partial` snapshots rather than pretending a complete tree.

Not accepted by this receipt: real LLM visual task quality, frontend screenshot
rendering, or an actual single-Apple-Event hard timeout. The temporary slow AX app
was invisible to the production selector and therefore did not reproduce that
watchdog. It was stopped and is not included in passing cases. The browser tool
blocked the temporary UI tab; no frontend visual pass is claimed. Portable Rust
regressions cover timeout recovery, cancellation propagation, and unsafe fallback
rejection; the five Host media tests run on V100 use fixture PNGs, not native
screen capture.

Only counts, timings, image digests/dimensions and verification results are saved
here. Screenshots, window titles, accessibility labels and private state are not
committed or uploaded. The installed application remains untouched.
