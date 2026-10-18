# UI fixture separation acceptance — 2026-10-18

Base: `404366c5c908b8909ddc0fdc4288e3a31992921a`.
Branch: `refactor/ui-fixture-build-split-20261018`.
No Rust runtime or RPC protocol source was changed. No installed application,
personal state, existing preview Host, merge or release was modified.

## Passed

- Strict TypeScript build, deterministic production and fixture `--check`.
- Seven production/fixture boundary tests: URL flags cannot select fake transport;
  direct/transitive imports are rejected; fixture builds cannot overwrite release
  assets; packaging rejects fixture provenance, injected code and stale hashes.
  All other generated module bundles are byte-identical across the two variants.
- Seven connection/carrier boundary cases and 123 foundation A/B cases.
- Fifteen clean/isolated build cases, including offline locked dependency install,
  reproducible output, compiler/input failures and atomic preservation.
- Twenty-eight source compiler cases, 46 plugin API cases and 23 product-module cases.
- Fourteen CI suite/artifact contracts; existing baseline coverage is unchanged.
- Unmodified full-UI differential: three runs per engine, Chromium and WebKit,
  including exact frozen conversation pixel comparisons and existing controls.
- Sixteen full-graph browser runs: account, performance, sidebar actions, file
  display, Harness snapshots, settings masks, conversation rail and environment,
  each in Chromium and WebKit with locked Playwright 1.61.1. Chromium page-priority
  also passed. The preview server starts and serves the explicit fixture build.
- Architecture dependency and content-bound freeze gates; desktop bootstrap,
  startup, asset and release-script contracts.
- Isolated V100 real-Host transport: initial connection, real session creation and
  listing, pending queue snapshot, cancel, queued-turn assistant completion, real
  WebSocket loss/reconnect, stable historical prefix and stop-time description
  retraction. The corrected provider fixture passed four consecutive final runs.
- Actual production UI rendered this Host's history in Chromium and WebKit while
  the URL contained `?fixture=1`; no demo transport replaced it.

## Existing failures and scope limits

- macOS WebKit page-priority fails `Tab never reaches background controls`.
  It also fails on unchanged master `404366c5`, with both the shared and locked
  browser toolchains. The assertion and production modal code were not changed.
- The reused Host has no development `/plugins/events` SSE endpoint. WebKit emits
  its exact MIME-type warning for that HMR request; actual session HTTP/WebSocket
  traffic and history rendering pass. Chromium did not emit this warning.
- This is real Host/transport behavior with a local deterministic provider, not
  a paid-model quality test. The reused remotely built Host came from `7a50f60`,
  SHA-256 `07f3dfdc014eb8b68c714ad0cef229b4e5145eed26a0d25139a480c8cb82f13d`;
  it was not rebuilt from this frontend-only branch. Native Windows/macOS/Linux
  installer builds remain CI work; they were not executed in this acceptance.
- The first temporary provider did not implement input-token counting and could
  generate a title matching the expected response. That attempt is not accepted.
  The checked-in fixture implements counting/auxiliary replies, and the final
  oracle explicitly requires an `assistant/message`, never a title substring.

## Measured result

Connection module only, same local gzip implementation for both files:

| Measurement | Before | Production after |
| --- | ---: | ---: |
| Raw bytes | 337,799 | 134,526 |
| gzip bytes | 75,575 | 27,248 |

The raw connection bundle shrank by 203,273 bytes (60.2%). This is not a 60%
application-memory improvement. Startup latency, process RSS and native WebKit
memory savings were not measured. The fixture build intentionally retains sample
data for deterministic tests and previews.

Commands and ownership boundaries are documented in [UI build variants](../ui-build-variants.md).
Compact machine-readable receipts are in `docs/evidence/ui-fixture-split-20261018/`.
