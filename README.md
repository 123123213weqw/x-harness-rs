# XHarness

> **Source status:** XHarness development continues in this public repository.
> Source contributions are welcome; the existing licenses and third-party notices
> remain unchanged. See [Source availability](SOURCE_STATUS.md).

[简体中文](README_zh.md) · English

[![CI](https://github.com/123123213weqw/x-harness-rs/actions/workflows/ci.yml/badge.svg)](https://github.com/123123213weqw/x-harness-rs/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

XHarness is an open-source, cross-platform coding-agent runtime written in Rust. It combines a durable agent loop, an OpenAI-compatible model adapter, native tools, and a Web interface that can also run inside a Tauri desktop application.

The project is under active development. The desktop and Web experiences share the same Rust Host, but platform capabilities and release availability differ. XHarness is an independent project; its versioned Web UI incorporates components from DeepSeek Harness under their respective licenses. See [Third-Party Notices](THIRD_PARTY_NOTICES.md).

A [read-only Gitee mirror](https://gitee.com/wangyue2006/x-harness-rs) is available for access from China; development and pull requests take place on GitHub.

## What it does

- **Runs multi-step agents.** Streams text, reasoning, and tool calls; supports steering, cancellation, approval, and supervised background work.
- **Keeps recoverable state.** Append-only session logs, durable input queues, and checkpoints allow the Host to reconstruct conversations after a restart. Interrupted side-effecting tool calls are not silently replayed.
- **Manages context.** Model-specific context limits, request accounting, bounded tool output, and compaction protect long-running conversations from oversized requests.
- **Connects to models.** Explicit Chat Completions or Responses API selection, multiple OpenAI-compatible provider routes, and per-model capability configuration.
- **Uses native tools.** Coding, file, process, job, Web, scheduling, and user-question tools are exposed according to the current platform and permission state.
- **Runs on desktop or the Web.** The Tauri app bundles the Host and Web UI. Its workspace browser uses isolated native child WebViews; an ordinary Web deployment opens pages externally instead.

The default Host listens only on `127.0.0.1`. Do not expose that local development endpoint directly to an untrusted network; see [Operations](docs/operations.md) before remote deployment.

## Architecture

```text
Web UI / Tauri desktop
        │
        ▼
HTTP + WebSocket API ── Host / agent supervisor
                           │
                    Durable session log
                           │
                      Agent loop
                     /    |     \
            Provider  Context  Tool registry
                                  │
                           Platform services
                      (macOS / Linux / Windows)
```

The model provider and loop are platform-neutral. Filesystem, process, and sandbox behavior live behind platform services; the Host owns sessions, admission, recovery, and UI projections. See [Architecture](docs/architecture.md) and the [module specifications](docs/specs/README.md) for the detailed contracts.

## Get started

### Run the local Web Host

You need a stable Rust toolchain and an OpenAI-compatible model endpoint. The repository includes the deployable Web bundle in `ui/dist`, so starting the Host does not require rebuilding the frontend.

Set `XHARNESS_API_KEY` in your environment if your endpoint requires one. Then, from the repository root:

```bash
XHARNESS_WORKSPACE="$PWD" \
XHARNESS_WEB_DIST="$PWD/ui/dist" \
XHARNESS_BASE_URL="http://127.0.0.1:8000/v1" \
XHARNESS_MODEL="your-model-id" \
XHARNESS_PROTOCOL="chat" \
XHARNESS_CONTEXT_WINDOW="32768" \
cargo run --locked -p xharness-host-app --bin xharness-host
```

Open <http://127.0.0.1:3080/>. Set `XHARNESS_PROTOCOL=responses` only when the endpoint implements the Responses API; there is no automatic protocol fallback. `XHARNESS_CONTEXT_WINDOW` must reflect the **deployed endpoint's** actual limit, not only the model's advertised training window. A Host without a usable model route can still display saved state but cannot generate a response.

For several model endpoints, start with [`config/providers.example.json`](config/providers.example.json), replace its machine-specific paths and URLs, and set `XHARNESS_PROVIDERS_FILE` to the resulting file. Reference credentials through environment variables rather than putting them in that file. See the [model registry specification](docs/specs/model-registry.md).

### Desktop application

The desktop shell lives in [`apps/desktop`](apps/desktop) and bundles the Host, UI, and required sidecars. CI builds macOS, Windows, and Linux artifacts; see [Releases](https://github.com/123123213weqw/x-harness-rs/releases) and the [desktop documentation](docs/specs/desktop.md) for installation and update-channel status. A successful CI artifact is not necessarily a signed, notarized public release.

The desktop browser, local tools, and permission controls are native capabilities. They are not simulated by embedding third-party sites in the ordinary Web UI.

## Repository layout

| Path | Purpose |
| --- | --- |
| [`crates/xharness-core`](crates/xharness-core) | Provider-neutral agent loop and run control |
| [`crates/xharness-agent`](crates/xharness-agent) | Durable input, supervision, and recovery |
| [`crates/xharness-host`](crates/xharness-host) | Session control, RPCs, and UI projection |
| [`crates/xharness-host-app`](crates/xharness-host-app) | Executable Host and production wiring |
| [`crates/xharness-provider-openai`](crates/xharness-provider-openai) | Chat Completions and Responses adapters |
| [`crates/xharness-tools`](crates/xharness-tools) | Tool registration, policy, approval, and scheduling |
| [`crates/xharness-platform`](crates/xharness-platform) | Native filesystem, process, and sandbox boundary |
| [`apps/desktop`](apps/desktop) | Tauri desktop shell and update integration |
| [`ui`](ui) | Versioned Web sources and deployable bundle |
| [`docs`](docs) | Architecture, specifications, operations, and plans |

## Development and verification

The CI workflow checks formatting, builds and tests the Rust workspace across Linux, macOS, and Windows, validates the Tauri shell, and runs frontend regressions in Chromium and WebKit. The exact commands and platform setup are in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

If you change the Web UI, update its source **and** checked-in `ui/dist` output in the same change. The rebuild and focused test commands are documented in [`ui/README.md`](ui/README.md). If you change behavior, update the corresponding specification and regression test rather than relying on a screenshot or a manual smoke test alone.

Issues and pull requests should describe the observed behavior, expected behavior, affected platform, and a reproducible test. Keep secrets, credentials, and private conversation content out of logs and test fixtures.

## Documentation

Detailed engineering documentation is currently maintained primarily in Chinese:

- [Architecture](docs/architecture.md)
- [Specifications index](docs/specs/README.md)
- [Operations and troubleshooting](docs/operations.md)
- [Context and compaction](docs/specs/context.md)
- [Tool and sandbox contracts](docs/specs/tools.md)
- [Sandbox and permission model](docs/specs/sandbox.md)
- [Desktop packaging and updates](docs/specs/desktop.md)
- [Project roadmap and open work](docs/TODO.md)

The root README is the English project overview; implementation status and acceptance criteria should be checked against the linked specifications and CI.

## License

XHarness's Rust code and original project assets are licensed under [Apache License 2.0](LICENSE). The Web bundle includes third-party code with separate licenses and attribution in [Third-Party Notices](THIRD_PARTY_NOTICES.md).
