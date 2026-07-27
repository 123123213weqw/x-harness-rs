# XHarness

> **源码状态**：XHarness 恢复在本公开仓库持续开发，欢迎源码贡献。
> 原有许可证与第三方声明保持不变。详见[源码公开状态](SOURCE_STATUS.md)。

简体中文 · [English](README.md)

[![CI](https://github.com/123123213weqw/x-harness-rs/actions/workflows/ci.yml/badge.svg)](https://github.com/123123213weqw/x-harness-rs/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

XHarness 是一个使用 Rust 编写的开源跨平台编程 Agent 运行时。它提供可恢复的 Agent 循环、兼容 OpenAI 接口的模型适配、原生工具，以及可在 Tauri 桌面应用中运行的 Web 界面。

项目仍在持续开发。桌面端和 Web 端共用同一套 Rust Host，但不同平台的原生能力和发布状态并不完全相同。XHarness 是独立项目；随版本提供的 Web UI 包含来自 DeepSeek Harness 的组件，分别遵守其对应许可证。详见[第三方声明](THIRD_PARTY_NOTICES.md)。

本仓库的 [Gitee 地址](https://gitee.com/wangyue2006/x-harness-rs)是便于国内访问的**只读镜像**；开发、Issue 和 Pull Request 请前往 [GitHub 主仓库](https://github.com/123123213weqw/x-harness-rs)。

## 主要能力

- **多步骤 Agent**：流式展示文本、推理和工具调用，支持运行中引导、取消、工具审批和受控后台任务。
- **可恢复状态**：通过追加式会话日志、持久化输入队列和检查点，在 Host 重启后重建对话。中断的、具有副作用的工具调用不会被静默重放。
- **上下文管理**：按模型配置上下文上限，统计请求用量，限制工具输出，并通过压缩避免长对话产生超大请求。
- **多模型接入**：显式选择 Chat Completions 或 Responses 协议，配置多个兼容 OpenAI 的 Provider 路由及各模型能力。
- **原生工具**：根据平台和当前权限状态提供编程、文件、进程、后台 Job、网页、定时任务和用户提问工具。
- **Web 与桌面端**：Tauri 应用打包 Host 和 Web UI。桌面内置浏览器使用隔离的原生子 WebView；普通 Web 部署则在外部浏览器打开网页。

Host 默认只监听 `127.0.0.1`。不要直接将本地开发端点暴露给不可信网络；远程部署前请阅读[运维文档](docs/operations.md)。

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

## 快速开始

### 运行本地 Web Host

需要稳定版 Rust 工具链和一个兼容 OpenAI 的模型接口。仓库已包含可部署的前端包 `ui/dist`，启动 Host 时无需重新构建前端。

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

### 桌面应用

桌面外壳位于 [`apps/desktop`](apps/desktop)，打包 Host、UI 和必要的 sidecar。CI 会构建 macOS、Windows 和 Linux 产物；安装包与更新通道状态请查看 [GitHub Releases](https://github.com/123123213weqw/x-harness-rs/releases) 和[桌面端文档](docs/specs/desktop.md)。CI 产物构建成功，并不意味着它已经完成签名、公证或达到正式公开发布条件。

桌面内置浏览器、本地工具和权限控制依赖原生能力；普通 Web UI 不会通过嵌入第三方网页来模拟这些能力。

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| [`crates/xharness-core`](crates/xharness-core) | 与 Provider 无关的 Agent 循环和运行控制 |
| [`crates/xharness-agent`](crates/xharness-agent) | 持久化输入、监管和恢复 |
| [`crates/xharness-host`](crates/xharness-host) | 会话控制、RPC 和 UI 投影 |
| [`crates/xharness-host-app`](crates/xharness-host-app) | 可执行 Host 与生产环境组装 |
| [`crates/xharness-provider-openai`](crates/xharness-provider-openai) | Chat Completions 和 Responses 适配器 |
| [`crates/xharness-tools`](crates/xharness-tools) | 工具注册、策略、审批和调度 |
| [`crates/xharness-platform`](crates/xharness-platform) | 原生文件系统、进程和沙箱边界 |
| [`apps/desktop`](apps/desktop) | Tauri 桌面外壳与更新集成 |
| [`ui`](ui) | 版本化 Web 源码和可部署前端包 |
| [`docs`](docs) | 架构、规格、运维和计划文档 |

## 开发与验证

CI 会检查格式，在 Linux、macOS 和 Windows 上构建并测试 Rust 工作区，验证 Tauri 外壳，并在 Chromium 与 WebKit 中运行前端回归测试。具体命令和平台准备步骤见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

修改 Web UI 时，应在同一次变更中更新源码及纳入版本控制的 `ui/dist` 产物。重建方式和专项测试见 [`ui/README.md`](ui/README.md)。修改行为时，请同步更新对应规格和回归测试，不要只依赖截图或手动冒烟测试。

提交 Issue 或 Pull Request 时，请说明实际行为、预期行为、受影响平台和复现方法。不要在日志或测试样例中加入密钥、凭据及私人对话内容。

## 文档

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
