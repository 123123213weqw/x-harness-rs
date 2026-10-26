# XHarness

<div align="center">
  <img src="assets/brand/xharness-app-icon.png" alt="XHarness" width="128" height="128">
</div>

<div align="center">

**A cross-platform coding-agent runtime in Rust — durable agent loop, native tools, one Host for desktop and Web.**

[![Release](https://img.shields.io/github/v/release/123123213weqw/x-harness-rs)](https://github.com/123123213weqw/x-harness-rs/releases)
[![CI](https://github.com/123123213weqw/x-harness-rs/actions/workflows/ci.yml/badge.svg)](https://github.com/123123213weqw/x-harness-rs/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Rust 1.99](https://img.shields.io/badge/rust-1.99-orange)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

[简体中文](README_zh.md) · English · [Releases](https://github.com/123123213weqw/x-harness-rs/releases) · [Docs](docs/)

</div>

> **Source status:** XHarness development continues in this public repository.
> Source contributions are welcome; the existing licenses and third-party notices
> remain unchanged. See [Source availability](SOURCE_STATUS.md).

XHarness is an open-source, cross-platform coding-agent runtime written in Rust. It combines a durable agent loop, an OpenAI-compatible model adapter, native tools, and a Web interface that can also run inside a Tauri desktop application. One Rust Host serves both the browser and the desktop shell, so sessions, permissions, and tool behavior stay identical across surfaces.

The project is under active development. Platform capabilities and release availability differ between desktop and plain Web deployments. XHarness is an independent project; its versioned Web UI incorporates components from DeepSeek Harness under their respective licenses. See [Third-Party Notices](THIRD_PARTY_NOTICES.md).

A [read-only Gitee mirror](https://gitee.com/wangyue2006/x-harness-rs) is available for access from China; development and pull requests take place on GitHub.

## Why XHarness

- **Durable by design.** Append-only session logs, durable input queues, and checkpoints let the Host reconstruct conversations after a restart. Interrupted side-effecting tool calls are not silently replayed.
- **Runs real agents, not demos.** Streams text, reasoning, and tool calls; supports mid-run steering, cancellation, tool approval, and supervised background work.
- **Context that survives long sessions.** Per-model context limits, request accounting, bounded tool output, and compaction protect long-running conversations from oversized requests.
- **Model-agnostic.** Explicit Chat Completions or Responses API selection, multiple OpenAI-compatible provider routes (cloud or self-hosted), and per-model capability configuration.
- **Native tools behind a real sandbox.** File, process, job, Web, scheduling, and user-question tools are exposed according to the current platform and permission state.
- **One Host, two surfaces.** The Tauri desktop app bundles the Host and Web UI with isolated native WebViews; a plain Web deployment opens pages externally instead.

> The default Host listens only on `127.0.0.1`. Do not expose that local development endpoint directly to an untrusted network; see [Operations](docs/operations.md) before remote deployment.

## Feature overview

| Area | What you get |
| --- | --- |
| **Agent runtime** | Streaming agent loop with steering, cancellation, approval gates, and supervised background jobs |
| **Recoverable sessions** | Append-only logs, durable input queues, checkpoints, and session import |
| **Context management** | Per-model context windows, request accounting, bounded tool output, compaction |
| **Model providers** | OpenAI-compatible Chat Completions and Responses adapters; multi-provider routing via `config/providers.example.json` |
| **Tools & sandbox** | Coding, file, process, job, Web, and scheduling tools gated by a permission and approval model |
| **Computer use** | Native computer-control modules for macOS and Windows (`xharness-computer-*`) |
| **Extensibility** | Plugin system, MCP support, and messaging channels (Telegram, WeChat) in the workspace |
| **Delivery** | Tauri desktop shell with in-app updates; deployable Web bundle in `ui/dist`; Web terminal |

## Quick start

### Desktop application

Download an installer from [Releases](https://github.com/123123213weqw/x-harness-rs/releases):

| Platform | Artifact |
| --- | --- |
| macOS (Apple Silicon) | `XHarness_<version>_aarch64.app.tar.gz` |
| Linux (x64) | `XHarness_<version>_amd64.AppImage` |
| Windows (x64) | `XHarness_<version>_x64-setup.exe` |

Every release ships `SHA256SUMS`, per-platform receipts, and the updater public key; the desktop app updates through the built-in updater channel described in [Desktop packaging and updates](docs/specs/desktop.md). A successful CI artifact is not necessarily a signed, notarized public release.

The desktop browser, local tools, and permission controls are native capabilities. They are not simulated by embedding third-party sites in the ordinary Web UI.

### Run the local Web Host

You need the pinned stable Rust toolchain (`rust-toolchain.toml`, currently 1.99) and an OpenAI-compatible model endpoint. The repository includes the deployable Web bundle in `ui/dist`, so starting the Host does not require rebuilding the frontend.

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

## Repository map

The workspace contains 46 crates. The most important ones:

**Agent runtime**

| Path | Purpose |
| --- | --- |
| [`crates/xharness-core`](crates/xharness-core) | Provider-neutral agent loop and run control |
| [`crates/xharness-agent`](crates/xharness-agent) | Durable input, supervision, and recovery |
| [`crates/xharness-context`](crates/xharness-context) | Context accounting and compaction |
| [`crates/xharness-provider-openai`](crates/xharness-provider-openai) | Chat Completions and Responses adapters |
| [`crates/xharness-tools`](crates/xharness-tools) | Tool registration, policy, approval, and scheduling |
| [`crates/xharness-platform`](crates/xharness-platform) | Native filesystem, process, and sandbox boundary |

**Host & delivery**

| Path | Purpose |
| --- | --- |
| [`crates/xharness-host`](crates/xharness-host) | Session control, RPCs, and UI projection |
| [`crates/xharness-host-app`](crates/xharness-host-app) | Executable Host and production wiring |
| [`crates/xharness-server`](crates/xharness-server) | HTTP/WebSocket service layer |
| [`apps/desktop`](apps/desktop) | Tauri desktop shell and update integration |
| [`ui`](ui) | Versioned Web sources and deployable bundle |
| [`crates/xharness-web-terminal`](crates/xharness-web-terminal) | Browser terminal |

**Integration & extensibility**

| Path | Purpose |
| --- | --- |
| [`crates/xharness-mcp`](crates/xharness-mcp) | Model Context Protocol integration |
| [`crates/xharness-plugins`](crates/xharness-plugins) | Plugin system |
| [`crates/xharness-channel-telegram`](crates/xharness-channel-telegram) / [`weixin`](crates/xharness-channel-weixin) | Messaging channels |
| [`crates/xharness-computer`](crates/xharness-computer) (+ `-macos` / `-windows`) | Computer-use capabilities per platform |
| [`crates/xharness-relay`](crates/xharness-relay) / [`remote`](crates/xharness-remote) / [`cloud`](crates/xharness-cloud) | Remote access and cloud components |
| [`docs`](docs) | Architecture, specifications, operations, and plans |

### Native command execution

Command tools and the Web terminal share shell discovery. Set `XHARNESS_SHELL` to pin a supported executable; an invalid explicit selection fails rather than silently changing dialect. Otherwise an available `SHELL` is preferred, followed by PowerShell Core → Windows PowerShell → CMD on Windows, or Bash → Zsh → sh on Unix. Supply **either** `command` (shell script) **or** `program` plus literal `args` (direct execution), never both. Commands are not replayed in another interpreter after failure. No Python runtime is installed or silently substituted.

## Development and verification

The CI workflow checks formatting, builds and tests the Rust workspace across Linux, macOS, and Windows, validates the Tauri shell, and runs frontend regressions in Chromium and WebKit. The exact commands and platform setup are in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

If you change the Web UI, update its source **and** checked-in `ui/dist` output in the same change. The rebuild and focused test commands are documented in [`ui/README.md`](ui/README.md). If you change behavior, update the corresponding specification and regression test rather than relying on a screenshot or a manual smoke test alone.

Issues and pull requests should describe the observed behavior, expected behavior, affected platform, and a reproducible test. Keep secrets, credentials, and private conversation content out of logs and test fixtures.

## Documentation

- [Workspace memory](docs/design/workspace-memory.md): local, workspace-scoped notes with explicit/manual persistence by default; managed in Settings.

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
