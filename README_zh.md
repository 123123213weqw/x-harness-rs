# XHarness

<div align="center">
  <img src="assets/brand/xharness-brand-hero.png" alt="XHarness" width="640">
</div>

<div align="center">

**Rust 编写的跨平台编程 Agent 运行时 —— 可恢复的 Agent 循环、原生工具，一套 Host 同时服务桌面端与 Web 端。**

[![Release](https://img.shields.io/github/v/release/123123213weqw/x-harness-rs)](https://github.com/123123213weqw/x-harness-rs/releases)
[![CI](https://github.com/123123213weqw/x-harness-rs/actions/workflows/ci.yml/badge.svg)](https://github.com/123123213weqw/x-harness-rs/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Rust 1.99](https://img.shields.io/badge/rust-1.99-orange)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

简体中文 · [English](README.md) · [版本发布](https://github.com/123123213weqw/x-harness-rs/releases) · [文档](docs/)

</div>

> **源码状态**：XHarness 恢复在本公开仓库持续开发，欢迎源码贡献。
> 原有许可证与第三方声明保持不变。详见[源码公开状态](SOURCE_STATUS.md)。

XHarness 是一个使用 Rust 编写的开源跨平台编程 Agent 运行时。它提供可恢复的 Agent 循环、兼容 OpenAI 接口的模型适配、原生工具，以及可在 Tauri 桌面应用中运行的 Web 界面。一套 Rust Host 同时服务浏览器与桌面外壳，会话、权限和工具行为在不同界面间保持一致。

项目仍在持续开发。桌面端和普通 Web 部署的平台能力与发布状态并不完全相同。XHarness 是独立项目；随版本提供的 Web UI 包含来自 DeepSeek Harness 的组件，分别遵守其对应许可证。详见[第三方声明](THIRD_PARTY_NOTICES.md)。

本仓库的 [Gitee 地址](https://gitee.com/wangyue2006/x-harness-rs)是便于国内访问的**只读镜像**；开发、Issue 和 Pull Request 请前往 [GitHub 主仓库](https://github.com/123123213weqw/x-harness-rs)。

## 为什么选择 XHarness

- **天生可恢复**：追加式会话日志、持久化输入队列和检查点，让 Host 重启后能重建对话。中断的、具有副作用的工具调用不会被静默重放。
- **运行真实 Agent，而非演示**：流式展示文本、推理和工具调用，支持运行中引导、取消、工具审批和受监管的后台任务。
- **上下文经得起长会话**：按模型配置上下文上限、统计请求用量、限制工具输出，并通过压缩避免长对话产生超大请求。
- **模型无关**：显式选择 Chat Completions 或 Responses 协议，支持多条兼容 OpenAI 的 Provider 路由（云端或自建），并按模型配置能力。
- **原生工具，真实沙箱**：编程、文件、进程、后台 Job、网页、定时任务和用户提问工具，按平台与当前权限状态开放。
- **一套 Host，两种形态**：Tauri 桌面应用打包 Host 与 Web UI，内置浏览器使用隔离的原生子 WebView；普通 Web 部署则在外部浏览器打开网页。

> Host 默认只监听 `127.0.0.1`。不要直接将本地开发端点暴露给不可信网络；远程部署前请阅读[运维文档](docs/operations.md)。

## 功能一览

| 领域 | 能力 |
| --- | --- |
| **Agent 运行时** | 流式 Agent 循环，支持引导、取消、审批门控和受监管的后台任务 |
| **可恢复会话** | 追加式日志、持久化输入队列、检查点与会话导入 |
| **上下文管理** | 按模型上下文窗口、请求用量统计、工具输出限额、上下文压缩 |
| **模型接入** | 兼容 OpenAI 的 Chat Completions 与 Responses 适配器；通过 `config/providers.example.json` 配置多 Provider 路由 |
| **工具与沙箱** | 编程、文件、进程、Job、网页和定时任务工具，由权限与审批模型管控 |
| **Computer Use** | 面向 macOS 与 Windows 的原生电脑控制模块（`xharness-computer-*`） |
| **扩展能力** | 插件系统、MCP 支持、消息通道（Telegram、微信）等 workspace 模块 |
| **分发形态** | 带应用内更新的 Tauri 桌面外壳；`ui/dist` 可部署 Web 包；浏览器终端 |

## 快速开始

### 桌面应用

从 [Releases](https://github.com/123123213weqw/x-harness-rs/releases) 下载安装包：

| 平台 | 产物 |
| --- | --- |
| macOS（Apple Silicon） | `XHarness_<version>_aarch64.app.tar.gz` |
| Linux（x64） | `XHarness_<version>_amd64.AppImage` |
| Windows（x64） | `XHarness_<version>_x64-setup.exe` |

每个版本都附带 `SHA256SUMS`、各平台回执和更新器公钥；桌面应用通过[桌面打包与更新](docs/specs/desktop.md)描述的内置更新通道升级。CI 产物构建成功，并不意味着它已经完成签名、公证或达到正式公开发布条件。

桌面内置浏览器、本地工具和权限控制依赖原生能力；普通 Web UI 不会通过嵌入第三方网页来模拟这些能力。

### 运行本地 Web Host

需要 `rust-toolchain.toml` 固定的稳定版 Rust 工具链（当前为 1.99）和一个兼容 OpenAI 的模型接口。仓库已包含可部署的前端包 `ui/dist`，启动 Host 时无需重新构建前端。

如果模型接口需要密钥，请在环境变量中设置 `XHARNESS_API_KEY`。随后在仓库根目录执行：

```bash
XHARNESS_WORKSPACE="$PWD" \
XHARNESS_WEB_DIST="$PWD/ui/dist" \
XHARNESS_BASE_URL="http://127.0.0.1:8000/v1" \
XHARNESS_MODEL="your-model-id" \
XHARNESS_PROTOCOL="chat" \
XHARNESS_CONTEXT_WINDOW="32768" \
cargo run --locked -p xharness-host-app --bin xharness-host
```

打开 <http://127.0.0.1:3080/>。只有接口实际支持 Responses API 时，才将 `XHARNESS_PROTOCOL` 设为 `responses`；程序不会自动切换协议。`XHARNESS_CONTEXT_WINDOW` 应填写**当前部署接口**的真实上限，不能仅依据模型宣传的训练上下文长度。没有可用模型路由时，Host 仍可显示已保存的状态，但无法生成回复。

如果要配置多个模型接口，可从 [`config/providers.example.json`](config/providers.example.json) 开始，替换其中与示例机器有关的路径和 URL，再将 `XHARNESS_PROVIDERS_FILE` 指向你的配置文件。凭据应通过环境变量引用，不要直接写进该文件。详见[模型注册规格](docs/specs/model-registry.md)。

## 架构

```text
Web UI / Tauri 桌面应用
          │
          ▼
HTTP + WebSocket API ── Host / Agent 监管器
                            │
                        持久化会话日志
                            │
                        Agent 循环
                       /    |     \
                Provider  上下文  工具注册表
                                     │
                                平台服务
                         (macOS / Linux / Windows)
```

模型 Provider 和 Agent 循环不依赖具体操作系统。文件系统、进程和沙箱能力位于平台服务层之后；Host 负责会话、准入、恢复和 UI 投影。详细契约见[架构文档](docs/architecture.md)和[模块规格索引](docs/specs/README.md)。

## 仓库结构

workspace 共包含 46 个 crate，其中最重要的：

**Agent 运行时**

| 路径 | 用途 |
| --- | --- |
| [`crates/xharness-core`](crates/xharness-core) | 与 Provider 无关的 Agent 循环和运行控制 |
| [`crates/xharness-agent`](crates/xharness-agent) | 持久化输入、监管和恢复 |
| [`crates/xharness-context`](crates/xharness-context) | 上下文统计与压缩 |
| [`crates/xharness-provider-openai`](crates/xharness-provider-openai) | Chat Completions 和 Responses 适配器 |
| [`crates/xharness-tools`](crates/xharness-tools) | 工具注册、策略、审批和调度 |
| [`crates/xharness-platform`](crates/xharness-platform) | 原生文件系统、进程和沙箱边界 |

**Host 与分发**

| 路径 | 用途 |
| --- | --- |
| [`crates/xharness-host`](crates/xharness-host) | 会话控制、RPC 和 UI 投影 |
| [`crates/xharness-host-app`](crates/xharness-host-app) | 可执行 Host 与生产环境组装 |
| [`crates/xharness-server`](crates/xharness-server) | HTTP/WebSocket 服务层 |
| [`apps/desktop`](apps/desktop) | Tauri 桌面外壳与更新集成 |
| [`ui`](ui) | 版本化 Web 源码和可部署前端包 |
| [`crates/xharness-web-terminal`](crates/xharness-web-terminal) | 浏览器终端 |

**集成与扩展**

| 路径 | 用途 |
| --- | --- |
| [`crates/xharness-mcp`](crates/xharness-mcp) | Model Context Protocol 集成 |
| [`crates/xharness-plugins`](crates/xharness-plugins) | 插件系统 |
| [`crates/xharness-channel-telegram`](crates/xharness-channel-telegram) / [`weixin`](crates/xharness-channel-weixin) | 消息通道 |
| [`crates/xharness-computer`](crates/xharness-computer)（含 `-macos` / `-windows`） | 各平台电脑控制能力 |
| [`crates/xharness-relay`](crates/xharness-relay) / [`remote`](crates/xharness-remote) / [`cloud`](crates/xharness-cloud) | 远程访问与云端组件 |
| [`docs`](docs) | 架构、规格、运维和计划文档 |

### 原生命令执行

命令工具与 Web 终端共用 shell 发现逻辑。设置 `XHARNESS_SHELL` 可固定使用的 shell；显式指定无效值会直接失败，而不是悄悄更换方言。未指定时优先使用可用的 `SHELL` 环境变量，Windows 上依次尝试 PowerShell Core → Windows PowerShell → CMD，Unix 上依次尝试 Bash → Zsh → sh。调用时**二选一**：提供 `command`（shell 脚本）**或** `program` 加字面量 `args`（直接执行），不可同时提供。命令失败后不会换一种解释器重放。不会安装或悄悄替换 Python 运行时。

## 开发与验证

CI 会检查格式，在 Linux、macOS 和 Windows 上构建并测试 Rust 工作区，验证 Tauri 外壳，并在 Chromium 与 WebKit 中运行前端回归测试。具体命令和平台准备步骤见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

修改 Web UI 时，应在同一次变更中更新源码及纳入版本控制的 `ui/dist` 产物。重建方式和专项测试见 [`ui/README.md`](ui/README.md)。修改行为时，请同步更新对应规格和回归测试，不要只依赖截图或手动冒烟测试。

提交 Issue 或 Pull Request 时，请说明实际行为、预期行为、受影响平台和复现方法。不要在日志或测试样例中加入密钥、凭据及私人对话内容。

## 文档

- [工作区记忆](docs/design/workspace-memory.md)：本地、按工作区隔离的笔记，默认显式手动持久化，可在设置中管理。

详细工程文档目前主要以中文维护：

- [架构](docs/architecture.md)
- [规格索引](docs/specs/README.md)
- [运维与故障排查](docs/operations.md)
- [上下文与压缩](docs/specs/context.md)
- [工具与沙箱契约](docs/specs/tools.md)
- [沙箱与权限模型](docs/specs/sandbox.md)
- [桌面打包与更新](docs/specs/desktop.md)
- [项目路线图与待办](docs/TODO.md)

本文件是面向中文读者的项目概览。具体实现状态和验收标准，请以链接的规格文档与 CI 结果为准。

## 许可证

XHarness 的 Rust 代码和原创项目资源采用 [Apache License 2.0](LICENSE)。Web 包含采用其他许可证的第三方代码，其授权及署名见[第三方声明](THIRD_PARTY_NOTICES.md)。
