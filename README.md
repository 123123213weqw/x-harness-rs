# XHarness RS

从零实现的 Linux Server AI Agent Harness。核心使用 Rust，目标是提供稳定、可嵌入、
可测试的 Agent Loop，并继续扩展 CLI、PTY、Sandbox、Daemon 和 Subagent。

当前 **v0** 已完成 Loop 内核与 OpenAI-compatible Provider。

## Workspace

### `xharness-core`

- `LoopEngine::start(LoopRequest) -> LoopRun`
- 流式 `text_delta`、`reasoning_delta` 与工具生命周期事件
- tool-call delta 聚合和多轮模型调用
- 请求输出前的安全重试；已经产生 delta 后禁止重试
- `parallel`、`keyed`、`exclusive` 工具调度，默认最多 8 路
- 工具超时、取消、panic、未知工具和参数错误统一写回模型
- 默认完整上下文重放，工具结果写回限制为 256 KiB
- 默认最多 128 个模型步骤
- Session 检查点和中断工具批次防重放

### `xharness-provider-openai`

- Chat Completions 与 Responses API，协议显式选择
- 增量 SSE：任意网络分片、CRLF、多行 data 和 UTF-8 边界
- Responses 使用 `store=false` 并保留 opaque provider items
- API Key 不进入 Session，并在 `Debug` 输出中脱敏

## 最小嵌入

```rust,no_run
use std::sync::Arc;

use futures::StreamExt;
use xharness_core::{AgentMessage, LoopEngine, LoopRequest};
use xharness_provider_openai::{
    OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig,
};

#[tokio::main]
async fn main() {
    let provider = OpenAiProvider::new(OpenAiProviderConfig::new(
        OpenAiProtocol::Responses,
        "https://api.openai.com/v1",
        std::env::var("OPENAI_API_KEY").unwrap(),
        "your-model",
    ))
    .unwrap();

    let request = LoopRequest::new(
        Arc::new(provider),
        vec![AgentMessage::user("分析当前目录")],
    );
    let mut run = LoopEngine.start(request);

    while let Some(event) = run.events().next().await {
        println!("{event:?}");
    }
    println!("{:?}", run.result().await.status);
}
```

## 远程开发

不要在本机编译 Rust。使用：

```bash
scripts/remote-rust-test.sh WZU_Server
```

源码会同步到 `WZU_Server:~/codex-build/x-harness-rs/`，然后远程运行：

```text
cargo fmt --check --all
cargo check --workspace --all-targets
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
```

当前测试覆盖：正文/reasoning、多轮工具、分片 tool calls、坏参数、未知工具、超时、
panic、重试边界、取消、步骤限制、UTF-8 截断、并发上限、keyed/exclusive 屏障、
历史顺序、异常批次恢复、消费者提前退出及两个 OpenAI 协议的原生 HTTP 集成。

## Roadmap

1. CLI 与配置加载
2. PTY/Shell 工具
3. Linux Sandbox 与权限策略
4. Daemon 和 OpenAI-compatible Harness API
5. Web UI
6. Subagent 调度

## License

Apache-2.0
